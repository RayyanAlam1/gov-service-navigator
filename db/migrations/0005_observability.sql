-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Observability, guardrails and evaluation
--
-- Two audiences:
--   1. Operators, who need to know why an answer came out the way it did.
--   2. Judges, who need to be shown — in four minutes — exactly where AI is
--      used and where deterministic logic is used. `agent_traces.deterministic`
--      is what makes that demonstrable rather than merely claimed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_traces (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  agent           TEXT NOT NULL,        -- guardrail_in | language | intent | ...
  stage           TEXT NOT NULL,        -- maps to the ten-stage citizen journey
  deterministic   BOOLEAN NOT NULL,     -- TRUE = no model was consulted
  status          TEXT NOT NULL,        -- ok | degraded | blocked | error | cache_hit
  provider        TEXT,
  model           TEXT,
  input_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes           TEXT,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  prompt_tokens   INTEGER,
  output_tokens   INTEGER,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Guardrail audit ────────────────────────────────────────────────────────
-- Every trip of an input or output guardrail lands here: injection attempts,
-- out-of-scope questions, PII redactions, and — most importantly — every
-- ungrounded claim the output verifier stripped before it reached a citizen.
CREATE TABLE IF NOT EXISTS guardrail_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id       TEXT,
  direction     TEXT NOT NULL,          -- input | output
  rule          TEXT NOT NULL,
  severity      TEXT NOT NULL,          -- info | warn | block
  action        TEXT NOT NULL,          -- allowed | redacted | rewritten | blocked | fallback
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Evaluation harness ─────────────────────────────────────────────────────
-- Targets live in docs/EVALUATION.md. The grounding and hallucination targets
-- are absolute, not aspirational: a 99% grounding rate means one citizen in a
-- hundred is sent to the wrong office with confidence.
CREATE TABLE IF NOT EXISTS eval_runs (
  id                    BIGSERIAL PRIMARY KEY,
  run_key               TEXT NOT NULL UNIQUE,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  embedding_provider    TEXT NOT NULL,
  scenario_count        INTEGER NOT NULL DEFAULT 0,
  passed_count          INTEGER NOT NULL DEFAULT 0,
  service_accuracy      REAL,
  scenario_accuracy     REAL,
  requirement_f1        REAL,
  readiness_accuracy    REAL,
  grounding_rate        REAL,
  unsupported_claims    INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms        INTEGER,
  avg_questions_asked   REAL,
  git_sha               TEXT,
  notes                 TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS eval_results (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              BIGINT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  scenario_id         TEXT NOT NULL,
  passed              BOOLEAN NOT NULL,
  expected            JSONB NOT NULL,
  actual              JSONB NOT NULL,
  failures            JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_asked     INTEGER NOT NULL DEFAULT 0,
  latency_ms          INTEGER NOT NULL DEFAULT 0,
  unsupported_claims  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, scenario_id)
);

-- ── Rate limiting ──────────────────────────────────────────────────────────
-- Database-backed so it survives a restart and works across replicas. The key
-- is a coarse fingerprint (hashed IP + UA), never an identity.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key    TEXT PRIMARY KEY,
  window_start  TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
