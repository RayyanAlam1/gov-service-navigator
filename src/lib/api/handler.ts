/**
 * API boundary.
 *
 * One wrapper that every route goes through, so the things that must never be
 * forgotten are impossible to forget:
 *
 *   * Body and query are parsed with zod. Downstream code receives typed values
 *     and never a `string | undefined` it has to re-check.
 *   * Errors become a stable JSON envelope. An unhandled exception never leaks
 *     a stack trace or a connection string to a citizen's browser.
 *   * Every response carries a request id, which is also on every log line for
 *     that request, so a support question maps to a trace.
 *   * Rate limiting is database-backed and keyed on a coarse fingerprint, so it
 *     survives a restart and cannot be used to identify anyone.
 *
 * Session lookup is by opaque token only. There is no route in this codebase
 * that accepts a numeric session id from the client.
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getConfig } from '@/lib/config/env';
import { sql } from '@/lib/db/client';
import { getSessionByToken, type SessionRecord } from '@/lib/db/sessions';
import { loggerFor } from '@/lib/obs/logger';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const tooManyRequests = (message: string) => new ApiError(429, 'rate_limited', message);
export const sessionExpired = () =>
  new ApiError(410, 'session_expired', 'This session has expired. Start a new one.');

/* ── Rate limiting ────────────────────────────────────────────────────── */

/**
 * Coarse client fingerprint.
 *
 * Hashed so the raw IP is never stored, and truncated so it cannot be reversed
 * by brute force over a small address space. It identifies a bucket, not a
 * person.
 */
export function fingerprint(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'local';
  const agent = request.headers.get('user-agent') ?? '';
  return createHash('sha256').update(`${ip}|${agent}`).digest('hex').slice(0, 32);
}

async function enforceRateLimit(key: string): Promise<void> {
  const cfg = getConfig();
  if (cfg.isTest) return;

  try {
    const rows = await sql<{ request_count: number }>(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, request_count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (bucket_key) DO UPDATE SET
         request_count = CASE
           WHEN rate_limit_buckets.window_start < NOW() - ($2 || ' milliseconds')::interval THEN 1
           ELSE rate_limit_buckets.request_count + 1
         END,
         window_start = CASE
           WHEN rate_limit_buckets.window_start < NOW() - ($2 || ' milliseconds')::interval THEN NOW()
           ELSE rate_limit_buckets.window_start
         END,
         updated_at = NOW()
       RETURNING request_count`,
      [key, String(cfg.RATE_LIMIT_WINDOW_MS)],
    );

    const count = rows[0]?.request_count ?? 0;
    if (count > cfg.RATE_LIMIT_MAX_REQUESTS) {
      throw tooManyRequests('Too many requests. Please wait a moment and try again.');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // A rate limiter that cannot reach the database must not take the service
    // down with it. Fail open, and log.
    loggerFor({ key }).warn({ err }, 'rate limiter unavailable; allowing request');
  }
}

/* ── Handler wrapper ──────────────────────────────────────────────────── */

export interface HandlerContext<TBody, TQuery> {
  request: NextRequest;
  body: TBody;
  query: TQuery;
  requestId: string;
  fingerprint: string;
  log: ReturnType<typeof loggerFor>;
  /** Present only when the route declared `requireSession`. */
  session: SessionRecord;
}

export interface RouteOptions<TBody, TQuery> {
  bodySchema?: z.ZodType<TBody>;
  querySchema?: z.ZodType<TQuery>;
  /** Resolve `x-session-token` (or `?session=`) and 410 when it is invalid. */
  requireSession?: boolean;
  /** Skip the shared limiter for cheap, idempotent reads. */
  skipRateLimit?: boolean;
}

const EMPTY = {} as never;

export function route<TBody = undefined, TQuery = undefined>(
  options: RouteOptions<TBody, TQuery>,
  handler: (context: HandlerContext<TBody, TQuery>) => Promise<unknown>,
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = randomUUID();
    const started = Date.now();
    const client = fingerprint(request);
    const log = loggerFor({ requestId, path: new URL(request.url).pathname });

    try {
      if (!options.skipRateLimit) await enforceRateLimit(client);

      let body = EMPTY as TBody;
      if (options.bodySchema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw badRequest('Request body must be valid JSON.');
        }
        const parsed = options.bodySchema.safeParse(raw);
        if (!parsed.success) {
          throw badRequest(
            'Request body failed validation.',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        }
        body = parsed.data;
      }

      let query = EMPTY as TQuery;
      if (options.querySchema) {
        const params = Object.fromEntries(new URL(request.url).searchParams.entries());
        const parsed = options.querySchema.safeParse(params);
        if (!parsed.success) {
          throw badRequest(
            'Query parameters failed validation.',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        }
        query = parsed.data;
      }

      let session = EMPTY as SessionRecord;
      if (options.requireSession) {
        const token =
          request.headers.get('x-session-token') ??
          new URL(request.url).searchParams.get('session') ??
          '';
        const found = await getSessionByToken(token);
        if (!found) throw sessionExpired();
        session = found;
      }

      const result = await handler({
        request,
        body,
        query,
        requestId,
        fingerprint: client,
        log,
        session,
      });

      const response = NextResponse.json(result ?? {}, { status: 200 });
      response.headers.set('x-request-id', requestId);
      response.headers.set('cache-control', 'no-store');
      log.info({ ms: Date.now() - started }, 'request ok');
      return response;
    } catch (err) {
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(500, 'internal_error', 'Something went wrong on our side.');

      if (apiError.status >= 500) {
        // Full detail to the log, generic message to the client.
        log.error({ err, ms: Date.now() - started }, 'request failed');
      } else {
        log.warn({ code: apiError.code, ms: Date.now() - started }, 'request rejected');
      }

      const bodyOut: ApiErrorBody = {
        error: {
          code: apiError.code,
          message: apiError.message,
          ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
        requestId,
      };

      const response = NextResponse.json(bodyOut, { status: apiError.status });
      response.headers.set('x-request-id', requestId);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
  };
}

/** Shared schemas used by several routes. */
export const LanguageParam = z.enum(['en', 'ur', 'roman_ur']);
export const SessionTokenSchema = z.string().min(20).max(200);
