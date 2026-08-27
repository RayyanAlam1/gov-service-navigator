#!/usr/bin/env tsx
/**
 * npm run db:seed                 upsert the knowledge base and index the corpus
 * npm run db:seed -- --fresh      delete existing knowledge rows first
 * npm run db:seed -- --no-embed   skip embedding (fast structural check)
 *
 * Thin CLI over db/seed/run.ts, which is also what the integration tests call —
 * so tests exercise the real knowledge base rather than a fixture that drifts.
 */
import './_env';

import { closeDb } from '@/lib/db/client';
import { runSeed } from '../db/seed/run';

const args = new Set(process.argv.slice(2));

runSeed({
  fresh: args.has('--fresh'),
  skipEmbed: args.has('--no-embed'),
  log: (message) => console.log(message),
})
  .then(() => {
    console.log('\n▸ seed complete. Every fact carries a source; unverified fees stay NULL.');
    console.log('  Run `npm run doctor` for a full provenance report.\n');
  })
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('\n✖ seed failed\n');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
