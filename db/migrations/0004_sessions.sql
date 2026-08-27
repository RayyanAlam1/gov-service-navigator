-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Citizen sessions
--
-- Session isolation rules enforced here and in src/lib/db/repositories/session:
--   * `public_token` is the only identifier that ever leaves the server. It is
--     32 random bytes, base64url. The BIGSERIAL `id` is never exposed.
--   * Every read is scoped by public_token. One citizen's answers must not be
--     reachable from another's session under any query in the codebase.
--   * `language` is a DISPLAY property of a session, not part of its identity.
--     Switching to Urdu mid-interview must not create a new session or drop a
--     single answer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
  id                  BIGSERIAL PRIMARY KEY,
  public_token        TEXT NOT NULL UNIQUE,
  status              session_status NOT NULL DEFAULT 'intake',
  detected_language   language_code NOT NULL DEFAULT 'en',
  preferred_language  language_code NOT NULL DEFAULT 'en',
  original_query      TEXT,
  normalized_query    TEXT,
  service_id          BIGINT REFERENCES services(id) ON DELETE SET NULL,
  scenario_id         BIGINT REFERENCES service_scenarios(id) ON DELETE SET NULL,
  service_confidence  REAL,
  location_city       TEXT,
  location_province   TEXT,
  readiness           readiness_state NOT NULL DEFAULT 'undetermined',
  turn_count          INTEGER NOT NULL DEFAULT 0,
  client_fingerprint  TEXT,                 -- coarse rate-limit key; never an identity
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL
);

-- ── Interview answers ──────────────────────────────────────────────────────
-- `origin` records HOW we know this: the citizen told us (`user`), we inferred
-- it from the opening sentence (`inferred`), or a document check established
-- it (`document`). Inferred values are re-confirmable and are shown to the
-- citizen as assumptions, never as facts they stated.
CREATE TABLE IF NOT EXISTS session_answers (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  variable_code   TEXT NOT NULL,
  value           JSONB NOT NULL,
  origin          TEXT NOT NULL DEFAULT 'user',   -- user | inferred | document | default
  confidence      REAL NOT NULL DEFAULT 1.0,
  asked_at        TIMESTAMPTZ,
  answered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, variable_code)
);

-- ── Generated plans ────────────────────────────────────────────────────────
-- Versioned. Regenerating after a new answer keeps the previous version so the
-- UI can show what changed and the eval harness can diff plan stability.
CREATE TABLE IF NOT EXISTS session_plans (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  plan            JSONB NOT NULL,
  readiness       JSONB NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  grounding_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  language        language_code NOT NULL DEFAULT 'en',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, version)
);

-- ── Document checks ────────────────────────────────────────────────────────
-- Deliberately has no column for image bytes, no file path, and no raw OCR
-- text. Uploads are processed in memory and discarded; only the structured
-- field-match verdict is persisted. See src/lib/documents/.
CREATE TABLE IF NOT EXISTS document_checks (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  requirement_id      BIGINT REFERENCES requirements(id) ON DELETE SET NULL,
  declared_type       TEXT NOT NULL,
  detected_type       TEXT,
  match_status        document_match_status NOT NULL,
  confidence          REAL NOT NULL DEFAULT 0,
  extracted_fields    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- redacted; see documents/redact.ts
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  ocr_provider        TEXT NOT NULL DEFAULT 'mock',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
