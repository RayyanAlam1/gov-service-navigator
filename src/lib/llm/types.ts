/**
 * The language layer's contract.
 *
 * Four jobs, and only four: detect intent, translate, route context, and
 * render already-decided content into fluent output. It is never asked "what
 * documents does a lost CNIC need?" — it is asked "render this list of
 * documents, which I am giving you, into Urdu."
 *
 * Every call in this codebase goes through `generateStructured`. There is no
 * free-text completion helper, deliberately: an unstructured string coming
 * back from a model is a string nobody has validated, and it would eventually
 * be rendered to a citizen as if it were checked.
 */
import type { z } from 'zod';
import type { LlmProviderName } from '@/lib/config/env';

export type ModelTier = 'primary' | 'fast';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  /** Stable identifier for tracing, caching and metrics, e.g. 'intent.extract'. */
  kind: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** JSON Schema for the same shape, derived from `schema`. Never hand-written. */
  jsonSchema: Record<string, unknown>;
  tier?: ModelTier;
  temperature?: number;
  maxTokens?: number;
  /** Skip the cache for this call (used by the eval harness in cold mode). */
  bypassCache?: boolean;
}

export interface TokenUsage {
  promptTokens: number | null;
  outputTokens: number | null;
}

export interface StructuredResult<T> {
  data: T;
  provider: LlmProviderName;
  model: string;
  cached: boolean;
  /** True when the first response failed validation and a repair pass fixed it. */
  repaired: boolean;
  attempts: number;
  latencyMs: number;
  usage: TokenUsage;
}

export interface RawCompletion {
  content: string;
  model: string;
  usage: TokenUsage;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  /** Ask the provider to constrain output to a JSON object. */
  jsonMode: boolean;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /** False when no credentials are configured; the chain skips it. */
  isConfigured(): boolean;
  modelFor(tier: ModelTier): string;
  complete(options: CompletionOptions): Promise<RawCompletion>;
}

/* ── Errors ───────────────────────────────────────────────────────────────
 * Typed so callers can distinguish "the provider is down, use the
 * deterministic path" from "the model produced something invalid, which is a
 * prompt bug worth surfacing".
 */

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProviderName,
    readonly options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    if (this.options.retryable !== undefined) return this.options.retryable;
    const status = this.options.status;
    if (status === undefined) return true; // network-level failure
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
}

/** No provider in the chain could serve the request. Callers fall back deterministically. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempted: readonly { provider: LlmProviderName; reason: string }[],
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** The model answered, but not in the shape the schema requires, twice. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly raw: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}
