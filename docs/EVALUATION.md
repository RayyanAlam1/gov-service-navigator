# Evaluation

```bash
npm run eval                    # console report
npm run eval -- --html --json   # also writes eval/report/
npm run eval -- --id cnic-lost-roman-urdu
npm run eval -- --cold          # bypass the LLM cache, measure live latency
```

Exits non-zero if any target is missed. CI runs it on every push.

---

## Targets

| Metric | Target | Kind |
|---|---|---|
| Service identification | ≥ 90% | ratio |
| Scenario identification | ≥ 90% | ratio |
| Required-document F1 | ≥ 90% | ratio |
| Readiness classification | ≥ 90% | ratio |
| Guardrail handling | ≥ 90% | ratio |
| **Source grounding** | **100%** | **absolute** |
| **Unsupported claims** | **0** | **absolute** |

The last two are absolute because averages hide the cases that matter. A 99% grounding rate means
one citizen in a hundred is sent to the wrong office with confidence — and that citizen has no way
of knowing they were the one.

### Why document accuracy is F1, not recall

Recall alone rewards listing everything. But over-listing is a real failure: a checklist containing
documents you don't need sends you away to collect them, which is exactly the experience this product
replaces.

So scenarios declare both `requiredDocuments` (must appear) and `forbiddenDocuments` (must not), and
the metric counts both misses and spurious additions.

---

## The scenario set

51 scripted citizen paths in [`eval/scenarios.ts`](../eval/scenarios.ts).

| Group | Count | Covers |
|---|---|---|
| CNIC | 17 | lost, damaged, renewal, modification, first-time, underage, orphaned applicant, overseas, urgency |
| Passport | 8 | new, renewal, lost, minor, no CNIC, overseas, online route |
| Domicile | 9 | residence / father / marriage basis, recent move, duplicate, existing domicile elsewhere |
| Language | 4 | code-mixing, Urdu with Latin acronyms, non-standard Roman spelling, terse queries |
| Guardrails | 8 | injection, fabrication requests, out-of-scope, PII, ambiguity |
| Efficiency & readiness | 5 | question count, redundant-branch avoidance, undetermined vs not-ready |

Three deliberate properties:

**Not prose comparison.** Every expectation is a structural fact — which service, which branch, which
documents, which verdict. Comparing generated prose measures fluency, and fluency is the one thing
that does not matter here.

**Not curated to pass.** Eight scenarios expect a *refusal*, one expects a *disambiguation prompt*,
and several expect `undetermined`. Producing those correctly is as much a success as producing a
plan. A suite where every case expects a happy answer cannot detect a system that never says no.

**Scripted answers, measured question count.** `answers` is what the citizen would say; the harness
supplies each value as it is asked, and records how many questions were needed. The product claims a
short interview, so interview length is a measured metric with per-scenario ceilings.

---

## What the harness actually runs

The real pipeline — the same `runIntake` / `advanceSession` the web app calls — against a real
database seeded from `db/seed/`. Nothing is mocked. A harness that tests a mock measures the mock.

```
createSession → runIntake → applyInferredAnswers
              → advanceSession (loop, answering from the script)
              → assert on plan / readiness / grounding
```

Runs under `LLM_PROVIDER=mock`, so every measured property is a property of the **deterministic
layer**. That is the point: these are the guarantees that must hold whether or not a model is
reachable. Set a real provider to additionally measure phrasing and translation quality.

Results are written to `eval_runs` / `eval_results` and surfaced live on `/architecture`.

---

## Current results

```
Service identification        100.0%   target 90.0%
Scenario identification       100.0%   target 90.0%
Required-document F1          100.0%   target 90.0%
Readiness classification      100.0%   target 90.0%
Guardrail handling            100.0%   target 90.0%
Source grounding              100.0%   target 100.0%  (absolute)
Unsupported claims                 0   target 0       (absolute)

51/51 passed  ·  avg 4.5 questions  ·  avg 120ms
```

---

## Defects this suite has caught

Worth recording, because it is the argument for having it:

**Advisory rules were unreachable.** Only *blocking* rules contributed to the set of open interview
variables, so `is_overseas` was never asked and an applicant abroad was quietly told the domestic
procedure applied. A wrong answer produced by never asking rather than by reasoning badly — invisible
to unit tests, which tested the rules engine with the variable already set.

**Urdu-script speakers got longer interviews.** Scenario keywords existed only in Latin script, so
"گم" (lost) was not inferred while "gum" was. Same question, worse experience, purely because of
script.

**Negated service mentions counted as positive.** "I need a passport but I don't have a CNIC yet"
scored both services equally and triggered a disambiguation prompt whose answer was in the first
clause of the sentence.

**A scalar JSONB decoding bug.** Session answers stored as JSON strings read back as `null`,
silently making every rule referencing them evaluate to false. Caught by the integration suite; the
eval suite would have caught it too.

---

## Adding a scenario

```ts
{
  id: 'cnic-lost-no-fir',
  description: 'Lost CNIC with no police report — must block and route to the exception',
  query: 'my CNIC was stolen last week, what do I do',
  language: 'en',
  answers: { has_fir: false, applicant_age: 33, address_matches_cnic: true, urgency: 'normal', is_overseas: false },
  expect: {
    outcome: 'plan',
    serviceCode: 'cnic',
    scenarioCode: 'lost',
    eligibility: 'ineligible',
    blockingRules: ['lost_requires_report'],
    exceptions: ['lost_without_report'],
    readiness: 'not_ready',
  },
}
```

Guidance:

- **Script every answer the interview will ask for.** An unscripted question is skipped (recorded as
  `null`), which is realistic but usually not what you meant to test.
- **Assert `forbiddenDocuments` too.** Half of document accuracy is about what should *not* appear.
- **Prefer a failing outcome.** Scenarios that expect a refusal or an `undetermined` verdict are the
  ones that catch a system drifting toward confident guessing.
- **Set `maxQuestions`** when the case is about interview efficiency.

---

## Interpreting a failure

| Failure | Usually means |
|---|---|
| `scenario: expected X, got null` | No scenario selector matched — the branch variable was never answered or inferred |
| `document:X: expected present` | The requirement's `applies_when` didn't evaluate true — check the condition against the scripted answers |
| `document:!X: expected absent` | Over-listing. A condition is too broad, or scenario scoping is missing |
| `eligibility: expected conditional, got eligible` | An advisory rule didn't fire — often because its variable was never asked |
| `grounding: expected every element sourced` | A row lost its `source_id`. This must never ship |
| `unsupportedClaims: expected 0` | Rendered text contains a number, duration, count or URL not in the plan's fact inventory |

When a check fails, **fix the pipeline, not the test** — unless the expectation was genuinely wrong,
in which case say so in the commit message.

---

## Retrieval calibration

Similarity thresholds are model-specific. After changing `EMBEDDING_MODEL`:

```bash
npm run db:index -- --all   # re-embed with the new model
npm run probe               # measure on-topic vs off-topic similarity
```

`probe` prints top and mean similarity for known on-topic and off-topic queries. Set
`RAG_MIN_SIMILARITY` and `RAG_SUFFICIENCY_SIMILARITY` between the two bands.

The current values (0.75 / 0.84) came from measuring e5-small on the seeded corpus: on-topic queries
topped out at 0.858–0.914, off-topic at 0.775–0.830. A threshold borrowed from a different model
family would have filtered nothing at all.
