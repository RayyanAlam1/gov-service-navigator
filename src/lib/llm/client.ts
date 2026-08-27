/**
 * The single entry point for every model call in the system.
 *
 * Its signature is the architectural guardrail:
 *
 *     generateStructured(request, fallback)   // fallback is REQUIRED
 *
 * You cannot call the model without also having written the deterministic path
 * that runs when the model is unavailable. That is what makes the claim "if the
 * LLM provider went down and you swapped in a template renderer, the answers
 * would still be factually correct" a compile-time property rather than a
 * promise. It is also why there is no free-text completion helper here: an
 * unvalidated string would eventually reach a citizen as if it had been checked.
 *
 * Around that: a provider chain (DashScope → Groq → deterministic), a circuit
 * breaker per provider, a JSON repair pass, and a database-backed response
 * cache that makes a demo replay instantly and keeps an evaluation run inside
 * a free-tier quota.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { getConfig, llmProviderChain, type LlmProviderName } from '@/lib/config/env';
import { logger } from '@/lib/obs/logger';
import { getProvider } from './providers';
import {
  LlmError,
  LlmUnavailableError,
  type ChatMessage,
  type StructuredRequest,
  type StructuredResult,
} from './types';

/* ── Circuit breaker ──────────────────────────────────────────────────────
 * After N consecutive failures a provider is skipped for a cooldown window,
 * so a dead endpoint costs one timeout rather than one timeout per request.
 */

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const BREAKERS = Symbol.for('gsn.llm.breakers');
type GlobalWithBreakers = typeof globalThis & { [BREAKERS]?: Map<LlmProviderName, BreakerState> };

function breakers(): Map<LlmProviderName, BreakerState> {
  const g = globalThis as GlobalWithBreakers;
  g[BREAKERS] ??= new Map();
  return g[BREAKERS];
}

function breakerFor(name: LlmProviderName): BreakerState {
  const map = breakers();
  let state = map.get(name);
  if (!state) {
    state = { consecutiveFailures: 0, openUntil: 0 };
    map.set(name, state);
  }
  return state;
}

export function isBreakerOpen(name: LlmProviderName, now = Date.now()): boolean {
  return breakerFor(name).openUntil > now;
}

function recordSuccess(name: LlmProviderName): void {
  const state = breakerFor(name);
  state.consecutiveFailures = 0;
  state.openUntil = 0;
}

function recordFailure(name: LlmProviderName): void {
  const cfg = getConfig();
  const state = breakerFor(name);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= cfg.LLM_BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + cfg.LLM_BREAKER_COOLDOWN_MS;
    logger().warn(
      { provider: name, cooldownMs: cfg.LLM_BREAKER_COOLDOWN_MS },
      'llm circuit breaker opened',
    );
  }
}

export function breakerSnapshot() {
  const now = Date.now();
  return [...breakers().entries()].map(([provider, s]) => ({
    provider,
    open: s.openUntil > now,
    consecutiveFailures: s.consecutiveFailures,
    reopensInMs: s.openUntil > now ? s.openUntil - now : 0,
  }));
}

export function resetBreakersForTests(): void {
  (globalThis as GlobalWithBreakers)[BREAKERS] = new Map();
}

/* ── JSON extraction ──────────────────────────────────────────────────── */

/**
 * Pull a JSON object out of a model response.
 *
 * Even in JSON mode, models wrap output in ```json fences or prepend a
 * sentence often enough that not handling it means avoidable failures. Brace
 * matching is string-aware so a `}` inside a quoted Urdu string does not end
 * the object early.
 */
export function extractJson(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[{[]/);
  if (start === -1) return null;

  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; issues: string[] } {
  const json = extractJson(raw);
  if (json === null) return { ok: false, issues: ['response contained no JSON object'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, issues: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/* ── Cache ────────────────────────────────────────────────────────────── */

function cacheKey(request: StructuredRequest<unknown>, provider: string, model: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider,
        model,
        kind: request.kind,
        messages: request.messages,
        schema: request.jsonSchema,
        temperature: request.temperature ?? getConfig().LLM_TEMPERATURE,
      }),
    )
    .digest('hex');
}

async function readCache<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const { sqlOne } = await import('@/lib/db/client');
    const row = await sqlOne<{ response: unknown }>(
      `SELECT response FROM llm_cache
        WHERE cache_key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [key],
    );
    if (!row) return null;
    const parsed = schema.safeParse(row.response);
    if (!parsed.success) return null; // schema changed since caching; treat as miss
    void sqlOne('UPDATE llm_cache SET hits = hits + 1 WHERE cache_key = $1', [key]).catch(() => null);
    return parsed.data;
  } catch {
    // The cache is an optimisation. A database hiccup must not fail the call.
    return null;
  }
}

async function writeCache(
  key: string,
  provider: string,
  model: string,
  kind: string,
  data: unknown,
  promptTokens: number | null,
  outputTokens: number | null,
): Promise<void> {
  const cfg = getConfig();
  try {
    const { sql } = await import('@/lib/db/client');
    const ttl = cfg.LLM_CACHE_TTL_SECONDS;
    await sql(
      `INSERT INTO llm_cache (cache_key, provider, model, request_kind, response, prompt_tokens, output_tokens, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, ${ttl > 0 ? `NOW() + INTERVAL '${ttl} seconds'` : 'NULL'})
       ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, hits = llm_cache.hits + 1`,
      [key, provider, model, kind, JSON.stringify(data), promptTokens, outputTokens],
    );
  } catch (err) {
    logger().debug({ err }, 'llm cache write failed');
  }
}

/* ── Prompt assembly ──────────────────────────────────────────────────── */

/**
 * Append the schema contract to the system message.
 *
 * Carried in the prompt rather than relying on a provider's strict
 * `json_schema` mode, because support for that varies between DashScope and
 * Groq and between models within each. zod validates the result either way, so
 * the prompt-side contract is the portable half of a belt-and-braces approach.
 */
function withSchemaContract(messages: ChatMessage[], jsonSchema: Record<string, unknown>): ChatMessage[] {
  const contract = [
    'Respond with a single JSON object and nothing else. No prose, no markdown fences.',
    'The object must validate against this JSON Schema:',
    JSON.stringify(jsonSchema),
    'Every field marked required must be present. Do not add fields that are not in the schema.',
  ].join('\n');

  const out = [...messages];
  const firstSystem = out.findIndex((m) => m.role === 'system');
  if (firstSystem >= 0) {
    const existing = out[firstSystem];
    if (existing) out[firstSystem] = { role: 'system', content: `${existing.content}\n\n${contract}` };
  } else {
    out.unshift({ role: 'system', content: contract });
  }
  return out;
}

function repairMessages(
  original: ChatMessage[],
  badResponse: string,
  issues: readonly string[],
): ChatMessage[] {
  return [
    ...original,
    { role: 'assistant', content: badResponse.slice(0, 4000) },
    {
      role: 'user',
      content: [
        'That response did not validate. Problems:',
        ...issues.map((i) => `- ${i}`),
        'Return the corrected JSON object only.',
      ].join('\n'),
    },
  ];
}

/* ── Public API ───────────────────────────────────────────────────────── */

export interface GenerateOptions {
  /** Called with the reason whenever the deterministic fallback is used. */
  onFallback?: (reason: string) => void;
  signal?: AbortSignal;
}

/**
 * Run a structured generation.
 *
 * `fallback` is not optional. When no provider can serve the request — no
 * credentials, every breaker open, every attempt failed, or the model twice
 * produced something that does not validate — the fallback's value is returned
 * and reported with `provider: 'mock'`. Callers therefore never have to handle
 * an error path for "the model is down"; they have already written it.
 */
export async function generateStructured<T>(
  request: StructuredRequest<T>,
  fallback: () => T,
  options: GenerateOptions = {},
): Promise<StructuredResult<T>> {
  const cfg = getConfig();
  const log = logger();
  const started = Date.now();

  const tier = request.tier ?? 'primary';
  const temperature = request.temperature ?? cfg.LLM_TEMPERATURE;
  const maxTokens = request.maxTokens ?? cfg.LLM_MAX_OUTPUT_TOKENS;
  const messages = withSchemaContract(request.messages, request.jsonSchema);

  const chain = llmProviderChain().filter((name) => name !== 'mock');
  const attempted: Array<{ provider: LlmProviderName; reason: string }> = [];

  const deterministicResult = (reason: string): StructuredResult<T> => {
    options.onFallback?.(reason);
    log.info({ kind: request.kind, reason }, 'using deterministic fallback');
    return {
      data: fallback(),
      provider: 'mock',
      model: 'deterministic',
      cached: false,
      repaired: false,
      attempts: attempted.length,
      latencyMs: Date.now() - started,
      usage: { promptTokens: null, outputTokens: null },
    };
  };

  if (chain.length === 0) {
    return deterministicResult('no LLM provider is configured');
  }

  for (const name of chain) {
    if (isBreakerOpen(name)) {
      attempted.push({ provider: name, reason: 'circuit breaker open' });
      continue;
    }

    const provider = getProvider(name);
    if (!provider.isConfigured()) {
      attempted.push({ provider: name, reason: 'no usable credentials' });
      continue;
    }

    const model = provider.modelFor(tier);
    const key = cacheKey(request as StructuredRequest<unknown>, name, model);

    if (cfg.LLM_CACHE_ENABLED && !request.bypassCache) {
      const hit = await readCache(key, request.schema);
      if (hit !== null) {
        return {
          data: hit,
          provider: name,
          model,
          cached: true,
          repaired: false,
          attempts: attempted.length,
          latencyMs: Date.now() - started,
          usage: { promptTokens: null, outputTokens: null },
        };
      }
    }

    let currentMessages = messages;
    let repaired = false;

    for (let attempt = 0; attempt <= cfg.LLM_MAX_RETRIES; attempt += 1) {
      try {
        const completion = await provider.complete({
          messages: currentMessages,
          model,
          temperature,
          maxTokens,
          jsonMode: true,
          ...(options.signal ? { signal: options.signal } : {}),
        });

        const validated = parseAndValidate(completion.content, request.schema);

        if (validated.ok) {
          recordSuccess(name);
          if (cfg.LLM_CACHE_ENABLED && !request.bypassCache) {
            void writeCache(
              key,
              name,
              model,
              request.kind,
              validated.data,
              completion.usage.promptTokens,
              completion.usage.outputTokens,
            );
          }
          return {
            data: validated.data,
            provider: name,
            model: completion.model,
            cached: false,
            repaired,
            attempts: attempted.length + attempt + 1,
            latencyMs: Date.now() - started,
            usage: completion.usage,
          };
        }

        // Shape failure. One repair round-trip, then move on: a model that
        // cannot satisfy the schema twice will not satisfy it a third time,
        // and the deterministic path is right there.
        log.warn(
          { kind: request.kind, provider: name, issues: validated.issues.slice(0, 4) },
          'structured output failed validation',
        );
        if (attempt < cfg.LLM_MAX_RETRIES) {
          currentMessages = repairMessages(messages, completion.content, validated.issues);
          repaired = true;
          continue;
        }
        attempted.push({ provider: name, reason: `schema validation failed: ${validated.issues[0] ?? 'unknown'}` });
        recordFailure(name);
        break;
      } catch (err) {
        const llmErr = err instanceof LlmError ? err : null;
        const reason = err instanceof Error ? err.message : String(err);

        if (llmErr && !llmErr.retryable) {
          attempted.push({ provider: name, reason });
          recordFailure(name);
          break;
        }
        if (attempt >= cfg.LLM_MAX_RETRIES) {
          attempted.push({ provider: name, reason });
          recordFailure(name);
          break;
        }
        // Exponential backoff with jitter, capped so a retry never outlives
        // the request the citizen is waiting on.
        const backoff = Math.min(2_000, 200 * 2 ** attempt) + Math.random() * 150;
        await sleep(backoff);
      }
    }
  }

  return deterministicResult(
    attempted.length > 0
      ? `all providers failed (${attempted.map((a) => `${a.provider}: ${a.reason}`).join('; ')})`
      : 'no provider attempted',
  );
}

/**
 * Strict variant for the evaluation harness, where silently falling back to
 * templates would inflate the measured quality of the live pipeline.
 */
export async function generateStructuredStrict<T>(
  request: StructuredRequest<T>,
  options: GenerateOptions = {},
): Promise<StructuredResult<T>> {
  const attempted: Array<{ provider: LlmProviderName; reason: string }> = [];
  const result = await generateStructured(
    request,
    () => {
      throw new LlmUnavailableError(`no provider could serve ${request.kind}`, attempted);
    },
    options,
  );
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
