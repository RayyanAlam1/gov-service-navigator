#!/usr/bin/env tsx
/**
 * npm run db:unlock            clear a stale embedded-database lock
 * npm run db:unlock -- --reset delete and recreate the database directory
 *
 * PGlite is single-process and takes a lock on its data directory. If the
 * owning process is killed abruptly — Ctrl+C at the wrong moment, an editor
 * restarting the dev server, a crashed terminal — two things can happen:
 *
 *   1. The lock files survive. `--unlock` alone fixes this.
 *   2. The data directory itself is left inconsistent, because the kill landed
 *      mid-write. Then even an unlocked directory fails to open, and the only
 *      fix is to recreate it. That is what `--reset` is for.
 *
 * Recreating is cheap and safe here: the knowledge base is generated from
 * `db/` by `npm run db:seed`, so the source of truth is in the repository. The
 * only thing genuinely lost is in-flight citizen sessions, which are demo state.
 *
 * The lock is deliberately NOT cleared automatically on startup. PGlite writes
 * a synthetic pid (`-42`), so an abandoned lock cannot be told from a live one
 * by inspection — and the lock file is the only thing preventing two processes
 * from opening the same database at once. Clearing it silently would remove the
 * mutex to make an error message go away.
 */
import './_env';

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '@/lib/config/env';

const LOCK_FILES = ['postmaster.pid', '.s.PGSQL.5432.lock', '.s.PGSQL.5432.lock.out'];
const reset = process.argv.slice(2).includes('--reset');

function main(): void {
  const cfg = getConfig();

  if (cfg.DB_DRIVER !== 'pglite') {
    console.log(`▸ DB_DRIVER=${cfg.DB_DRIVER}; there is no embedded lock to clear.`);
    return;
  }

  const dir = path.resolve(process.cwd(), cfg.PGLITE_DATA_DIR);

  if (!existsSync(dir)) {
    console.log(`▸ No embedded database at ${cfg.PGLITE_DATA_DIR}. Nothing to unlock.`);
    return;
  }

  if (reset) {
    console.log(`▸ --reset: deleting ${cfg.PGLITE_DATA_DIR} entirely.`);
    console.log('  The knowledge base is regenerated from db/ — only citizen sessions are lost.\n');
    rmSync(dir, { recursive: true, force: true });
    console.log(`  ✓ removed ${cfg.PGLITE_DATA_DIR}\n`);
    console.log('▸ Rebuild it with:\n');
    console.log('    npm run db:migrate && npm run db:seed\n');
    return;
  }

  const present = LOCK_FILES.filter((name) => existsSync(path.join(dir, name)));

  if (present.length === 0) {
    console.log(`▸ ${cfg.PGLITE_DATA_DIR} has no lock files.`);
    console.log(
      '  If it still fails to open, the directory was damaged by an abrupt kill\n' +
        '  (the process died mid-write). Recreate it:\n\n' +
        '    npm run db:unlock -- --reset\n' +
        '    npm run db:migrate && npm run db:seed\n',
    );
    return;
  }

  const pidFile = path.join(dir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    const recorded = readFileSync(pidFile, 'utf8').split('\n')[0]?.trim();
    console.log(`▸ Found a lock recording pid ${recorded ?? '(unknown)'}.`);
    console.log(
      '  PGlite writes a synthetic pid, so this cannot be checked against a running process.',
    );
  }

  console.log('\n  \x1b[33mMake sure nothing else is using this database\x1b[0m — in particular,');
  console.log('  that `npm run dev` is not running in another terminal.\n');

  for (const name of present) {
    rmSync(path.join(dir, name), { force: true });
    console.log(`  ✓ removed ${name}`);
  }

  console.log(`\n▸ Lock cleared. ${cfg.PGLITE_DATA_DIR} should now open.`);
  console.log('  Your data is untouched — only the lock files were removed.\n');
  console.log(
    '  If it still fails, the directory was damaged by the same abrupt kill that\n' +
      '  left the lock behind. Recreate it:\n\n' +
      '    npm run db:unlock -- --reset\n' +
      '    npm run db:migrate && npm run db:seed\n',
  );
}

try {
  main();
} catch (err) {
  console.error('✖ unlock failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
