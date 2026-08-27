-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — Grounded retrieval layer
--
-- Official prose that resists tabulation: notification text, clarifications,
-- unusual-case guidance. Chunks are embedded and retrieved by hybrid search
-- (lexical + vector, fused with reciprocal rank fusion).
--
-- Retrieval finds text. It does not decide truth. A chunk that comes back
-- below the similarity floor is not evidence, and "we have nothing documented
-- for this" is a legitimate, shippable answer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id                  BIGSERIAL PRIMARY KEY,
  source_id           BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  service_id          BIGINT REFERENCES services(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  language            language_code NOT NULL DEFAULT 'en',
  raw_text_hash       TEXT NOT NULL,
  char_count          INTEGER NOT NULL DEFAULT 0,
  chunk_count         INTEGER NOT NULL DEFAULT 0,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, raw_text_hash)
);

-- The `embedding` column width is pinned to EMBEDDING_DIM (default 384,
-- Xenova/multilingual-e5-small). Changing the provider to one with a different
-- width requires a reset + reindex; the migration runner asserts this on boot
-- so a silent dimension mismatch can never reach retrieval.
CREATE TABLE IF NOT EXISTS document_chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id       BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  service_id      BIGINT REFERENCES services(id) ON DELETE SET NULL,
  scenario_code   TEXT,
  chunk_index     INTEGER NOT NULL,
  heading_path    TEXT,
  content         TEXT NOT NULL,
  content_norm    TEXT NOT NULL,          -- transliteration-folded copy, used for lexical search
  language        language_code NOT NULL DEFAULT 'en',
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  embedding       vector(${EMBEDDING_DIM}),
  embedding_model TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

-- Lexical arm of hybrid retrieval. The 'simple' configuration is deliberate:
-- Postgres has no Urdu stemmer, and 'simple' (fold + tokenize, no stemming)
-- behaves correctly across en / ur / roman_ur instead of mangling two of them.
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content_norm, ''))) STORED;

-- ── Embedding cache ────────────────────────────────────────────────────────
-- Keyed by sha256(model || ':' || text). Makes the demo instant on repeat runs
-- and keeps a free-tier quota from being the thing that breaks a pitch.
CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_key   TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  embedding   vector(${EMBEDDING_DIM}) NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── LLM response cache ─────────────────────────────────────────────────────
-- Keyed by sha256(provider|model|messages|schema|temperature). Deterministic
-- replay of a demo path, and a hard cap on token spend during evaluation runs.
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key     TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  request_kind  TEXT NOT NULL,
  response      JSONB NOT NULL,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);
