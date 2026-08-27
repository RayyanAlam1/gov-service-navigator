# Deployment

**Target: £0/month.** Every service below has a genuine free tier with no trial clock and no card
required.

| Layer | Service | Free tier | Why this one |
|---|---|---|---|
| App | **Vercel** (Hobby) | 1M function calls, 100 GB transfer, 300s functions, 2 GB RAM | Native Next.js. No sleep, no cold-start penalty on static assets. |
| Database | **Neon** (Free) | 0.5 GB storage, 100 compute-hours/project/month | The only hard requirement is **pgvector**, and Neon supports it. Scales to zero, never expires. |
| Embeddings | DashScope `text-embedding-v3`, or built-in hash | — | Removes the 120 MB ONNX model from the serverless bundle. |
| LLM | DashScope (Qwen), Groq, or none | — | The app runs correctly with **no credentials at all**. |

> **One thing to check yourself:** Vercel's Hobby plan is for non-commercial use. A hackathon MVP
> qualifies; if this later becomes a paid product, you need Pro. Read
> [their terms](https://vercel.com/docs/limits/fair-use-guidelines) and decide — I'm flagging it, not
> deciding it for you.

---

## The one decision that matters

**Set `EMBEDDING_DIM=1024` before you migrate, even if you have no DashScope key yet.**

The `vector(N)` column width is fixed at migration time. Choosing 1024 now means all three embedding
providers work against the same schema, with no re-migration later:

| Provider | Native dims | At `EMBEDDING_DIM=1024` |
|---|---|---|
| `hash` (no credentials) | any | generated at 1024 |
| `local` (ONNX) | 384 | zero-padded to 1024 |
| `dashscope` | 1024 | exact |

Zero-padding is lossless for cosine similarity — padding both query and document vectors identically
leaves every dot product and norm unchanged. So you can deploy today on `hash`, add a DashScope key
next week, and only need `npm run db:index -- --all`. No schema change, no downtime.

Pick 384 instead and adding DashScope later means dropping and rebuilding the whole database.

---

## 1. Database (Neon)

1. Sign up at [neon.tech](https://neon.tech) — GitHub login works, no card.
2. Create a project. **Region: Singapore (`ap-southeast-1`)** — closest Neon free region to Pakistan,
   and it matches the Vercel region below so app↔database round-trips stay intra-region.
3. Copy the **pooled** connection string. It has `-pooler` in the hostname:

   ```
   postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   Use the pooled one. Serverless functions open a connection per instance, and the direct endpoint
   runs out. The app already caps itself to one connection per instance when it detects Vercel, but
   the pooler is the other half of that fix.

4. Enable pgvector — one query in the Neon SQL Editor:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   (The migrations do this too; running it first surfaces any permission problem immediately.)

### Migrate and seed it from your machine

There is no build-time database step — deliberately, so a broken migration can never take down a
deploy. Run it once, locally, pointed at Neon:

```bash
$env:DATABASE_URL   = "postgresql://...-pooler...?sslmode=require"
$env:DB_DRIVER      = "pg"
$env:EMBEDDING_DIM  = "1024"
$env:EMBEDDING_PROVIDER = "local"    # or dashscope, if you have the key

npm run db:deploy    # migrate + seed
npm run doctor       # confirm
```

`doctor` should report 29 tables, 3 services and all chunks embedded. Seeding sends ~400 KB and
takes under a minute.

---

## 2. App (Vercel)

1. [vercel.com/new](https://vercel.com/new) → import `RayyanAlam1/gov-service-navigator`.
   Sign in with the **same GitHub account** that owns the repo.
2. Framework preset: **Next.js** (auto-detected). Leave build settings alone —
   [`vercel.json`](../vercel.json) sets the region and function duration.
3. Add environment variables (**Production**, and Preview if you want branch deploys):

   ```
   DB_DRIVER               = pg
   DATABASE_URL            = <the pooled Neon string>
   EMBEDDING_DIM           = 1024
   EMBEDDING_PROVIDER      = hash          # or dashscope
   NODE_ENV                = production
   APP_ENV                 = production
   LOG_LEVEL               = info
   MAX_UPLOAD_BYTES        = 4000000
   STRICT_GROUNDING        = true
   ```

   With a DashScope key, add:

   ```
   LLM_PROVIDER            = dashscope
   DASHSCOPE_API_KEY       = sk-...
   EMBEDDING_PROVIDER      = dashscope
   DASHSCOPE_EMBEDDING_MODEL = text-embedding-v3
   ```

   With Groq keys instead (chat only — Groq has no embeddings endpoint, so leave
   `EMBEDDING_PROVIDER=hash`):

   ```
   LLM_PROVIDER            = groq
   GROQ_API_KEYS           = gsk_one,gsk_two
   ```

4. Deploy.

### Why those two values in particular

**`MAX_UPLOAD_BYTES=4000000`** — Vercel caps a function request body at 4.5 MB. The app's own default
is 5 MB, so a large document upload would be rejected by the platform *before* reaching the app's
error handling, producing a confusing 413 instead of a clear message.

**`EMBEDDING_PROVIDER=hash` unless you have DashScope** — the local ONNX model is ~120 MB of native
binaries. Vercel can bundle it (large functions go to 5 GB), but it must load on every cold start,
which is the worst possible place to spend ten seconds. Hash embeddings are instant; hybrid BM25
retrieval carries the quality, and `/api/health` reports the degradation honestly.

---

## 3. Verify it actually works

```bash
npm run smoke -- https://your-app.vercel.app
```

This is not a ping. It exercises the real pipeline:

```
✓ health                 3 services, 20 chunks embedded, llm=mock
✓ intake (Roman Urdu)    cnic · roman_ur · 3 assumption(s) inferred
✓ guardrail (injection)  refused, as required
✓ interview turn         asked "Have you reported the loss to the police…"
```

The guardrail check matters as much as the happy path — a deployment that answers a prompt injection
is worse than one that is down.

---

## Alternative: container hosting

Use this if you want full-quality local ONNX embeddings, or you would rather run the exact Docker
image that's in the repo.

**[Render](https://render.com)** — free web service, Docker-native, `Dockerfile` works unchanged.

- Set **Docker** as the environment, leave the build command empty.
- Add the same environment variables, with `EMBEDDING_PROVIDER=local`.
- Point `DATABASE_URL` at Neon (Render's own free Postgres has **no pgvector** and expires).

**The catch, and it is a real one for a pitch:** the free instance sleeps after 15 minutes idle and
takes ~50 seconds to wake. If a judge opens your link cold, they wait a minute looking at nothing.
Hit the URL a few minutes before you present, or use Vercel.

---

## Cost control

Nothing here can generate a bill, because none of it has a card attached. What it *can* do is stop:

| Limit | What happens | Mitigation |
|---|---|---|
| Neon 0.5 GB storage | Writes fail | The whole seeded database is ~5 MB. Sessions expire after 72h and cascade-delete. |
| Neon 100 compute-hours | Database suspends until next month | It scales to zero when idle, so only real traffic counts. |
| Vercel 1M invocations | Throttled | A demo uses a few hundred. |
| LLM free tier | Falls through the provider chain to deterministic | Facts stay correct; phrasing degrades. Reported by `/api/health`. |

The provider chain is what makes the last row safe: exhausting a quota degrades the app, it doesn't
break it.

---

## Updating

Vercel redeploys on every push to `main`. CI runs the same checks first.

Content changes (a corrected fee, a newly verified source) do **not** need a redeploy — they are
database rows:

```bash
$env:DATABASE_URL = "postgresql://...-pooler...?sslmode=require"
npm run db:seed        # upserts; safe to re-run
```

After changing the embedding model or provider:

```bash
npm run db:index -- --all
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` → `ok: false`, database unreachable | Wrong connection string, or pgvector missing | Check `DATABASE_URL` is the **pooled** one; run `CREATE EXTENSION vector` |
| Health OK but `services: 0` | Migrated but never seeded | `npm run db:seed` against `DATABASE_URL` |
| `Embedding dimension mismatch` | `EMBEDDING_DIM` differs from the migrated width | Set it to the value in the error, or reset and re-seed |
| Retrieval returns nothing | Chunks unembedded, or thresholds wrong for the model | `npm run db:index -- --all`, then `npm run probe` |
| Everything works, answers feel templated | No LLM credentials — expected | Add a key, or accept it: facts are still correct |
| First request very slow, then fast | Neon scaling from zero + serverless cold start | Normal. Warm it before demoing. |

`/api/health?deep=1` is the first thing to check for any of these — it reports the database, schema,
embedding width, provider chain and content counts in one response.

---

**Sources for the free-tier figures above:**
[Vercel function limits](https://vercel.com/docs/functions/limitations) ·
[Neon free tier](https://neon.com/docs/introduction/plans)
