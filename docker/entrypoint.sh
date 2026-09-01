#!/bin/sh
set -e

# Container entrypoint.
#
# Waits for the database, applies migrations, seeds the knowledge base if it is
# empty, then hands off to the server. All three steps are idempotent, so a
# restart is safe and a redeploy against an existing volume does not wipe data.
#
# Seeding is conditional rather than unconditional: `db:seed` upserts, so
# re-running it would quietly revert any row an operator had corrected by hand.

DB_DRIVER="${DB_DRIVER:-pg}"

wait_for_postgres() {
  echo "▸ waiting for postgres…"
  attempt=0
  until node -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
  " 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "✖ postgres did not become available after 60 attempts" >&2
      exit 1
    fi
    sleep 2
  done
  echo "  ✓ postgres reachable"
}

if [ "$DB_DRIVER" = "pg" ]; then
  wait_for_postgres
fi

echo "▸ applying migrations…"
node ./node_modules/tsx/dist/cli.mjs scripts/migrate.ts

# Only seed when the knowledge base is genuinely empty.
NEEDS_SEED=$(node ./node_modules/tsx/dist/cli.mjs scripts/needs-seed.ts 2>/dev/null | tail -n 1)

if [ "$NEEDS_SEED" = "yes" ]; then
  echo "▸ seeding knowledge base…"
  node ./node_modules/tsx/dist/cli.mjs scripts/seed.ts
else
  echo "▸ knowledge base already populated; skipping seed"
fi

echo "▸ starting server on port ${PORT:-3000}"
exec "$@"
