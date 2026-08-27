-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Government knowledge core
--
-- This is the deterministic layer. Everything a citizen is told about a fee,
-- a document, a deadline or an office is a row in here, queried by code and
-- rendered by the language layer. The model never authors these values.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Sources ────────────────────────────────────────────────────────────────
-- A source is an official artefact: a department page, a notification PDF, a
-- fee schedule. Nothing downstream may claim provenance without pointing here.
CREATE TABLE IF NOT EXISTS sources (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  publisher           TEXT NOT NULL,                 -- e.g. NADRA, DGIP
  url                 TEXT,
  doc_type            TEXT NOT NULL DEFAULT 'web',   -- web | pdf | notification | synthetic
  language            language_code NOT NULL DEFAULT 'en',
  retrieved_at        TIMESTAMPTZ,
  last_verified       TIMESTAMPTZ,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  content_hash        TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Departments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name_en       TEXT NOT NULL,
  name_ur       TEXT,
  short_name    TEXT,
  jurisdiction  TEXT NOT NULL DEFAULT 'federal',     -- federal | provincial | district
  province      TEXT,
  website       TEXT,
  source_id     BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Services ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id                     BIGSERIAL PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,       -- cnic | passport | domicile
  department_id          BIGINT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  name_en                TEXT NOT NULL,
  name_ur                TEXT,
  name_roman_ur          TEXT,
  summary_en             TEXT,
  summary_ur             TEXT,
  summary_roman_ur       TEXT,
  category               TEXT NOT NULL DEFAULT 'identity',
  official_url           TEXT,
  online_application_url TEXT,                       -- NULL = no official online route exists
  jurisdiction_scope     TEXT NOT NULL DEFAULT 'national',
  display_order          INTEGER NOT NULL DEFAULT 100,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  source_id              BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status    verification_status NOT NULL DEFAULT 'unverified',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Scenarios ──────────────────────────────────────────────────────────────
-- A scenario is a branch of a service: new / renewal / lost / modification.
-- `selector` is a deterministic condition tree evaluated against the interview
-- answers by src/lib/engine/rules.ts — never by the model.
CREATE TABLE IF NOT EXISTS service_scenarios (
  id                  BIGSERIAL PRIMARY KEY,
  service_id          BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  name_en             TEXT NOT NULL,
  name_ur             TEXT,
  name_roman_ur       TEXT,
  description_en      TEXT,
  selector            JSONB NOT NULL DEFAULT '{"op":"always"}'::jsonb,
  priority            INTEGER NOT NULL DEFAULT 100,  -- lower wins when several match
  is_exception_path   BOOLEAN NOT NULL DEFAULT FALSE,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);

-- ── Aliases ────────────────────────────────────────────────────────────────
-- Deterministic multilingual matching surface. The model proposes a service;
-- this table plus the scoring in engine/service-resolver.ts decides it.
CREATE TABLE IF NOT EXISTS service_aliases (
  id          BIGSERIAL PRIMARY KEY,
  service_id  BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  language    language_code NOT NULL DEFAULT 'en',
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Decision variables ─────────────────────────────────────────────────────
-- The interview vocabulary. A question is only ever asked because some rule,
-- requirement or scenario selector references the variable AND the answer can
-- still change the outcome.
CREATE TABLE IF NOT EXISTS decision_variables (
  id                BIGSERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  service_id        BIGINT REFERENCES services(id) ON DELETE CASCADE,  -- NULL = global
  var_type          variable_type NOT NULL,
  prompt_en         TEXT NOT NULL,
  prompt_ur         TEXT,
  prompt_roman_ur   TEXT,
  help_en           TEXT,
  help_ur           TEXT,
  help_roman_ur     TEXT,
  options           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{value,label_en,label_ur,label_roman_ur}]
  default_value     JSONB,
  ask_priority      INTEGER NOT NULL DEFAULT 100,
  is_sensitive      BOOLEAN NOT NULL DEFAULT FALSE,      -- never written to traces
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Eligibility rules ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eligibility_rules (
  id                  BIGSERIAL PRIMARY KEY,
  service_id          BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id         BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  statement_en        TEXT NOT NULL,
  statement_ur        TEXT,
  statement_roman_ur  TEXT,
  condition           JSONB NOT NULL,                -- condition AST, see engine/rules.ts
  outcome             TEXT NOT NULL,                 -- eligible | ineligible | conditional | route_exception
  failure_message_en  TEXT,
  remedy_en           TEXT,                          -- what the citizen can do about it
  severity            TEXT NOT NULL DEFAULT 'blocking',  -- blocking | advisory
  version             INTEGER NOT NULL DEFAULT 1,
  effective_from      DATE,
  effective_to        DATE,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code, version)
);

-- ── Requirements ───────────────────────────────────────────────────────────
-- The checklist. `applies_when` lets one row serve several scenarios without
-- duplication, and is what makes the checklist personalized, not generic.
CREATE TABLE IF NOT EXISTS requirements (
  id                  BIGSERIAL PRIMARY KEY,
  service_id          BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id         BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  document_type       TEXT NOT NULL,                 -- machine key for the document checker
  title_en            TEXT NOT NULL,
  title_ur            TEXT,
  title_roman_ur      TEXT,
  description_en      TEXT,
  is_mandatory        BOOLEAN NOT NULL DEFAULT TRUE,
  applies_when        JSONB NOT NULL DEFAULT '{"op":"always"}'::jsonb,
  copies_required     INTEGER,
  must_be_original    BOOLEAN NOT NULL DEFAULT FALSE,
  substitutes         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- acceptable alternative requirement codes
  obtain_from         TEXT,                                -- where to get it if missing
  obtain_service_code TEXT,                                -- links to another service in this system
  display_order       INTEGER NOT NULL DEFAULT 100,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);

-- ── Procedure steps ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procedure_steps (
  id                   BIGSERIAL PRIMARY KEY,
  service_id           BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id          BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL,
  step_order           INTEGER NOT NULL,
  title_en             TEXT NOT NULL,
  title_ur             TEXT,
  title_roman_ur       TEXT,
  instruction_en       TEXT NOT NULL,
  instruction_ur       TEXT,
  instruction_roman_ur TEXT,
  channel              service_channel NOT NULL DEFAULT 'in_person',
  applies_when         JSONB NOT NULL DEFAULT '{"op":"always"}'::jsonb,
  action_url           TEXT,
  estimated_duration   TEXT,
  source_id            BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status  verification_status NOT NULL DEFAULT 'unverified',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);

-- ── Fees ───────────────────────────────────────────────────────────────────
-- amount_minor is deliberately NULLABLE. A NULL fee renders as "fee not
-- verified — confirm at the office", which is correct and safe. An invented
-- number is neither.
CREATE TABLE IF NOT EXISTS fees (
  id                  BIGSERIAL PRIMARY KEY,
  service_id          BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id         BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'normal', -- normal | urgent | executive | fast_track
  label_en            TEXT NOT NULL,
  label_ur            TEXT,
  amount_minor        BIGINT,                         -- paisa; NULL = not verified
  currency            TEXT NOT NULL DEFAULT 'PKR',
  applies_when        JSONB NOT NULL DEFAULT '{"op":"always"}'::jsonb,
  note_en             TEXT,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);

-- ── Processing times ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processing_times (
  id                  BIGSERIAL PRIMARY KEY,
  service_id          BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id         BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'normal',
  label_en            TEXT NOT NULL,
  min_days            INTEGER,                        -- NULL = not verified
  max_days            INTEGER,
  applies_when        JSONB NOT NULL DEFAULT '{"op":"always"}'::jsonb,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);

-- ── Offices ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offices (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  department_id       BIGINT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name_en             TEXT NOT NULL,
  name_ur             TEXT,
  office_type         TEXT NOT NULL DEFAULT 'registration_centre',
  address_en          TEXT,
  city                TEXT NOT NULL,
  district            TEXT,
  province            TEXT NOT NULL,
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,
  phone               TEXT,
  email               TEXT,
  hours_en            TEXT,
  appointment_url     TEXT,
  source_id           BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS office_services (
  office_id   BIGINT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  service_id  BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scenario_id BIGINT REFERENCES service_scenarios(id) ON DELETE CASCADE,
  note_en     TEXT,
  PRIMARY KEY (office_id, service_id)
);

-- ── Exception routes ───────────────────────────────────────────────────────
-- Lost record, address mismatch, missing parental document, name mismatch.
-- These are the cases where a generic FAQ fails the citizen, so they are
-- modelled explicitly rather than left to the model to improvise.
CREATE TABLE IF NOT EXISTS exception_routes (
  id                      BIGSERIAL PRIMARY KEY,
  service_id              BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  code                    TEXT NOT NULL,
  name_en                 TEXT NOT NULL,
  name_ur                 TEXT,
  trigger_condition       JSONB NOT NULL,
  guidance_en             TEXT NOT NULL,
  guidance_ur             TEXT,
  extra_requirement_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra_step_codes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalate_to_office      BOOLEAN NOT NULL DEFAULT FALSE,
  source_id               BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  verification_status     verification_status NOT NULL DEFAULT 'unverified',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, code)
);
