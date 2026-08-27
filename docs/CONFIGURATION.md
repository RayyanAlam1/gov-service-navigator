# Configuration

The system **boots with an empty environment**. Every missing credential degrades one capability and
is reported by `/api/health`; none of them prevents a start.

That is a deliberate design rule. A demo that crashes because someone forgot an environment variable
is a worse failure than one that runs in a documented degraded mode and says so on screen.

```bash
cp .env.example .env.local
```

Configuration is parsed once, validated with zod, and frozen
([`src/lib/config/env.ts`](../src/lib/config/env.ts)). Modules import the typed `config` object
rather than reading `process.env`, so a typo in a variable name is a compile error instead of a
silent `undefined`.

---

## Database

| Variable | Default | Notes |
|---|---|---|
| `DB_DRIVER` | `pg` | `pg` (real PostgreSQL + pgvector) or `pglite` (embedded) |
| `DATABASE_URL` | `postgresql://gsn:gsn_dev_password@localhost:5432/gsn` | |
| `PGLITE_DATA_DIR` | `.pglite` | `memory` for an in-process database that vanishes on exit |
| `DB_POOL_MAX` | `10` | |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | |

### PGlite

PostgreSQL 16 compiled to WASM, running in-process. **Same SQL dialect, same migrations, same
seeds.** It exists because a live demo must not be one Docker daemon away from failing, and because
CI should not need a service container to run integration tests.

```bash
DB_DRIVER=pglite npm run dev
```

`PGLITE_DATA_DIR=memory` is what the test suite uses — no state on disk, nothing left behind
between runs.

**One process at a time.** PGlite locks its data directory, so `npm run doctor` while `npm run dev`
is running will fail. Stop the dev server, or point the command at a throwaway database:

```bash
PGLITE_DATA_DIR=memory npm run doctor
```

If a process is killed abruptly it can leave a stale lock, or — if the kill landed mid-write — a
damaged directory:

```bash
npm run db:unlock              # clear a stale lock
npm run db:unlock -- --reset   # recreate the directory, then migrate + seed
```

Recreating is cheap: the knowledge base is generated from `db/`, so only in-flight demo sessions are
lost. The error message names both commands when this happens.

The only functional difference is that ANN index creation may be unsupported, in which case vector
search falls back to a sequential scan. At demo corpus size that is a few milliseconds, and the
migration runner logs it as a warning rather than failing.

---

## Language model

Providers are tried in order: `LLM_PROVIDER` → `LLM_FALLBACK_PROVIDER` → the deterministic provider.
A provider with no key is skipped; one whose circuit breaker is open is stepped over until it cools.

| Variable | Default |
|---|---|
| `LLM_PROVIDER` | `dashscope` |
| `LLM_FALLBACK_PROVIDER` | `groq` |
| `LLM_TIMEOUT_MS` | `30000` |
| `LLM_MAX_RETRIES` | `2` |
| `LLM_TEMPERATURE` | `0.1` |
| `LLM_MAX_OUTPUT_TOKENS` | `2048` |
| `LLM_CACHE_ENABLED` | `true` |
| `LLM_CACHE_TTL_SECONDS` | `86400` |
| `LLM_BREAKER_THRESHOLD` | `5` |
| `LLM_BREAKER_COOLDOWN_MS` | `30000` |

### Alibaba Cloud Model Studio (DashScope)

```bash
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL_PRIMARY=qwen-plus
DASHSCOPE_MODEL_FAST=qwen-turbo
DASHSCOPE_EMBEDDING_MODEL=text-embedding-v3
```

Keys come from the [Model Studio console](https://bailian.console.alibabacloud.com/). Use the `-intl`
base URL for Singapore, the plain `dashscope.aliyuncs.com` one for Beijing.

### Groq

```bash
GROQ_API_KEY=gsk_...
GROQ_MODEL_PRIMARY=llama-3.3-70b-versatile
GROQ_MODEL_FAST=llama-3.1-8b-instant
```

Groq serves chat only — it has **no embeddings endpoint** — so embeddings always come from the local
model or DashScope.

### Multiple keys

```bash
GROQ_API_KEYS=gsk_one,gsk_two,gsk_three
```

Strongly recommended on free tiers. The pool round-robins, parses `x-ratelimit-*` headers, cools a
key on HTTP 429 until its `retry-after` elapses, and permanently retires one on HTTP 401. One key is
not enough to get through a 51-scenario evaluation run, let alone a live demo where a judge asks
three questions in a row.

`/api/health` reports pool state without ever exposing a key — each is identified by an
irreversible 8-character fingerprint.

### The deterministic provider

`LLM_PROVIDER=mock` (or simply no credentials) runs the system with no model at all.

**Government facts are still correct**, because they never came from a model. What is lost is
fluency and translation: questions and plan text render from stored strings and English fallbacks.
The evaluation suite passes in this mode, which is how the architecture claim is verified rather
than asserted.

---

## Embeddings

| Variable | Default | Notes |
|---|---|---|
| `EMBEDDING_PROVIDER` | `local` | `local`, `dashscope`, or `hash` |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | 384 dimensions |
| `EMBEDDING_DIM` | `384` | **Must match the migrated `vector(N)` width** |
| `EMBEDDING_BATCH_SIZE` | `16` | |
| `TRANSFORMERS_CACHE` | `./data/models` | |

**`local`** runs a multilingual ONNX model in-process. Free, offline after `npm run model:fetch`, and
genuinely multilingual — it places an Urdu sentence near its English translation, which is the whole
point when the corpus is in one language and the citizen writes in another.

**`dashscope`** uses `text-embedding-v3`. Set `EMBEDDING_DIM` to a width the model supports
(1024 / 768 / 512 / 256 / 128 / 64), then rebuild:

```bash
npm run db:migrate -- --reset && npm run db:seed
```

**`hash`** is a dependency-free deterministic fallback: feature-hashed character n-grams, lexical
similarity only. It exists so the system never hard-fails on a missing model download.
`/api/health` reports it as degraded rather than pretending.

`local` degrades to `hash` automatically if the model cannot load, logging the reason once. A demo
that silently returns no evidence is worse than one that returns weaker evidence and says why.

### Dimension mismatch

The migration runner records the width it used in `system_meta`, and `assertEmbeddingDim()` refuses
to serve traffic when the running config disagrees. A silent mismatch presents as "retrieval got
worse", which is the hardest kind of bug to diagnose live.

---

## Retrieval

| Variable | Default | Notes |
|---|---|---|
| `RAG_TOP_K` | `8` | Chunks handed to the composer |
| `RAG_CANDIDATE_K` | `24` | Candidates per retrieval arm |
| `RAG_MIN_SIMILARITY` | `0.75` | Below this a chunk is not shown as evidence |
| `RAG_SUFFICIENCY_SIMILARITY` | `0.84` | Below this we do **not** claim a topic is documented |
| `RAG_RRF_K` | `60` | Reciprocal-rank-fusion smoothing |
| `RAG_MAX_QUERY_EXPANSIONS` | `3` | |
| `RAG_MAX_RETRIEVAL_LOOPS` | `2` | Agentic re-query budget per turn |

The two thresholds answer different questions, and the second is deliberately stricter. Including a
loosely related chunk as context is cheap; asserting "we have official guidance on this fee" when we
do not is what puts a wrong number in front of a citizen.

**Both are model-specific.** Re-derive them with `npm run probe` after any model change — e5-family
models compress cosine similarity into a narrow high band, so a threshold copied from a different
model filters nothing at all.

---

## Grounding and safety

| Variable | Default | Notes |
|---|---|---|
| `SOURCE_STALE_AFTER_DAYS` | `180` | Older than this, claims are demoted to "needs re-checking" |
| `SERVICE_CONFIDENCE_THRESHOLD` | `0.62` | Below this the citizen is asked which service they meant |
| `STRICT_GROUNDING` | `true` | Replace any ungroundable rendered text with its deterministic source |

Turning `STRICT_GROUNDING` off keeps the verifier running and still records every violation to
`guardrail_events` — it just stops rewriting the output. Useful for diagnosing prompt regressions.
**Never turn it off in front of a citizen.**

---

## Sessions and limits

| Variable | Default | Notes |
|---|---|---|
| `SESSION_TTL_HOURS` | `72` | Expired sessions and everything under them are deleted |
| `SESSION_ID_BYTES` | `32` | 256 bits of entropy in the public token |
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Per coarse client fingerprint |
| `MAX_INPUT_CHARS` | `1200` | |
| `MAX_UPLOAD_BYTES` | `5242880` | |

Rate limiting is database-backed so it survives a restart, and keyed on a hashed IP + user-agent
fingerprint — a bucket, never an identity. If the limiter cannot reach the database it **fails open**
and logs, because a limiter should not be able to take the service down.

---

## Documents

| Variable | Default | Notes |
|---|---|---|
| `OCR_PROVIDER` | `mock` | The only supported value |
| `DOCUMENT_RETENTION_ENABLED` | `false` | Do not enable without a lawful basis and a retention policy |

Uploaded bytes are processed in memory and discarded before the request returns. The
`document_checks` table has no column capable of holding an image, a file path, or raw OCR text.

---

## Degraded modes, and what each costs

| Condition | Effect | Reported by |
|---|---|---|
| No LLM credentials | Templated phrasing, English fallbacks. **Facts unaffected.** | `/api/health`, trace panel |
| Embedding model unavailable | Lexical-only retrieval, reduced semantic recall | `/api/health` |
| No ANN index | Sequential vector scan, slower at scale | `npm run doctor` |
| Provider circuit breaker open | Requests move down the chain | `/api/health` |
| All keys rate-limited | Requests move down the chain, then deterministic | `/api/health` |
| Database unreachable | Hard failure — nothing works without it, by design | `/api/health` returns `ok: false` |

The database is the only hard dependency. That is the correct place to be brittle: it is where every
fact lives, and serving a plan without it would mean serving one from a model.

---

## Diagnostics

```bash
npm run doctor                       # providers, schema, content, provenance
curl localhost:3000/api/health?deep=1 | jq
npm run probe                        # JSONB round-trip + similarity calibration
```

`doctor` exits non-zero only for conditions that make the system **wrong**, not merely degraded.
Running on the deterministic provider is a supported mode and exits `0` with a warning.
