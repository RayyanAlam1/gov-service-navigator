/**
 * Migration runner.
 *
 * Plain numbered .sql files, applied in order, recorded in `schema_migrations`
 * with a checksum. No migration framework: the whole point of this project is
 * that a judge can read the SQL and see where a fact lives, and a hand-rolled
 * 150-line runner keeps that property.
 *
 * Three behaviours worth knowing about:
 *
 *   1. `${EMBEDDING_DIM}` in a .sql file is substituted at apply time, and the
 *      width actually used is written to `system_meta`. assertEmbeddingDim()
 *      then refuses to serve traffic if the running config disagrees with what
 *      is in the database — a dimension mismatch otherwise fails silently as
 *      "retrieval got worse", which is the worst kind of bug to debug live.
 *
 *   2. A statement preceded by `-- @optional` may fail without failing the
 *      migration. Used for ANN indexes that real pgvector supports and the
 *      embedded PGlite driver may not; degrading to a sequential scan at demo
 *      corpus size is correct behaviour, not a broken install.
 *
 *   3. Checksums are advisory. If an already-applied file changes, the runner
 *      warns loudly rather than refusing to start, because a blocked start on
 *      demo day is worse than a stale checksum.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '@/lib/config/env';
import { getDb, type Database, type SqlExecutor } from '@/lib/db/client';
import { logger } from '@/lib/obs/logger';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations');

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
  warnings: string[];
  embeddingDim: number;
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS system_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Split a .sql file into executable statements.
 *
 * Naive `split(';')` breaks on `DO $$ ... $$` blocks, which this schema uses
 * for enum creation and trigger generation. This tracks dollar-quoted strings,
 * single quotes and line comments so those survive intact.
 */
export function splitStatements(sql: string): Array<{ text: string; optional: boolean }> {
  const out: Array<{ text: string; optional: boolean }> = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  const push = () => {
    const text = buf.trim();
    buf = '';
    if (!text || /^(--|\/\*)/.test(text) && !/[a-z]/i.test(text.replace(/--.*$/gm, ''))) return;
    if (text.replace(/--[^\n]*/g, '').trim() === '') return;
    // `-- @optional` anywhere in the statement's leading comments marks it.
    const optional = /--\s*@optional\b/i.test(text);
    out.push({ text, optional });
  };

  while (i < sql.length) {
    const ch = sql[i] ?? '';
    const next2 = sql.slice(i, i + 2);

    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (next2 === '*/') {
        buf += sql[i + 1] ?? '';
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        // '' is an escaped quote, not a terminator.
        if (sql[i + 1] === "'") {
          buf += "'";
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (next2 === '--') {
      inLineComment = true;
      buf += next2;
      i += 2;
      continue;
    }
    if (next2 === '/*') {
      inBlockComment = true;
      buf += next2;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag?.[0]) {
        dollarTag = tag[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      push();
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  push();
  return out;
}

async function readMigrationFiles(): Promise<Array<{ name: string; sql: string }>> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATIONS_DIR, name), 'utf8'),
    })),
  );
}

function substitute(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** Every table this schema owns, in dependency-safe drop order. */
const DROP_ORDER = [
  'eval_results', 'eval_runs', 'guardrail_events', 'agent_traces', 'rate_limit_buckets',
  'document_checks', 'session_plans', 'session_answers', 'sessions',
  'llm_cache', 'embedding_cache', 'document_chunks', 'documents',
  'exception_routes', 'office_services', 'offices', 'processing_times', 'fees',
  'procedure_steps', 'requirements', 'eligibility_rules', 'decision_variables',
  'service_aliases', 'service_scenarios', 'services', 'departments', 'sources',
  'schema_migrations', 'system_meta',
];

const DROP_TYPES = [
  'document_match_status', 'variable_type', 'session_status',
  'readiness_state', 'service_channel', 'language_code', 'verification_status',
];

export async function resetSchema(db: Database): Promise<void> {
  const log = logger();
  log.warn('resetting schema: dropping all application tables and types');
  for (const table of DROP_ORDER) {
    await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`).catch(() => undefined);
  }
  for (const type of DROP_TYPES) {
    await db.query(`DROP TYPE IF EXISTS ${type} CASCADE`).catch(() => undefined);
  }
  await db.query('DROP FUNCTION IF EXISTS set_updated_at() CASCADE').catch(() => undefined);
}

export async function runMigrations(opts: { reset?: boolean } = {}): Promise<MigrationOutcome> {
  const cfg = getConfig();
  const log = logger();
  const db = await getDb();

  if (opts.reset) await resetSchema(db);

  for (const stmt of splitStatements(BOOTSTRAP_SQL)) {
    await db.query(stmt.text);
  }

  const applied = new Set(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  const checksums = new Map(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
      (r) => [r.name, r.checksum] as const,
    ),
  );

  const outcome: MigrationOutcome = {
    applied: [],
    skipped: [],
    warnings: [],
    embeddingDim: cfg.EMBEDDING_DIM,
  };

  const files = await readMigrationFiles();
  const vars = { EMBEDDING_DIM: String(cfg.EMBEDDING_DIM) };

  for (const file of files) {
    const rendered = substitute(file.sql, vars);
    const checksum = createHash('sha256').update(rendered).digest('hex').slice(0, 16);

    if (applied.has(file.name)) {
      if (checksums.get(file.name) !== checksum) {
        const msg =
          `${file.name} has changed since it was applied. The database was NOT altered. ` +
          `Run \`npm run db:migrate -- --reset\` if the change is structural.`;
        outcome.warnings.push(msg);
        log.warn({ migration: file.name }, msg);
      }
      outcome.skipped.push(file.name);
      continue;
    }

    const started = Date.now();
    const statements = splitStatements(rendered);

    // Each migration file is one transaction: a half-applied schema is far
    // harder to recover from than a clean failure.
    await db.transaction(async (tx: SqlExecutor) => {
      for (const stmt of statements) {
        try {
          await tx.query(stmt.text);
        } catch (err) {
          if (stmt.optional) {
            const detail = err instanceof Error ? err.message : String(err);
            const msg = `${file.name}: optional statement skipped (${detail.split('\n')[0]})`;
            outcome.warnings.push(msg);
            log.warn({ migration: file.name }, msg);
            continue;
          }
          throw new Error(
            `Migration ${file.name} failed on statement:\n${stmt.text.slice(0, 400)}\n\n${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      await tx.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file.name, checksum, Date.now() - started],
      );
    });

    outcome.applied.push(file.name);
    log.info({ migration: file.name, ms: Date.now() - started }, 'migration applied');
  }

  await db.query(
    `INSERT INTO system_meta (key, value) VALUES ('embedding_dim', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(cfg.EMBEDDING_DIM)],
  );

  return outcome;
}

/**
 * Refuse to serve traffic when the configured embedding width disagrees with
 * the width the vector columns were created at. Called from /api/health and
 * from the ingest/reindex scripts.
 */
export async function assertEmbeddingDim(): Promise<void> {
  const cfg = getConfig();
  const db = await getDb();
  const row = (
    await db.query<{ value: string }>("SELECT value FROM system_meta WHERE key = 'embedding_dim'")
  ).rows[0];

  if (!row) return; // pre-migration; runMigrations will set it

  const stored = Number.parseInt(row.value, 10);
  if (stored !== cfg.EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: the database was migrated with vector(${stored}) but ` +
        `EMBEDDING_DIM is ${cfg.EMBEDDING_DIM}. Either set EMBEDDING_DIM=${stored}, or run ` +
        `\`npm run db:migrate -- --reset && npm run db:seed\` to rebuild at the new width.`,
    );
  }
}
