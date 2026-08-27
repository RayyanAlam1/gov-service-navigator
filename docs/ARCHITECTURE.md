# Architecture

## The problem this shape solves

A citizen asks *"mera CNIC gum hogya hai, ab kya karna hai?"* A general-purpose model will answer
fluently and confidently, and roughly the right shape of answer will come out. The fee will be
plausible. The document list will be mostly right. The office will sound real.

That is the failure. "Mostly right" sends someone to a counter without the paper they needed, and
they cannot tell which part was wrong until they get there.

So the architecture is built around a single constraint, and everything else follows from it:

> **The language model never supplies a government fact.**

---

## Three layers

### 1. Deterministic layer — PostgreSQL

Anything crisp and enumerable is a row: services, scenarios, eligibility rules, required documents,
procedure steps, offices, fees, exception routes.

Conditions are stored as JSON expression trees and evaluated by code
([`src/lib/schemas/conditions.ts`](../src/lib/schemas/conditions.ts)). Rules in a database can be
tested, versioned and diffed when the government changes them. Rules in prose cannot.

Evaluation is **three-valued** — `true`, `false`, `unknown`. `unknown` is not a failure state; it is
the engine saying *"I have not been told yet."* That single design choice is what makes the adaptive
interview possible and what stops the system from guessing.

```
AND: a definite false wins over any number of unknowns
OR:  a definite true  wins over any number of unknowns
NOT: unknown stays unknown
```

Failing closed is deliberate: a condition that cannot be parsed becomes `never`, not `always`. A
rule we cannot read must drop out, not silently apply to every citizen.

### 2. Grounded retrieval — pgvector

Official prose that resists tabulation: notification text, clarifications, unusual-case guidance.

Two independent retrieval arms, fused with **reciprocal rank fusion**:

| Arm | Catches | Fails at |
|---|---|---|
| Lexical (Postgres FTS, `simple` config) | Exact terms — "B-Form", "NICOP", form numbers | Cross-language matching |
| Vector (pgvector cosine) | Paraphrase, and Roman-Urdu → English documents | Rare proper nouns at 384 dims |

RRF rather than score blending, because `ts_rank` is unbounded and cosine is `[-1,1]` — rank fusion
needs no calibration to stay stable, which matters because the embedding provider can degrade to
lexical hashing at runtime.

The `simple` text-search configuration is chosen deliberately: Postgres has no Urdu stemmer, and
`simple` (fold and tokenise, no stemming) behaves correctly across all three languages instead of
mangling two of them. Stopword removal therefore happens in application code, in all three
languages — without it, *"how do I bake sourdough bread at home"* matches a dozen chunks on "how",
"do" and "at".

**Two thresholds, for two different questions:**

- `RAG_MIN_SIMILARITY` (0.75) — is this chunk worth showing as evidence?
- `RAG_SUFFICIENCY_SIMILARITY` (0.84) — do we have enough to *claim this topic is documented*?

The second is strictly higher and is the important one. Including a loosely related chunk as context
is cheap; asserting "yes, we have official guidance on the fee" when we do not is what puts a wrong
number in front of a citizen.

Both are **model-specific**. e5-family models compress cosine similarity into a narrow high band, so
a threshold copied from another model filters nothing. `npm run probe` re-derives them empirically —
the current values came from measuring on-topic (0.858–0.914) against off-topic (0.775–0.830) queries
on the seeded corpus.

### 3. Language layer — LLM

Four jobs: detect intent, translate, route context, render already-decided content.

It is never asked *"what documents does a lost CNIC need?"* It is handed the list and asked to
express it in Urdu.

The guardrail is a type signature:

```ts
generateStructured(request, fallback)   // fallback is REQUIRED
```

You cannot call the model without also having written the deterministic path that runs when it is
unavailable. There is no free-text completion helper, because an unvalidated string would eventually
reach a citizen as if it had been checked.

---

## The agent pipeline

Control flow is a **deterministic state machine**
([`src/lib/engine/orchestrator.ts`](../src/lib/engine/orchestrator.ts)), not an agent choosing its
own plan. Agents are called *at* nodes; the graph between nodes is code.

That is a deliberate rejection of "give the model tools and let it plan". The sequence a citizen
goes through is fixed and auditable, and letting a model choose it would make the same question
produce different journeys on different runs — which you cannot have when the output is a legal
procedure.

| Agent | Deterministic? | Decides |
|---|---|---|
| Input guardrail | ✅ | Whether to proceed at all |
| Language detection | ✅ | Which language, and whether to switch |
| Intent extraction | ❌ AI | *Proposes* a service; discarded if it doesn't exist |
| Service resolver | ✅ | **Which service** |
| Interview planner | ✅ | **Which question, or none** |
| Question phrasing | ❌ AI | Only the wording |
| Retrieval | mixed | Query planning is AI; coverage assessment is not |
| Rules engine | ✅ | **Eligibility, documents, fees, exceptions** |
| Plan composer | ❌ AI | Only translation of supplied strings |
| Output verifier | ✅ | Whether rendered text may be shown |
| Readiness | ✅ | **Ready or not** |

Every bold decision is deterministic. Every step is recorded in `agent_traces` with a
`deterministic` flag, which is what makes the "show me where AI is used" demo a query rather than a
claim.

---

## The adaptive interview

The product claim is *"it asks only the questions that matter."* This is where that is either true
or marketing.

It is implemented as actual information gain over the rule set
([`src/lib/engine/interview.ts`](../src/lib/engine/interview.ts)):

> For each unanswered variable the rules reference, try every value it could take. Compute the full
> decision outcome for each. **If every possible answer produces the same outcome fingerprint, the
> question cannot change what the citizen is told — so it is not asked**, no matter how sensible it
> sounds.

Three things fall out of this:

1. **Genuinely short interviews.** A citizen who said "lost" is never asked whether it's a renewal.
   Measured average across the evaluation suite: **4.5 questions**.
2. **A real answer to "why are you asking me this?"** The planner knows exactly which outcomes the
   question splits, and the UI shows it — computed from rule impacts, not generated prose.
3. **A safety property.** The interview stops when, and only when, no remaining question could
   change the plan. Stopping early means guessing; stopping late wastes the citizen's time.

Ordering among useful candidates: blocking rules first, then information gain, then curated
`ask_priority`, then variable code for a stable tie-break.

Advisory rules count too. An early version only tracked *blocking* rules as open, so `is_overseas`
was never asked and an applicant abroad was quietly told the domestic procedure applied — a wrong
answer produced by never asking rather than by reasoning badly. The evaluation suite caught it.

---

## Guardrails

### Input — [`src/lib/guardrails/input.ts`](../src/lib/guardrails/input.ts)

Four checks, cheapest first: shape → PII → injection → scope. All deterministic. Asking a model to
classify text that is itself trying to manipulate the model is a circular defence.

PII masking runs **before** the injection and scope checks, so even a blocked message never carries a
real CNIC into a log line. Masks preserve shape (`#####-#######-#`) so the citizen can still see we
understood them.

### Output — [`src/lib/guardrails/output.ts`](../src/lib/guardrails/output.ts)

Every rendered string is scanned for claim categories that hurt a citizen if wrong:

| Category | Why it matters |
|---|---|
| Currency | A wrong fee sends someone to a counter with too little money |
| Duration | A wrong number sets a false deadline expectation |
| **Count** | *"You need 4 documents"* for a six-item checklist — a single digit, and the large-number rule misses it entirely |
| URL | An invented `gov.pk` URL is indistinguishable from a real one |
| Promise | *"I have submitted your application"* is never true here |

Anything not traceable to the supplied fact set is a violation. Under `STRICT_GROUNDING` the field is
replaced with its deterministic rendering — **per field**, so one invented fee in a summary paragraph
does not discard a correctly translated checklist.

Deliberately **not** an LLM-as-judge. Checking a model's arithmetic with the same model, on a fee a
citizen will act on, is not a control.

Translation gets an extra check: digit signatures before and after must match. The most likely way a
translation goes wrong is `PKR 750` becoming `PKR 7500`, and both values could pass a naive
membership test.

---

## Reliability

| Concern | Mechanism |
|---|---|
| Free-tier rate limits | Key pool with round-robin, `x-ratelimit-*` parsing, per-key cooldown on 429, permanent retirement on 401 |
| Provider outage | Chain: primary → fallback → deterministic. Circuit breaker per provider |
| Malformed model output | zod validation, one repair round-trip, then deterministic fallback |
| Slow demo / quota burn | Response cache keyed on `sha256(provider|model|messages|schema|temperature)` |
| No Docker at the venue | `DB_DRIVER=pglite` — embedded PostgreSQL 16, same SQL, same migrations |
| No network at the venue | Embedding model baked into the image; deterministic LLM provider always available |
| Embedding model fails to load | Automatic degradation to hash embeddings, logged once, reported by `/api/health` |

---

## Data model

29 tables. The load-bearing design decisions:

**`verification_status` on every citizen-facing table.** Not a flag — it changes rendering,
eligibility queries and caveat generation. See [DATA_PROVENANCE.md](DATA_PROVENANCE.md).

**Nullable `amount_minor` and `min_days`/`max_days`.** A `NULL` fee renders as "not verified", which
is safe and true. An invented number is neither.

**`applies_when` conditions on requirements, steps and fees.** One row serves several scenarios
without duplication, and this is what makes the checklist personalised rather than generic.

**`substitutes` on requirements.** Several Pakistani services accept an alternative document — an
affidavit for a missing record, a guardian's CNIC for a parent's. A citizen holding the substitute is
ready, and a checklist saying otherwise sends them to fetch something they don't need.

**`document_checks` has no column for image bytes, file paths or raw OCR text.** Uploads are
processed in memory and discarded; only the structured verdict is stored, with identifier-like fields
masked at extraction time.

**Sessions are keyed by an unguessable `public_token`.** The `BIGSERIAL` id never leaves the server,
so sessions cannot be enumerated. `language` is a *display* property — `setLanguage` touches exactly
one column, because a citizen switching to Urdu mid-interview must keep every answer.

---

## Decisions worth defending

**No ORM.** Every statement is SQL you can read, paste into `psql`, and explain. For a product whose
value is "you can check where this fact came from", an opaque query builder works against the
product.

**Deterministic orchestration over agentic planning.** Reproducibility is a feature when the output
is a legal procedure.

**`unknown` as a first-class value.** Most of the safety properties in this system are downstream of
distinguishing "no" from "not yet asked".

**The fallback is a feature, not an error path.** "We could not verify this — here is the office that
can" earns more trust than being confidently wrong once. It is a designed output with its own copy,
its own UI treatment and its own tests.

**The interview stops itself.** Not a fixed list, not a question budget — a computed property of the
rule set.
