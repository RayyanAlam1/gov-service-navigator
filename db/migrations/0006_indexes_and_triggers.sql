-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Indexes and triggers
--
-- Statements marked `-- @optional` are allowed to fail without failing the
-- migration. They are performance structures (ANN indexes) that real
-- PostgreSQL+pgvector supports but the embedded PGlite driver may not. At
-- demo corpus size a sequential scan is a few milliseconds, so degrading to
-- one is correct behaviour, not a broken install. The runner logs a warning.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Knowledge lookups ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_services_active ON services (is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_scenarios_service ON service_scenarios (service_id, priority);
CREATE INDEX IF NOT EXISTS idx_aliases_service ON service_aliases (service_id);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON service_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_rules_service ON eligibility_rules (service_id, scenario_id);
CREATE INDEX IF NOT EXISTS idx_requirements_service ON requirements (service_id, scenario_id, display_order);
CREATE INDEX IF NOT EXISTS idx_requirements_doctype ON requirements (document_type);
CREATE INDEX IF NOT EXISTS idx_steps_service ON procedure_steps (service_id, scenario_id, step_order);
CREATE INDEX IF NOT EXISTS idx_fees_service ON fees (service_id, scenario_id);
CREATE INDEX IF NOT EXISTS idx_times_service ON processing_times (service_id, scenario_id);
CREATE INDEX IF NOT EXISTS idx_offices_city ON offices (lower(city));
CREATE INDEX IF NOT EXISTS idx_offices_province ON offices (province);
CREATE INDEX IF NOT EXISTS idx_office_services_service ON office_services (service_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_service ON exception_routes (service_id);
CREATE INDEX IF NOT EXISTS idx_decision_vars_service ON decision_variables (service_id, ask_priority);

-- ── Retrieval ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_service ON document_chunks (service_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON document_chunks (source_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING GIN (content_tsv);

-- Approximate nearest neighbour. Cosine distance, matching the `<=>` operator
-- used in src/lib/rag/retrieve.ts.
-- @optional
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Sessions ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_answers_session ON session_answers (session_id);
CREATE INDEX IF NOT EXISTS idx_plans_session ON session_plans (session_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_doc_checks_session ON document_checks (session_id, created_at DESC);

-- ── Observability ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_traces_session ON agent_traces (session_id, turn_id, step_index);
CREATE INDEX IF NOT EXISTS idx_traces_created ON agent_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_session ON guardrail_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_rule ON guardrail_events (rule, severity);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results (run_id, passed);
CREATE INDEX IF NOT EXISTS idx_llm_cache_expiry ON llm_cache (expires_at);

-- ── updated_at triggers ────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'sources','departments','services','service_scenarios','decision_variables',
    'eligibility_rules','requirements','procedure_steps','fees','processing_times',
    'offices','exception_routes','documents','sessions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
