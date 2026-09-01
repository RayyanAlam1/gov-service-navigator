# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Government Service AI Navigator.
#
# Three properties this image is built for:
#
#   1. It ships with its content. The knowledge base, the retrieval corpus and
#      the embedding model are all baked in, so a container that starts on a
#      conference wifi with no internet still serves a complete, correct demo.
#      A build that downloads a model on first request is a demo that fails in
#      the one room where it matters.
#
#   2. It boots without credentials. No LLM key is required; the app runs on the
#      deterministic provider and /api/health says so. Missing configuration
#      degrades a capability, it never prevents a start.
#
#   3. It runs as a non-root user on a distroless-ish base, with a healthcheck
#      that actually exercises the database rather than just the HTTP port.

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Native modules (onnxruntime-node, sharp) need a toolchain at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# npm 11 gates install scripts; the allowScripts block in package.json is what
# permits the native builds these packages legitimately need.
RUN npm ci --no-audit --no-fund


# ── Stage 1b: production dependencies ───────────────────────────────────────
# Next's standalone output ships only what its tracer found reachable from the
# app, and it bundles some packages into the compiled chunks rather than leaving
# them in node_modules — zod, zod-to-json-schema and pino all disappear that
# way. The app is fine; the entrypoint is not, because it runs migrate and seed
# as TypeScript and needs the real packages on disk.
#
# Pruning to production deps gives those back with correct transitive trees,
# and it is small here: eight direct dependencies. It is copied *over* the
# standalone output rather than instead of it, because COPY merges into an
# existing directory — so everything Next traced is kept.
FROM deps AS prod-deps
RUN npm prune --omit=dev


# ── Stage 2: embedding model ────────────────────────────────────────────────
# Fetched in its own layer so it is cached independently of application code.
FROM deps AS model

WORKDIR /app
COPY tsconfig.json ./
COPY scripts/fetch-model.ts ./scripts/
COPY scripts/_env.ts scripts/_env-loader.ts ./scripts/
COPY src/lib/config ./src/lib/config
COPY src/lib/obs ./src/lib/obs
COPY src/lib/i18n ./src/lib/i18n
COPY src/lib/embeddings ./src/lib/embeddings

ENV TRANSFORMERS_CACHE=/app/data/models
RUN npx tsx scripts/fetch-model.ts || \
    echo "model fetch failed; the image will fall back to hash embeddings and report it as degraded"


# ── Stage 3: build ──────────────────────────────────────────────────────────
FROM deps AS build

WORKDIR /app
COPY . .
COPY --from=model /app/data/models ./data/models

ENV NEXT_TELEMETRY_DISABLED=1
# The build must not need a database: every route that touches one is dynamic.
RUN npm run build


# ── Stage 4: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 gsn \
 && useradd --system --uid 1001 --gid gsn --home /app gsn

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TRANSFORMERS_CACHE=/app/data/models

# Next's standalone output carries only the modules the server actually uses.
COPY --from=build --chown=gsn:gsn /app/.next/standalone ./
COPY --from=build --chown=gsn:gsn /app/.next/static ./.next/static
COPY --from=prod-deps --chown=gsn:gsn /app/node_modules ./node_modules
COPY --from=build --chown=gsn:gsn /app/public ./public

# Content and tooling needed at runtime: migrations, seeds, the corpus, the
# model, and the CLI scripts that the entrypoint runs.
COPY --from=build --chown=gsn:gsn /app/db ./db
COPY --from=build --chown=gsn:gsn /app/eval ./eval
COPY --from=build --chown=gsn:gsn /app/scripts ./scripts
COPY --from=build --chown=gsn:gsn /app/data ./data
COPY --from=build --chown=gsn:gsn /app/tsconfig.json ./tsconfig.json
# The entrypoint runs migrate/seed as TypeScript, and those scripts import
# through the `@/*` alias, which tsconfig maps to ./src/*. Without the sources
# tsx resolves the alias to nothing and every migration fails with
# "Cannot find module '@/lib/config/env'".
COPY --from=build --chown=gsn:gsn /app/src ./src
# The entrypoint runs migrations and seeding from TypeScript, so tsx has to
# exist in the runtime image. Two things make that less obvious than it looks.
#
# `node_modules/.bin/tsx` is a symlink into `tsx/dist`. COPY dereferences it,
# writing a real file whose own relative imports then resolve against `.bin/`
# instead of `tsx/dist/` — the container started, failed every migration with
# ERR_MODULE_NOT_FOUND, and reported itself unhealthy. The entrypoint therefore
# calls `tsx/dist/cli.mjs` directly and the shim is not copied at all.
#
# tsx also depends on esbuild, which ships a native binary in a per-platform
# package. Copying tsx alone gets you a second failure one step further on.
COPY --from=build --chown=gsn:gsn /app/node_modules/tsx ./node_modules/tsx
COPY --from=build --chown=gsn:gsn /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=build --chown=gsn:gsn /app/node_modules/@esbuild ./node_modules/@esbuild

COPY --chown=gsn:gsn docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER gsn
EXPOSE 3000

# Exercises the database and the schema, not just the port. A container that
# answers HTTP while its knowledge base is empty is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health?deep=1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
