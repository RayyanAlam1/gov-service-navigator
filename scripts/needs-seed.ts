#!/usr/bin/env tsx
/**
 * Prints "yes" when the knowledge base is empty and should be seeded, "no"
 * otherwise. Used by the container entrypoint.
 *
 * Seeding is conditional rather than unconditional because `db:seed` upserts:
 * running it on every boot would quietly revert any row an operator had
 * corrected by hand — for example a fee they had verified and filled in.
 */
import './_env';

import { closeDb, sql } from '@/lib/db/client';

async function main(): Promise<void> {
  try {
    const rows = await sql<{ n: number }>('SELECT count(*)::int AS n FROM services');
    console.log((rows[0]?.n ?? 0) > 0 ? 'no' : 'yes');
  } catch {
    // No table, no connection, no schema — all mean "not ready", and the
    // migrate step that runs before this will have set the schema up.
    console.log('yes');
  }
}

main()
  .then(() => closeDb())
  .catch(async () => {
    console.log('yes');
    await closeDb().catch(() => undefined);
  });
