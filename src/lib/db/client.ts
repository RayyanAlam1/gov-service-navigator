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

  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DB_POOL_MAX,
    statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'gov-service-navigator',
  });

  pool.on('error', (err) => {
    logger().error({ err }, 'idle postgres client error');
  });

  return new PgDatabase(pool);
}

async function createPglite(): Promise<Database> {
  const cfg = getConfig();
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');

  // PGLITE_DATA_DIR=memory gives an in-process database that vanishes with the
  // run. Integration tests use it so they never touch a developer's working
  // database and never leave state behind between runs.
  const inMemory = cfg.PGLITE_DATA_DIR.trim().toLowerCase() === 'memory';

  const instance = await PGlite.create({
    ...(inMemory ? {} : { dataDir: cfg.PGLITE_DATA_DIR }),
    extensions: { vector },
  });

  return new PgliteDatabase(instance as unknown as PGliteLike);
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
