/**
 * API key pool.
 *
 * The deployment reality this exists for: free-tier keys, several of them,
 * pooled from whoever on the team has an account, each with its own low rate
 * limit. One key is not enough to get through an evaluation run of 50
 * scenarios, let alone a live demo where a judge asks three questions in a row.
 *
 * Behaviour:
 *   * Round-robin across healthy keys, so load spreads instead of hammering
 *     the first key until it 429s.
 *   * On HTTP 429, cool that key until `retry-after` (or a backoff) elapses
 *     and immediately try the next one — the request survives.
 *   * On HTTP 401/403, retire the key permanently. A revoked key that keeps
 *     getting retried turns every request into a slow failure.
 *   * Rate-limit headers are read on success too, so a key that is about to
 *     run out is deprioritised before it actually fails.
 *
 * Keys are never logged. `fingerprint` is a short hash used in traces so an
 * operator can tell two keys apart without either being recoverable.
 */
import { createHash } from 'node:crypto';
import type { LlmProviderName } from '@/lib/config/env';

export interface KeyState {
  key: string;
  fingerprint: string;
  /** Epoch ms until which this key must not be used. */
  cooldownUntil: number;
  /** Permanently unusable (401/403). */
  retired: boolean;
  retiredReason: string | null;
  successes: number;
  failures: number;
  /** Parsed from x-ratelimit-remaining-requests when the provider sends it. */
  remainingRequests: number | null;
}

export interface KeyLease {
  key: string;
  fingerprint: string;
}

export interface PoolSnapshot {
  provider: LlmProviderName;
  total: number;
  available: number;
  cooling: number;
  retired: number;
  keys: Array<Omit<KeyState, 'key'>>;
}

const DEFAULT_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 120_000;

export class KeyPool {
  private readonly states: KeyState[];
  private cursor = 0;

  constructor(
    readonly provider: LlmProviderName,
    keys: readonly string[],
  ) {
    this.states = keys.map((key) => ({
      key,
      fingerprint: fingerprintOf(key),
      cooldownUntil: 0,
      retired: false,
      retiredReason: null,
      successes: 0,
      failures: 0,
      remainingRequests: null,
    }));
  }

  get size(): number {
    return this.states.length;
  }

  /** Keys usable right now. */
  availableCount(now: number = Date.now()): number {
    return this.states.filter((s) => !s.retired && s.cooldownUntil <= now).length;
  }

  /** True when at least one key exists that is not permanently retired. */
  hasUsableKeys(): boolean {
    return this.states.some((s) => !s.retired);
  }

  /**
   * Take the next healthy key.
   *
   * Prefers keys with more known remaining quota, falling back to round-robin
   * when the provider does not report quota. Returns null when every key is
   * cooling or retired — the caller then moves down the provider chain rather
   * than blocking.
   */
  acquire(now: number = Date.now()): KeyLease | null {
    const healthy = this.states.filter((s) => !s.retired && s.cooldownUntil <= now);
    if (healthy.length === 0) return null;

    const known = healthy.filter((s) => s.remainingRequests !== null);
    if (known.length > 0) {
      const best = known.reduce((a, b) =>
        (b.remainingRequests ?? 0) > (a.remainingRequests ?? 0) ? b : a,
      );
      return { key: best.key, fingerprint: best.fingerprint };
    }

    this.cursor = (this.cursor + 1) % healthy.length;
    const chosen = healthy[this.cursor] ?? healthy[0];
    if (!chosen) return null;
    return { key: chosen.key, fingerprint: chosen.fingerprint };
  }

  /** Earliest epoch-ms at which some key becomes usable, or null if none ever will. */
  nextAvailableAt(): number | null {
    const live = this.states.filter((s) => !s.retired);
    if (live.length === 0) return null;
    return Math.min(...live.map((s) => s.cooldownUntil));
  }

  reportSuccess(fingerprint: string, headers?: Headers): void {
    const state = this.find(fingerprint);
    if (!state) return;
    state.successes += 1;
    state.cooldownUntil = 0;
    state.remainingRequests = parseRemaining(headers);
  }

  /**
   * Record a failure.
   *
   * Returns true when the key can be used again later, false when it has been
   * retired — the caller uses that to decide whether retrying this provider is
   * worth anything.
   */
  reportFailure(
    fingerprint: string,
    status: number | undefined,
    headers?: Headers,
    now: number = Date.now(),
  ): boolean {
    const state = this.find(fingerprint);
    if (!state) return false;
    state.failures += 1;

    if (status === 401 || status === 403) {
      state.retired = true;
      state.retiredReason = `provider rejected the credential (HTTP ${status})`;
      return false;
    }

    if (status === 429) {
      state.cooldownUntil = now + retryAfterMs(headers, DEFAULT_COOLDOWN_MS);
      state.remainingRequests = 0;
      return true;
    }

    if (status !== undefined && status >= 500) {
      // Server-side problem, not this key's fault: brief cooldown so the pool
      // spreads out rather than retrying the same key instantly.
      state.cooldownUntil = now + 2_000;
      return true;
    }

    return true;
  }

  snapshot(now: number = Date.now()): PoolSnapshot {
    return {
      provider: this.provider,
      total: this.states.length,
      available: this.availableCount(now),
      cooling: this.states.filter((s) => !s.retired && s.cooldownUntil > now).length,
      retired: this.states.filter((s) => s.retired).length,
      keys: this.states.map(({ key, ...rest }) => {
        void key;
        return { ...rest };
      }),
    };
  }

  private find(fingerprint: string): KeyState | undefined {
    return this.states.find((s) => s.fingerprint === fingerprint);
  }
}

/** Short, non-reversible identifier for logs and the health endpoint. */
export function fingerprintOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function parseRemaining(headers?: Headers): number | null {
  if (!headers) return null;
  const raw =
    headers.get('x-ratelimit-remaining-requests') ??
    headers.get('x-ratelimit-remaining') ??
    null;
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Honour the provider's own backoff instruction when it gives one.
 *
 * Groq sends `retry-after` in seconds and also `x-ratelimit-reset-requests` in
 * a duration format like "7.66s" or "2m59.56s". Both are handled; anything
 * unparseable falls back to the default.
 */
export function retryAfterMs(headers: Headers | undefined, fallback: number): number {
  if (!headers) return fallback;

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return clampCooldown(seconds * 1000);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return clampCooldown(asDate - Date.now());
  }

  const reset =
    headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset') ?? null;
  if (reset) {
    const parsed = parseDuration(reset);
    if (parsed !== null) return clampCooldown(parsed);
  }

  return fallback;
}

/** "7.66s", "2m59.56s", "1h2m3s", or a bare number of seconds. */
export function parseDuration(input: string): number | null {
  const text = input.trim();
  if (!text) return null;

  const bare = Number.parseFloat(text);
  if (/^\d+(\.\d+)?$/.test(text) && Number.isFinite(bare)) return bare * 1000;

  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    const value = Number.parseFloat(match[1] ?? '');
    const unit = match[2];
    if (!Number.isFinite(value)) continue;
    matched = true;
    if (unit === 'ms') total += value;
    else if (unit === 's') total += value * 1000;
    else if (unit === 'm') total += value * 60_000;
    else if (unit === 'h') total += value * 3_600_000;
  }
  return matched ? total : null;
}

function clampCooldown(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(500, ms));
}
