-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Extensions, enums and shared helpers
--
-- Portability note: every statement in this file must run on both real
-- PostgreSQL 16 (docker compose / managed) and PGlite 0.2 (embedded WASM,
-- used for CI and offline demos). Statements that only exist on one of the
-- two are wrapped in a guarded DO block by the migration runner instead of
-- being placed here.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Provenance -------------------------------------------------------------
-- Every fact the citizen is shown carries one of these. This is the single
-- most important column family in the schema: it is what stops the product
-- from presenting a plausible invention as a government requirement.
--
--   verified    a human confirmed this against the cited official source on
--               `last_verified`, and the source is still within its freshness
--               window.
--   unverified  structurally correct, sourced from a real official domain,
--               but not yet confirmed by a human. The UI must label it.
--   synthetic   demo/placeholder content. The UI must label it loudly and it
--               must never be presented as an official requirement.
--   deprecated  superseded by a newer version of the same fact.
DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('verified', 'unverified', 'synthetic', 'deprecated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Language ---------------------------------------------------------------
-- roman_ur is a first-class language, not a dialect of English. It is how a
-- very large share of Pakistani citizens actually type.
DO $$ BEGIN
  CREATE TYPE language_code AS ENUM ('en', 'ur', 'roman_ur');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Channel ----------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE service_channel AS ENUM ('online', 'in_person', 'either', 'postal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Readiness --------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE readiness_state AS ENUM ('ready', 'nearly_ready', 'not_ready', 'undetermined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Session lifecycle ------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE session_status AS ENUM ('intake', 'interviewing', 'resolved', 'planned', 'abandoned', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Interview variable types ----------------------------------------------
DO $$ BEGIN
  CREATE TYPE variable_type AS ENUM ('boolean', 'enum', 'number', 'text', 'date');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Document check outcome -------------------------------------------------
DO $$ BEGIN
  CREATE TYPE document_match_status AS ENUM ('match', 'mismatch', 'unreadable', 'wrong_document', 'expired', 'inconclusive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── updated_at trigger helper ---------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
