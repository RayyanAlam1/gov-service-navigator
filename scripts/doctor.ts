#!/usr/bin/env tsx
/**
 * npm run doctor — pre-flight diagnostics.
 *
 * Run this before a demo. It answers, in one screen, the questions that
 * otherwise get answered by watching something fail in front of an audience:
 * is the database reachable, is the schema complete, is the corpus indexed,
 * which LLM provider will actually serve the next request, and is the
 * embedding width consistent between config and storage.
 *
 * Exit code is non-zero only for conditions that make the system *wrong*, not
 * merely degraded. Running on the deterministic provider is a supported mode
 * and exits 0 with a warning.
 */
import './_env';

import { describeCapabilities, getConfig, llmProviderChain } from '@/lib/config/env';
import { closeDb, getDb, sql } from '@/lib/db/client';
import { assertEmbeddingDim } from '@/lib/db/migrate';

const EXPECTED_TABLES = [
  'sources', 'departments', 'services', 'service_scenarios', 'service_aliases',
  'decision_variables', 'eligibility_rules', 'requirements', 'procedure_steps',
  'fees', 'processing_times', 'offices', 'office_services', 'exception_routes',
  'documents', 'document_chunks', 'embedding_cache', 'llm_cache',
  'sessions', 'session_answers', 'session_plans', 'document_checks',
  'agent_traces', 'guardrail_events', 'eval_runs', 'eval_results',
  'rate_limit_buckets', 'schema_migrations', 'system_meta',
];

const ok = (m: string) => console.log(`  [32m✓[0m ${m}`);
const warn = (m: string) => console.log(`  [33m![0m ${m}`);
const bad = (m: string) => console.log(`  [31m✖[0m ${m}`);
const head = (m: string) => console.log(`\n[1m${m}[0m`);

let failures = 0;
let warnings = 0;

async function checkDatabase(): Promise<void> {
  head('Database');
  const cfg = getConfig();
  try {
    const db = await getDb();
    const t0 = Date.now();
    await db.query('SELECT 1');
    ok(`${cfg.DB_DRIVER} reachable (${Date.now() - t0}ms)`);
  } catch (err) {
    bad(`cannot connect (${cfg.DB_DRIVER}): ${err instanceof Error ? err.message : String(err)}`);
    if (cfg.DB_DRIVER === 'pg') {
      warn('start it with `docker compose up -d db`, or set DB_DRIVER=pglite for embedded mode');
    }
    failures += 1;
    return;
  }

  const rows = await sql<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const present = new Set(rows.map((r) => r.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  if (missing.length === 0) ok(`schema complete (${EXPECTED_TABLES.length} tables)`);
  else {
    bad(`missing ${missing.length} table(s): ${missing.join(', ')}`);
    warn('run `npm run db:migrate`');
    failures += 1;
  }

  const [vec] = await sql<{ udt: string; dims: number | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS udt, a.atttypmod AS dims
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'document_chunks' AND a.attname = 'embedding'`,
  );
  if (vec) ok(`document_chunks.embedding is ${vec.udt}`);

  try {
    await assertEmbeddingDim();
    ok(`embedding width consistent (${getConfig().EMBEDDING_DIM})`);
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
    failures += 1;
  }

  const [ann] = await sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%hnsw%'",
  );
  if ((ann?.n ?? 0) > 0) ok('ANN index present (hnsw, cosine)');
  else {
    warn('no ANN index — vector search will sequential-scan (fine at demo corpus size)');
    warnings += 1;
  }
}

async function checkContent(): Promise<void> {
  head('Knowledge base');
  const counts = await sql<{ label: string; n: number }>(`
    SELECT 'services' AS label, count(*)::int AS n FROM services
    UNION ALL SELECT 'scenarios', count(*)::int FROM service_scenarios
    UNION ALL SELECT 'requirements', count(*)::int FROM requirements
    UNION ALL SELECT 'steps', count(*)::int FROM procedure_steps
    UNION ALL SELECT 'rules', count(*)::int FROM eligibility_rules
    UNION ALL SELECT 'offices', count(*)::int FROM offices
    UNION ALL SELECT 'exceptions', count(*)::int FROM exception_routes
    UNION ALL SELECT 'sources', count(*)::int FROM sources
    UNION ALL SELECT 'documents', count(*)::int FROM documents
    UNION ALL SELECT 'chunks', count(*)::int FROM document_chunks
  `).catch(() => []);

  if (counts.length === 0) {
    bad('could not read content counts');
    failures += 1;
    return;
  }
  const by = new Map(counts.map((c) => [c.label, c.n] as const));
  const line = counts.map((c) => `${c.label}=${c.n}`).join('  ');
  if ((by.get('services') ?? 0) === 0) {
    bad(`knowledge base is empty (${line})`);
    warn('run `npm run db:seed`');
    failures += 1;
  } else {
    ok(line);
  }

  const [embedded] = await sql<{ n: number; total: number }>(
    'SELECT count(embedding)::int AS n, count(*)::int AS total FROM document_chunks',
  );
  if (embedded && embedded.total > 0) {
    if (embedded.n === embedded.total) ok(`all ${embedded.total} chunks embedded`);
    else {
      warn(`${embedded.total - embedded.n} of ${embedded.total} chunks have no embedding — run \`npm run db:index\``);
      warnings += 1;
    }
  }

  // Provenance audit: nothing citizen-facing may exist without a source row.
  const [orphan] = await sql<{ n: number }>(`
    SELECT (
      (SELECT count(*) FROM requirements WHERE source_id IS NULL) +
      (SELECT count(*) FROM procedure_steps WHERE source_id IS NULL) +
      (SELECT count(*) FROM eligibility_rules WHERE source_id IS NULL) +
      (SELECT count(*) FROM fees WHERE source_id IS NULL)
    )::int AS n
  `);
  if ((orphan?.n ?? 0) === 0) ok('every requirement, step, rule and fee has a source');
  else {
    bad(`${orphan?.n} citizen-facing fact(s) have no source_id — these must never render`);
    failures += 1;
  }

  const status = await sql<{ verification_status: string; n: number }>(`
    SELECT verification_status, count(*)::int AS n FROM (
      SELECT verification_status FROM requirements
      UNION ALL SELECT verification_status FROM procedure_steps
      UNION ALL SELECT verification_status FROM eligibility_rules
      UNION ALL SELECT verification_status FROM fees
    ) s GROUP BY 1 ORDER BY 2 DESC
  `);
  const summary = status.map((s) => `${s.verification_status}=${s.n}`).join('  ');
  const unverified = status.find((s) => s.verification_status !== 'verified');
  if (summary) {
    if (unverified) {
      warn(`provenance: ${summary}`);
      warn('unverified/synthetic facts render with a visible badge — see docs/DATA_PROVENANCE.md');
      warnings += 1;
    } else {
      ok(`provenance: ${summary}`);
    }
  }
}

function checkProviders(): void {
  head('AI providers');
  const caps = describeCapabilities();
  const chain = llmProviderChain();

  console.log(`  chain: ${chain.join(' → ')}`);
  if (caps.llm.live) {
    ok(`llm live via ${chain[0]} (dashscope keys=${caps.llm.keys.dashscope}, groq keys=${caps.llm.keys.groq})`);
  } else {
    warn('no LLM credentials — running on the deterministic provider');
    warn('government facts are still correct; phrasing and translation are templated');
    warnings += 1;
  }

  if (caps.embeddings.degraded) {
    warn(`embeddings: ${caps.embeddings.provider} (lexical only) — ${caps.embeddings.reason ?? ''}`);
    warnings += 1;
  } else {
    ok(`embeddings: ${caps.embeddings.provider} / ${caps.embeddings.model} @ ${caps.embeddings.dim}d`);
  }

  const cfg = getConfig();
  ok(`grounding: strict=${cfg.STRICT_GROUNDING} minSimilarity=${cfg.RAG_MIN_SIMILARITY} staleAfter=${cfg.SOURCE_STALE_AFTER_DAYS}d`);
}

async function main(): Promise<void> {
  console.log('\n[1mGovernment Service AI Navigator — doctor[0m');
  checkProviders();
  await checkDatabase();
  if (failures === 0) await checkContent();

  head('Summary');
  if (failures > 0) {
    bad(`${failures} blocking problem(s), ${warnings} warning(s)`);
    process.exitCode = 1;
  } else if (warnings > 0) {
    warn(`ready, with ${warnings} warning(s) — all are supported degraded modes`);
  } else {
    ok('all checks passed');
  }
  console.log('');
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('\n✖ doctor failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
