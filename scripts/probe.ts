#!/usr/bin/env tsx
/**
 * npm run probe — calibration and driver-behaviour probe.
 *
 * Two things this answers that are easy to get wrong by assumption:
 *
 *   1. How each driver hands back a scalar JSONB value. `pg` and PGlite differ,
 *      and guessing produces answers that silently read as null.
 *   2. What cosine similarities the configured embedding model actually
 *      produces for on-topic versus off-topic queries. Similarity floors are
 *      model-specific — e5 models sit in a compressed high band, so a floor
 *      copied from a different model admits everything.
 *
 * Kept in the repo because RAG_MIN_SIMILARITY has to be re-derived whenever the
 * embedding model changes, and re-deriving it by intuition is how retrieval
 * quietly stops filtering anything.
 */
import './_env';

import { closeDb, sql } from '@/lib/db/client';
import { getConfig } from '@/lib/config/env';
import { hybridSearch } from '@/lib/rag/retrieve';

async function probeJsonbRoundTrip(): Promise<void> {
  console.log('\n[1mJSONB scalar round-trip[0m');
  await sql('CREATE TABLE IF NOT EXISTS _probe_jsonb (k TEXT PRIMARY KEY, v JSONB)');
  await sql('DELETE FROM _probe_jsonb');

  const cases: Array<[string, unknown]> = [
    ['string', 'renewal'],
    ['number', 30],
    ['boolean', true],
    ['null', null],
    ['array', ['a', 'b']],
    ['object', { a: 1 }],
  ];

  for (const [key, value] of cases) {
    await sql('INSERT INTO _probe_jsonb (k, v) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  }

  const rows = await sql<{ k: string; v: unknown }>('SELECT k, v FROM _probe_jsonb ORDER BY k');
  for (const row of rows) {
    console.log(
      `  ${row.k.padEnd(8)} -> typeof=${(typeof row.v).padEnd(8)} value=${JSON.stringify(row.v)}`,
    );
  }
  await sql('DROP TABLE _probe_jsonb');
}

async function probeSimilarity(): Promise<void> {
  const cfg = getConfig();
  console.log(
    `\n[1mEmbedding similarity calibration[0m  (${cfg.EMBEDDING_PROVIDER}/${cfg.EMBEDDING_MODEL}, floor=${cfg.RAG_MIN_SIMILARITY})`,
  );

  const queries: Array<[string, string]> = [
    ['on-topic  ', 'procedure for replacing a lost national identity card'],
    ['on-topic  ', 'what documents do I need for a passport'],
    ['on-topic  ', 'domicile certificate district residence proof'],
    ['roman urdu', 'mera CNIC gum ho gaya hai kya karna hai'],
    ['urdu      ', 'شناختی کارڈ گم ہو گیا ہے'],
    ['off-topic ', 'procedure for registering a commercial fishing vessel'],
    ['off-topic ', 'how do I bake sourdough bread at home'],
    ['off-topic ', 'symptoms of seasonal influenza in children'],
  ];

  for (const [label, query] of queries) {
    const result = await hybridSearch(query, {}, { minSimilarity: 0 });
    const sims = result.evidence
      .map((e) => e.vectorSimilarity)
      .filter((s): s is number => s !== null);
    const top = sims.length > 0 ? Math.max(...sims) : null;
    const mean = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : null;

    console.log(
      `  ${label} top=${top === null ? '  n/a' : top.toFixed(3)}` +
        `  mean=${mean === null ? '  n/a' : mean.toFixed(3)}` +
        `  chunks=${String(result.evidence.length).padStart(2)}` +
        `  lexical=${String(result.lexicalCount).padStart(2)}` +
        `  "${query.slice(0, 44)}"`,
    );
  }

  console.log(
    '\n  Set RAG_MIN_SIMILARITY between the off-topic top scores and the on-topic ones.',
  );
}

async function main(): Promise<void> {
  await probeJsonbRoundTrip();
  await probeSimilarity();
  console.log('');
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('probe failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
