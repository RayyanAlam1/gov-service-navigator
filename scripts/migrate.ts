#!/usr/bin/env tsx
/**
 * npm run db:migrate              apply pending migrations
 * npm run db:migrate -- --reset   drop everything first, then apply
 * npm run db:migrate -- --status  report without changing anything
 *
 * Import order matters: `_env` loads .env files as a side effect and must be
 * evaluated before anything reads configuration. Everything downstream reads
 * config lazily (see lib/config/env.ts), so a plain static import is enough.
 */
import './_env';

import { getConfig } from '@/lib/config/env';
import { closeDb, getDb } from '@/lib/db/client';
import { runMigrations } from '@/lib/db/migrate';

const args = new Set(process.argv.slice(2));
const reset = args.has('--reset');
const statusOnly = args.has('--status');

async function main(): Promise<void> {
  const cfg = getConfig();
  console.log(`▸ driver=${cfg.DB_DRIVER}  embedding_dim=${cfg.EMBEDDING_DIM}`);

  if (statusOnly) {
    const db = await getDb();
    const rows = (
      await db.query<{ name: string; applied_at: string }>(
        'SELECT name, applied_at FROM schema_migrations ORDER BY name',
      )
    ).rows;
    if (rows.length === 0) console.log('  no migrations applied');
    for (const r of rows) console.log(`  ✓ ${r.name}  ${new Date(r.applied_at).toISOString()}`);
    return;
  }

  if (reset) console.log('▸ --reset: dropping existing schema');

  const outcome = await runMigrations({ reset });

  for (const name of outcome.applied) console.log(`  ✓ applied  ${name}`);
  for (const name of outcome.skipped) console.log(`  · already   ${name}`);
  for (const w of outcome.warnings) console.log(`  ! ${w}`);

  console.log(
    outcome.applied.length > 0
      ? `▸ ${outcome.applied.length} migration(s) applied.`
      : '▸ schema already up to date.',
  );
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('\n✖ migration failed\n');
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
