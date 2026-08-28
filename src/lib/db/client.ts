/**
 * Database access.
 *
 * Two drivers behind one interface:
 *
 *   pg      — real PostgreSQL 16 + pgvector. Production, docker compose, CI.
 *   pglite  — PostgreSQL 16 compiled to WASM, running in-process against a
 *             directory on disk. Same SQL dialect, same migrations, same
 *             seeds. This exists because a live demo must not be one Docker
 *             daemon away from failing, and because CI should not need a
 *             service container to run integration tests.
 *
 * The interface is deliberately tiny — `query` and `transaction`. There is no
 * ORM. Every statement in this codebase is SQL you can read, copy into psql,
 * and explain to a judge. For a system whose whole value proposition is "you
 * can check where this fact came from", an opaque query builder would be
 * working against the product.
 */
import type { Pool as PgPool, PoolClient as PgPoolClient } from 'pg';
import { getConfig } from '@/lib/config/env';
import { logger } from '@/lib/obs/logger';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pg' | 'pglite';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* node-postgres driver                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

class PgDatabase implements Database {
  readonly driver = 'pg' as const;

  constructor(private readonly pool: PgPool) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const res = await this.pool.query(text, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PgPoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const executor: SqlExecutor = {
        query: async <R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) => {
          const res = await client.query(text, params as unknown[]);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
        },
      };
      const out = await fn(executor);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection is already unusable; the original error is what matters */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* PGlite driver                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  close(): Promise<void>;
}

class PgliteDatabase implements Database {
  readonly driver = 'pglite' as const;

  /**
   * PGlite is single-connection. Concurrent statements on one instance
   * interleave badly and a `BEGIN` from one caller would wrap another
   * caller's statements. Serialising through a promise chain is not a
   * performance concern at demo scale and removes a whole class of
   * heisenbug.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGliteLike) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async raw<T>(text: string, params: readonly unknown[]): Promise<QueryResult<T>> {
    const res = await this.db.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.serialize(() => this.raw<T>(text, params));
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      // Inside the serialized slot the executor bypasses `serialize` so the
      // transaction's own statements are not re-queued behind itself.
      const executor: SqlExecutor = {
        query: <R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) =>
          this.raw<R>(text, params),
      };
      await this.db.query('BEGIN');
      try {
        const out = await fn(executor);
        await this.db.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await this.db.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Construction                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function createPg(): Promise<Database> {
  const cfg = getConfig();
  const { Pool, types } = await import('pg');

  // BIGINT (OID 20) arrives as a string by default because it can exceed
  // Number.MAX_SAFE_INTEGER. Every bigint in this schema is a surrogate key
  // that will not approach 2^53, and the alternative is string/number
  // confusion at every join. Parse it as a number, deliberately.
  types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
  // NUMERIC (1700) -> number, for fee amounts and scores.
  types.setTypeParser(1700, (v: string) => Number.parseFloat(v));

  assertDatabaseUrlConfigured(cfg.DATABASE_URL);

  const tuning = poolTuning(cfg.DATABASE_URL, cfg.DB_POOL_MAX);

  const pool = new Pool({
    // `sslmode` is stripped when we set `ssl` ourselves — see stripSslMode().
    connectionString: tuning.ssl ? stripSslMode(cfg.DATABASE_URL) : cfg.DATABASE_URL,
    ...tuning,
    statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'gov-service-navigator',
  });

  pool.on('error', (err) => {
    logger().error({ err }, 'idle postgres client error');
  });

  return new PgDatabase(pool);
}

/** True when the process is a short-lived serverless invocation. */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Refuse to attempt a connection that cannot possibly succeed.
 *
 * `DATABASE_URL` has a localhost default so the project runs out of the box on
 * a developer's machine. In a serverless container there is no localhost
 * Postgres, so an unset variable surfaces as `ECONNREFUSED 127.0.0.1:5432` —
 * which reads like a database outage rather than what it is: a missing
 * environment variable.
 *
 * Naming the actual cause turns a confusing production incident into a
 * one-line fix.
 */
function assertDatabaseUrlConfigured(connectionString: string): void {
  if (!isServerless()) return;

  let host = '';
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    return; // malformed: let pg produce its own parse error
  }

  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return;

  throw new Error(
    `DATABASE_URL is not set in this deployment.\n\n` +
      `The connection string fell back to its localhost default (${host}:5432), ` +
      `and a serverless container has no local database.\n\n` +
      `Set DATABASE_URL in your hosting provider's environment variables, then ` +
      `REDEPLOY — environment changes do not apply to deployments that already ` +
      `exist. On Vercel: Settings → Environment Variables → add it for ` +
      `Production → Deployments → Redeploy.`,
  );
}

/**
 * Remove `sslmode` from a connection string when TLS is configured explicitly.
 *
 * Managed providers hand out URLs ending `?sslmode=require`. node-postgres
 * currently treats `require` as `verify-full`, warns loudly that this will
 * change to weaker libpq semantics in pg 9, and then ignores it anyway because
 * an explicit `ssl` option takes precedence.
 *
 * So the parameter is doing nothing except printing a deprecation notice on
 * every command and setting up a silent behaviour change on a future upgrade.
 * Dropping it makes the TLS configuration single-sourced: it comes from
 * `poolTuning`, nowhere else.
 *
 * Everything else in the query string — `channel_binding`, `options`, and any
 * provider-specific parameters — is preserved untouched.
 */
export function stripSslMode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (!url.searchParams.has('sslmode')) return connectionString;
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    // Not a parseable URL: hand it back unchanged and let pg report the problem.
    return connectionString;
  }
}

/**
 * Connection settings that differ between a long-lived server and a serverless
 * function, and between a local and a managed database.
 *
 * Two things go wrong if this is left at the defaults:
 *
 *   * **Connection exhaustion.** Every warm serverless instance holds its own
 *     pool. Ten connections each against a free-tier database that allows a few
 *     dozen total means a handful of concurrent instances take the database
 *     down. Serverless wants a pool of one, plus a pooling proxy in front
 *     (Neon's `-pooler` host, Supabase's port 6543).
 *
 *   * **TLS refusal.** Managed Postgres requires SSL. node-postgres does not
 *     reliably infer that from `sslmode=` in every version, so it is set
 *     explicitly for any non-local host.
 */
function poolTuning(
  connectionString: string,
  configuredMax: number,
): { max: number; idleTimeoutMillis: number; connectionTimeoutMillis: number; ssl?: { rejectUnauthorized: boolean } } {
  let host = '';
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    /* malformed URL: fall through to local defaults and let pg report it */
  }

  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'db' || host === '';

  const serverless = isServerless();

  return {
    // One connection per instance under serverless; the platform scales by
    // adding instances, not by widening a pool.
    max: serverless ? 1 : configuredMax,
    // Managed databases idle-timeout aggressively and scale to zero. Holding a
    // dead socket costs a failed first query on the next request.
    idleTimeoutMillis: serverless ? 10_000 : 30_000,
    // A scaled-to-zero database has to cold-start before it can accept a
    // connection, which takes longer than a warm local one.
    connectionTimeoutMillis: isLocal ? 10_000 : 20_000,
    // TLS is always on for a remote host. Whether the certificate chain is
    // *verified* is configurable, because providers differ and a refused
    // connection is a worse failure than an unverified one for an MVP.
    ...(isLocal
      ? {}
      : { ssl: { rejectUnauthorized: getConfig().DB_SSL_REJECT_UNAUTHORIZED } }),
  };
}

async function createPglite(): Promise<Database> {
  const cfg = getConfig();
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');

  // PGLITE_DATA_DIR=memory gives an in-process database that vanishes with the
  // run. Integration tests use it so they never touch a developer's working
  // database and never leave state behind between runs.
  const inMemory = cfg.PGLITE_DATA_DIR.trim().toLowerCase() === 'memory';

  try {
    const instance = await PGlite.create({
      ...(inMemory ? {} : { dataDir: cfg.PGLITE_DATA_DIR }),
      extensions: { vector },
    });
    return new PgliteDatabase(instance as unknown as PGliteLike);
  } catch (err) {
    // PGlite is single-process: a second process opening the same data
    // directory aborts inside WASM with "Aborted()", which tells you nothing.
    // Running `npm run doctor` while `npm run dev` is up hits this every time.
    if (!inMemory) {
      throw new Error(
        `Could not open the embedded database at "${cfg.PGLITE_DATA_DIR}".\n\n` +
          `PGlite allows one process at a time, so this usually means another\n` +
          `process — most often \`npm run dev\` — already has it open. Stop that\n` +
          `process and try again.\n\n` +
          `If nothing else is running, the lock is stale: a previous process was\n` +
          `killed before it could release it. Clear it with:\n\n` +
          `    npm run db:unlock\n\n` +
          `Or point this command at a throwaway database instead:\n\n` +
          `    PGLITE_DATA_DIR=memory npm run <command>\n\n` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
}

/**
 * Next.js dev-mode module reloading would otherwise create a new pool on every
 * hot reload until the database refuses connections.
 */
const globalKey = Symbol.for('gsn.database');
type GlobalWithDb = typeof globalThis & { [globalKey]?: Promise<Database> };

export function getDb(): Promise<Database> {
  const g = globalThis as GlobalWithDb;
  if (!g[globalKey]) {
    const driver = getConfig().DB_DRIVER;
    logger().debug({ driver }, 'initialising database');
    g[globalKey] = (driver === 'pglite' ? createPglite() : createPg()).catch((err) => {
      // Do not cache a failed connection: the next request should retry rather
      // than inherit a permanently rejected promise.
      delete g[globalKey];
      throw err;
    });
  }
  return g[globalKey];
}

export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const pending = g[globalKey];
  if (!pending) return;
  delete g[globalKey];
  const db = await pending.catch(() => null);
  await db?.close();
}

/** Convenience wrapper: `const rows = await sql<Row>('SELECT ...', [a, b])`. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(text, params);
  return res.rows;
}

/** Single-row variant. Returns null rather than throwing on empty. */
export async function sqlOne<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

/** pgvector wire format for a parameterised value: '[0.1,0.2,...]'. */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}
