/**
 * Provider adapters.
 *
 * Both live providers speak the OpenAI-compatible chat-completions dialect, so
 * one HTTP client serves them and the differences collapse to a base URL, a
 * model name and a key pool. Written against `fetch` rather than a vendor SDK
 * on purpose: this layer has to own key rotation, rate-limit header parsing,
 * timeouts and retries, and an SDK that hides the response headers takes the
 * key pool's inputs away.
 *
 *   dashscope — Alibaba Cloud Model Studio (Qwen), compatible mode.
 *   groq      — Groq free tier. Chat only; Groq exposes no embeddings endpoint.
 *   mock      — deterministic, offline, always available. Not a stub: it is a
 *               supported runtime mode, and the system stays factually correct
 *               under it because facts never come from the model anyway.
 */
import { getConfig, keysForProvider, type LlmProviderName } from '@/lib/config/env';
import { logger } from '@/lib/obs/logger';
import { KeyPool } from './keypool';
import {
  LlmError,
  type CompletionOptions,
  type LlmProvider,
  type ModelTier,
  type RawCompletion,
} from './types';

interface OpenAiCompatibleConfig {
  name: LlmProviderName;
  baseUrl: string;
  primaryModel: string;
  fastModel: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: LlmProviderName;
  readonly pool: KeyPool;

  constructor(private readonly cfg: OpenAiCompatibleConfig) {
    this.name = cfg.name;
    this.pool = new KeyPool(cfg.name, keysForProvider(cfg.name));
  }

  isConfigured(): boolean {
    return this.pool.hasUsableKeys();
  }

  modelFor(tier: ModelTier): string {
    return tier === 'fast' ? this.cfg.fastModel : this.cfg.primaryModel;
  }

  async complete(options: CompletionOptions): Promise<RawCompletion> {
    const cfg = getConfig();
    const lease = this.pool.acquire();

    if (!lease) {
      const next = this.pool.nextAvailableAt();
      const waitMs = next === null ? null : Math.max(0, next - Date.now());
      throw new LlmError(
        next === null
          ? `${this.name}: every key has been retired`
          : `${this.name}: all keys cooling for another ${Math.ceil((waitMs ?? 0) / 1000)}s`,
        this.name,
        { status: 429, retryable: next !== null },
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.LLM_TIMEOUT_MS);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: false,
    };
    // `json_object` is the widest-supported constrained-output mode across both
    // providers. The schema itself is carried in the system prompt and enforced
    // by zod on the way back, so we never depend on a provider-specific strict
    // mode being available.
    if (options.jsonMode) body.response_format = { type: 'json_object' };

    let response: Response;
    try {
      response = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${lease.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      this.pool.reportFailure(lease.fingerprint, undefined);
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new LlmError(
        aborted ? `${this.name}: request timed out after ${cfg.LLM_TIMEOUT_MS}ms` : `${this.name}: network error`,
        this.name,
        { retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await safeErrorText(response);
      const usable = this.pool.reportFailure(lease.fingerprint, response.status, response.headers);
      logger().warn(
        { provider: this.name, status: response.status, key: lease.fingerprint, usable },
        'llm request failed',
      );
      throw new LlmError(`${this.name}: HTTP ${response.status} — ${detail}`, this.name, {
        status: response.status,
      });
    }

    this.pool.reportSuccess(lease.fingerprint, response.headers);

    const payload = (await response.json()) as ChatCompletionResponse;
    if (payload.error) {
      throw new LlmError(`${this.name}: ${payload.error.message ?? 'provider error'}`, this.name, {
        retryable: false,
      });
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmError(`${this.name}: empty completion`, this.name, { retryable: true });
    }

    return {
      content,
      model: payload.model ?? options.model,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? null,
        outputTokens: payload.usage?.completion_tokens ?? null,
      },
    };
  }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return parsed.error?.message ?? parsed.message ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return response.statusText;
  }
}

/**
 * The deterministic provider.
 *
 * It does not fabricate JSON. Every call site of `generateStructured` is
 * required by its type signature to supply a deterministic fallback, and the
 * client invokes that fallback directly when no live provider can serve the
 * request. Having the mock synthesise a plausible-looking model response would
 * reintroduce exactly the failure mode this architecture exists to prevent:
 * output that looks authoritative and was authored by nothing.
 *
 * So `complete()` is unreachable by construction, and says so if reached.
 */
class MockProvider implements LlmProvider {
  readonly name = 'mock' as const;

  isConfigured(): boolean {
    return true;
  }

  modelFor(tier: ModelTier): string {
    return `deterministic-${tier}`;
  }

  async complete(_options: CompletionOptions): Promise<RawCompletion> {
    void _options;
    throw new LlmError(
      'the deterministic provider has no completion endpoint; callers must use the supplied fallback',
      'mock',
      { retryable: false },
    );
  }
}

/* ── Registry ─────────────────────────────────────────────────────────────
 * Providers hold key-pool state (cooldowns, retirements) that must survive
 * across requests, and Next.js dev-mode module reloading would otherwise reset
 * it on every edit.
 */

const REGISTRY = Symbol.for('gsn.llm.providers');
type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY]?: Map<LlmProviderName, LlmProvider>;
};

function registry(): Map<LlmProviderName, LlmProvider> {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY] ??= new Map();
  return g[REGISTRY];
}

export function getProvider(name: LlmProviderName): LlmProvider {
  const map = registry();
  const existing = map.get(name);
  if (existing) return existing;

  const cfg = getConfig();
  let provider: LlmProvider;

  switch (name) {
    case 'dashscope':
      provider = new OpenAiCompatibleProvider({
        name: 'dashscope',
        baseUrl: cfg.DASHSCOPE_BASE_URL.replace(/\/+$/, ''),
        primaryModel: cfg.DASHSCOPE_MODEL_PRIMARY,
        fastModel: cfg.DASHSCOPE_MODEL_FAST,
      });
      break;
    case 'groq':
      provider = new OpenAiCompatibleProvider({
        name: 'groq',
        baseUrl: cfg.GROQ_BASE_URL.replace(/\/+$/, ''),
        primaryModel: cfg.GROQ_MODEL_PRIMARY,
        fastModel: cfg.GROQ_MODEL_FAST,
      });
      break;
    case 'mock':
      provider = new MockProvider();
      break;
  }

  map.set(name, provider);
  return provider;
}

/** Key-pool health for /api/health. Never exposes a key. */
export function poolSnapshots() {
  return (['dashscope', 'groq'] as const)
    .map((name) => getProvider(name))
    .filter((p): p is OpenAiCompatibleProvider => p instanceof OpenAiCompatibleProvider)
    .map((p) => p.pool.snapshot());
}

/** Test-only: drop cached providers so a new key configuration takes effect. */
export function resetProvidersForTests(): void {
  (globalThis as GlobalWithRegistry)[REGISTRY] = new Map();
}
