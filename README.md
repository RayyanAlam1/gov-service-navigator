# Government Service AI Navigator

[![CI](https://github.com/RayyanAlam1/gov-service-navigator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RayyanAlam1/gov-service-navigator/actions/workflows/ci.yml)
[![Deployment verified](https://github.com/RayyanAlam1/gov-service-navigator/actions/workflows/verify-deployment.yml/badge.svg)](https://github.com/RayyanAlam1/gov-service-navigator/actions/workflows/verify-deployment.yml)
[![Live demo](https://img.shields.io/badge/live-gov--service--navigator.vercel.app-046C4E)](https://gov-service-navigator.vercel.app)
[![License: MIT](https://img.shields.io/badge/license-MIT-1D5B9A)](LICENSE)

[![Unsupported claims](https://img.shields.io/badge/unsupported_claims-0-046C4E)](docs/EVALUATION.md)
[![Evaluation scenarios](https://img.shields.io/badge/eval_scenarios-51-046C4E)](docs/EVALUATION.md)
[![Document F1](https://img.shields.io/badge/document_F1-100%25-046C4E)](docs/EVALUATION.md)
[![Tests](https://img.shields.io/badge/tests-110_passing-1D5B9A)](tests)
[![Coverage](https://img.shields.io/badge/coverage-70.7%25_core_logic-1D5B9A)](vitest.config.ts)
![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)

**We turn complex Pakistani government procedures into personalised, verified action plans.**

Citizens lose days to a solvable information problem. The rules for getting a CNIC, a passport or a
domicile certificate are real and knowable, but they are scattered across PDFs, notice boards and
word of mouth, and they change. The failure mode is not "I can't find an answer" — it's *"I found a
confident answer that was wrong, and I discovered that after standing in a queue for three hours."*

This is an information-to-action decision engine, not a chatbot. It turns a messy human situation —
`mera CNIC gum hogya hai, Karachi mein hun` — into a specific plan: which service, which branch,
which documents *you specifically* still need, which office, what happens next.

---

## The one rule

> **The language model never supplies a government fact.**

Not a fee, not a deadline, not a document name, not an office address, not an eligibility threshold.
Every such fact traces back to a row in the database or a retrieved chunk of an official document,
and carries its source to the screen.

The test for whether the architecture holds: **if the LLM provider went down and you swapped in a
template renderer, would the answers still be factually correct?** They would. You would lose
fluency and translation, not truth. That is not an aspiration — `LLM_PROVIDER=mock` runs the whole
system that way, and the [evaluation suite](docs/EVALUATION.md) passes in that mode.

---

## Quick start

Nothing here needs a cloud account, an API key, or even Docker.

```bash
npm install
npm run setup     # fetch the embedding model, migrate, seed, and self-check
npm run dev
```

Open <http://localhost:3000>. `setup` uses an embedded PostgreSQL (PGlite) written to `.pglite/`,
so there is no database to install.

**With Docker** (real PostgreSQL + pgvector, everything baked into the image):

```bash
docker compose up --build
```

**Deploy it free** — Vercel + Neon, no card required. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**Check everything is healthy** before a demo:

```bash
npm run doctor
```

---

## What it does

| Capability | Where it lives |
|---|---|
| Understands English, Urdu and Roman Urdu | [`src/lib/i18n/detect.ts`](src/lib/i18n/detect.ts) — deterministic, no model call |
| Asks only questions that can change the outcome | [`src/lib/engine/interview.ts`](src/lib/engine/interview.ts) — real information gain over the rule set |
| Decides eligibility, documents and readiness | [`src/lib/engine/rules.ts`](src/lib/engine/rules.ts) — three-valued logic, zero model involvement |
| Grounds procedural claims in official sources | [`src/lib/rag/`](src/lib/rag/) — hybrid lexical + vector retrieval with RRF |
| Refuses to state anything it cannot trace | [`src/lib/guardrails/output.ts`](src/lib/guardrails/output.ts) — claim verifier |
| Handles lost records, address mismatches, missing parental documents | `exception_routes` rows, modelled explicitly |
| Checks uploaded documents without keeping them | [`src/lib/documents/ocr.ts`](src/lib/documents/ocr.ts) — in-memory, verdict-only storage |
| Shows exactly where AI was used | [`/api/trace`](src/app/api/trace/route.ts) and the "How this answer was produced" panel |

---

## Architecture in one screen

Three layers, strict division of labour. Most bugs in systems like this come from one layer doing
another layer's job.

```
   citizen's words
         │
         ▼
┌────────────────────┐   deterministic · no model
│  input guardrail   │   length, PII masking, injection, scope
└────────┬───────────┘
         ▼
┌────────────────────┐   deterministic · no model
│ language detection │   Unicode script + Roman-Urdu function-word lexicon
└────────┬───────────┘
         ▼
┌────────────────────┐   AI  ·  proposes only
│ intent extraction  │   constrained to services that exist; output discarded if not
└────────┬───────────┘
         ▼
┌────────────────────┐   deterministic · DECIDES
│  service resolver  │   alias scoring + negation handling + confidence margin
└────────┬───────────┘
         ▼
┌────────────────────┐   deterministic selection · AI phrasing only
│ adaptive interview │   asks a question only if some answer changes the outcome
└────────┬───────────┘
         ▼
┌────────────────────┐   agentic loop · deterministic sufficiency check
│  official retrieval│   multi-query expansion → hybrid search → coverage → re-query
└────────┬───────────┘
         ▼
┌────────────────────┐   deterministic · DECIDES
│   rules engine     │   scenario, eligibility, documents, fees, exceptions
└────────┬───────────┘
         ▼
┌────────────────────┐   AI  ·  renders supplied facts, adds nothing
│  plan composer     │   stored translation first, model only for gaps
└────────┬───────────┘
         ▼
┌────────────────────┐   deterministic · no model
│  output verifier   │   every number, duration, count and URL must trace to a fact
└────────┬───────────┘
         ▼
   personalised, sourced action plan
```

Control flow is a state machine in [`src/lib/engine/orchestrator.ts`](src/lib/engine/orchestrator.ts),
not an agent choosing its own plan. The sequence a citizen goes through is fixed, knowable and
auditable — which is what you need when the output is a legal procedure.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Evaluation

51 scripted citizen paths across three services and three languages, weighted toward the cases that
break naive systems.

```bash
npm run eval              # console report
npm run eval -- --html    # also writes eval/report/index.html
```

| Metric | Target | Current |
|---|---|---|
| Service identification | ≥ 90% | **100%** |
| Scenario identification | ≥ 90% | **100%** |
| Required-document F1 | ≥ 90% | **100%** |
| Readiness classification | ≥ 90% | **100%** |
| Guardrail handling | ≥ 90% | **100%** |
| Source grounding | **100%** | **100%** |
| Unsupported claims | **0** | **0** |
| Average questions asked | as few as possible | **4.5** |

The last two targets are absolute, and `npm run eval` exits non-zero if either is missed. A 99%
grounding rate means one citizen in a hundred is sent to the wrong office with confidence.

Document accuracy is measured as **F1**, not recall, because over-listing is a real failure too: a
checklist with documents you don't need sends you away to collect them.

Details: [`docs/EVALUATION.md`](docs/EVALUATION.md).

---

## Data provenance — read this before trusting a number

The knowledge base ships **structurally complete and factually unverified**, on purpose.

- Every fee is `NULL` and renders as *"not verified — confirm at the counter."*
- Every processing time is `NULL`.
- Document lists and procedure shapes are marked `unverified` and attributed to real official pages.
- Office rows are marked `synthetic` and carry **no street address**, linking to the department's
  own locator instead.

A plausible-looking invented fee is worse than a blank one: it looks authoritative, it survives
review, and nobody remembers it was invented. Making it real is a documented workflow, not a rewrite:

```bash
npm run ingest -- --url https://www.nadra.gov.pk/identity/ --source nadra-cnic-overview --service cnic
```

See [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md).

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run setup` | Model + migrate + seed + doctor, in one step |
| `npm run doctor` | Pre-flight diagnostics — run this before a demo |
| `npm run db:migrate` | Apply migrations (`-- --reset` to rebuild) |
| `npm run db:seed` | Upsert the knowledge base (`-- --fresh` to clear first) |
| `npm run db:index` | Re-embed the corpus (`-- --all` after a model change) |
| `npm run ingest` | Ingest an official page or file into the corpus |
| `npm run eval` | Run the evaluation suite |
| `npm run probe` | Re-derive retrieval thresholds for the current model |
| `npm run test` | Unit + integration tests (104) |
| `npm run verify` | Typecheck + tests + evaluation |
| `npm run db:deploy` | Migrate + seed a remote database |
| `npm run smoke -- <url>` | Verify a live deployment end to end |
| `npm run db:unlock` | Clear a stale embedded-database lock |

---

## Configuration

The system **boots with an empty environment**. Missing credentials degrade a capability and are
reported by `/api/health`; they never prevent a start. A demo that crashes on a missing env var is a
worse failure than one that runs in a documented degraded mode and says so on screen.

```bash
cp .env.example .env.local
```

| Setting | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `dashscope` | Alibaba Cloud Model Studio (Qwen) |
| `LLM_FALLBACK_PROVIDER` | `groq` | Used when the primary has no key or its breaker is open |
| `DASHSCOPE_API_KEYS` / `GROQ_API_KEYS` | — | Comma-separated. Pooled with rate-limit-aware failover |
| `EMBEDDING_PROVIDER` | `local` | In-process multilingual ONNX model; `dashscope` or `hash` also supported |
| `DB_DRIVER` | `pg` | `pglite` for zero-infrastructure embedded PostgreSQL |
| `STRICT_GROUNDING` | `true` | Replace any ungroundable rendered text with its deterministic source |

Providers are tried in order and the deterministic provider is always last, which is what makes the
"works with no network" guarantee real rather than aspirational.

Full reference: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

---

## Stack

Next.js 15 (App Router) · TypeScript strict · Tailwind · PostgreSQL 16 + pgvector · zod at every
boundary · Vitest · Docker.

No ORM. Every statement is SQL you can read, paste into `psql`, and explain — which matters for a
product whose whole value is *"you can check where this fact came from."*

---

## What is deliberately not here

- **No open-ended chat.** The intake box routes into a grounded interview. An unbounded text box
  invites questions the pipeline cannot ground, and every one of those is a chance to break the one
  rule.
- **No claim to submit applications.** Where an official online route exists, the citizen is sent to
  it. Any phrasing implying otherwise is a hard violation in the output verifier.
- **No real OCR.** The document checker is an interface with a mock implementation reading synthetic
  documents. Shipping a plausible-looking OCR that is actually guessing would be worse than none:
  the citizen would trust it and stop checking.
- **No authentication, admin dashboards, or payments.** Out of scope, on purpose.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The three layers, the agent pipeline, guardrails, key decisions |
| [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md) | Verification tiers and how to promote data to verified |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | Scenario design, metrics, how to add cases |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Free-tier deployment: Vercel + Neon, step by step |
| [`docs/DEMO.md`](docs/DEMO.md) | The four-minute demo script |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Every environment variable and degraded mode |

---

## Licence

MIT. **This is not a government website.** It helps citizens understand official procedures and
always links to the official source. Confirm details with the issuing department before acting.
