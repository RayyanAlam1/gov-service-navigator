#!/usr/bin/env tsx
/**
 * npm run model:fetch — download the local embedding model into data/models/.
 *
 * Run once after clone, and baked into the container image at build time. The
 * point is that the running system never downloads anything: a demo on a
 * conference network with no reliable internet still has full semantic
 * retrieval, and the first citizen query is not the one that pays a 100MB
 * download.
 *
 * Failure here is not fatal. The embedding layer degrades to hash embeddings,
 * which keeps retrieval working (lexically) and is reported as degraded by
 * /api/health — a documented reduced mode rather than a broken install.
 */
import './_env';

import { getConfig } from '@/lib/config/env';
import { getEmbeddingProvider, resetEmbeddingProviderForTests } from '@/lib/embeddings';

async function main(): Promise<void> {
  const cfg = getConfig();

  if (cfg.EMBEDDING_PROVIDER !== 'local') {
    console.log(
      `▸ EMBEDDING_PROVIDER=${cfg.EMBEDDING_PROVIDER}; no local model to fetch. Nothing to do.`,
    );
    return;
  }

  console.log(`▸ fetching ${cfg.EMBEDDING_MODEL} into ${cfg.TRANSFORMERS_CACHE}`);
  console.log('  (first run downloads ~100-130MB; subsequent runs are cached)');

  resetEmbeddingProviderForTests();
  const provider = getEmbeddingProvider();

  const started = Date.now();
  // Embedding one short passage forces the full model load, which is what
  // populates the cache. Anything less would leave a partial download.
  const [vector] = await provider.embedPassages(['Government service navigator model warm-up.']);

  if (!vector || vector.length === 0) {
    throw new Error('model loaded but produced no embedding');
  }

  const nonZero = vector.filter((v) => v !== 0).length;
  if (nonZero === 0) {
    throw new Error('model produced an all-zero embedding');
  }

  console.log(
    `  ✓ ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${provider.name}/${provider.model} @ ${vector.length}d` +
      (provider.degraded ? '  \x1b[33m(degraded: fell back to hash embeddings)\x1b[0m' : ''),
  );

  if (provider.degraded) {
    console.log('  ! the ONNX model could not be loaded. Retrieval will be lexical-only.');
    console.log('    /api/health reports this; set EMBEDDING_PROVIDER=hash to make it explicit.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('\n✖ model fetch failed:', err instanceof Error ? err.message : err);
    console.error('  The system will run with hash embeddings and report itself as degraded.');
    // Non-zero so a CI step can notice, but the Dockerfile tolerates it.
    process.exit(1);
  });
