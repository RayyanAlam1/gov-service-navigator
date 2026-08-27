#!/usr/bin/env tsx
/**
 * npm run db:index            embed any chunk that has no vector
 * npm run db:index -- --all   re-embed everything (after a model change)
 *
 * Needed whenever the embedding model or its dimension changes. Vectors from
 * two different models are not comparable — mixing them does not error, it just
 * quietly returns worse results, which is the failure mode hardest to notice.
 * `--all` exists precisely so that a model swap is a deliberate, complete
 * operation rather than a gradual drift.
 */
import './_env';

import { getConfig } from '@/lib/config/env';
import { closeDb, sql, toVectorLiteral } from '@/lib/db/client';
import { assertEmbeddingDim } from '@/lib/db/migrate';
import { getEmbeddingProvider } from '@/lib/embeddings';

const args = new Set(process.argv.slice(2));
const all = args.has('--all');

interface ChunkRow {
  id: number;
  content: string;
  embedding_model: string | null;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  await assertEmbeddingDim();

  const provider = getEmbeddingProvider();
  console.log(`▸ reindexing with ${provider.name}/${provider.model} @ ${provider.dim}d`);

  if (provider.degraded) {
    console.log(
      '  ! provider is degraded (hash embeddings). Writing these would bake lexical-only\n' +
        '    vectors into the index. Fix the model first, or set EMBEDDING_PROVIDER=hash\n' +
        '    deliberately if that is what you want.',
    );
  }

  // A chunk embedded by a *different* model is as stale as one with no vector
  // at all, so it is picked up automatically without needing --all.
  const rows = await sql<ChunkRow>(
    all
      ? 'SELECT id, content, embedding_model FROM document_chunks ORDER BY id'
      : `SELECT id, content, embedding_model FROM document_chunks
          WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1
          ORDER BY id`,
    all ? [] : [provider.model],
  );

  if (rows.length === 0) {
    console.log('  ✓ every chunk is already embedded with the current model.');
    return;
  }

  console.log(`  ${rows.length} chunk(s) to embed`);

  const batchSize = cfg.EMBEDDING_BATCH_SIZE;
  let done = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const vectors = await provider.embedPassages(batch.map((r) => r.content));

    for (const [index, row] of batch.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      await sql(
        'UPDATE document_chunks SET embedding = $2::vector, embedding_model = $3 WHERE id = $1',
        [row.id, toVectorLiteral(vector), provider.model],
      );
      done += 1;
    }

    process.stdout.write(`\r  embedded ${done}/${rows.length}`);
  }

  process.stdout.write('\n');

  // The embedding cache is keyed by model, so stale entries are inert rather
  // than wrong — but clearing them keeps the table from growing forever.
  const cleared = await sql<{ cache_key: string }>(
    'DELETE FROM embedding_cache WHERE model IS DISTINCT FROM $1 RETURNING cache_key',
    [provider.model],
  );
  if (cleared.length > 0) {
    console.log(`  · cleared ${cleared.length} cached embedding(s) from other models`);
  }

  console.log(`\n▸ reindex complete: ${done} chunk(s) embedded with ${provider.model}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('\n✖ reindex failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
