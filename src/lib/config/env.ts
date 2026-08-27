/**
 * Environment configuration.
 *
 * Parsed once, validated with zod, frozen. Every module imports the typed
 * `config` object rather than reading `process.env` directly, so a typo in a
 * variable name is a compile error instead of a silent `undefined` that only
 * shows up as odd behaviour during a demo.
 *
 * Design rule: the system must boot with an empty environment. Missing
 * credentials degrade a capability and are reported by /api/health; they never
 * throw at import time. A demo that crashes because someone forgot an env var
 * is a worse failure than one that runs in a documented degraded mode and says
 * so on screen.
 */
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    })
    .pipe(z.number().int().min(min ?? Number.MIN_SAFE_INTEGER).max(max ?? Number.MAX_SAFE_INTEGER));

const num = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : fallback;
    })
    .pipe(z.number().min(min ?? -Infinity).max(max ?? Infinity));

const str = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim()));

/** Comma-separated secret list -> deduped array, empty entries dropped. */
const csv = z
  .string()
  .optional()
  .transform((v) =>
    Array.from(
      new Set(
        (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ),
  );

export const LLM_PROVIDERS = ['dashscope', 'groq', 'mock'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const EMBEDDING_PROVIDERS = ['dashscope', 'local', 'hash'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

const EnvSchema = z.object({
  NODE_ENV: str('development').pipe(z.enum(['development', 'test', 'production'])),
  APP_ENV: str('local'),
  LOG_LEVEL: str('info').pipe(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])),

  /* ── Database ───────────────────────────────────────────────────────── */
  DB_DRIVER: str('pg').pipe(z.enum(['pg', 'pglite'])),
  DATABASE_URL: str('postgresql://gsn:gsn_dev_password@localhost:5432/gsn'),
  PGLITE_DATA_DIR: str('.pglite'),
  DB_POOL_MAX: int(10, 1, 100),
  DB_STATEMENT_TIMEOUT_MS: int(15_000, 1_000, 120_000),

  /* ── LLM ────────────────────────────────────────────────────────────── */
  LLM_PROVIDER: str('dashscope').pipe(z.enum(LLM_PROVIDERS)),
  /** Used when the primary is unconfigured or its circuit breaker is open. */
  LLM_FALLBACK_PROVIDER: str('groq').pipe(z.enum(LLM_PROVIDERS)),

  // Alibaba Cloud Model Studio (DashScope), OpenAI-compatible mode.
  DASHSCOPE_API_KEYS: csv,
  DASHSCOPE_API_KEY: str(''),
  DASHSCOPE_BASE_URL: str('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  DASHSCOPE_MODEL_PRIMARY: str('qwen-plus'),
  DASHSCOPE_MODEL_FAST: str('qwen-turbo'),
  DASHSCOPE_EMBEDDING_MODEL: str('text-embedding-v3'),

  // Groq, OpenAI-compatible. Chat only — Groq exposes no embeddings endpoint.
  GROQ_API_KEYS: csv,
  GROQ_API_KEY: str(''),
  GROQ_BASE_URL: str('https://api.groq.com/openai/v1'),
  GROQ_MODEL_PRIMARY: str('llama-3.3-70b-versatile'),
  GROQ_MODEL_FAST: str('llama-3.1-8b-instant'),

  LLM_TIMEOUT_MS: int(30_000, 1_000, 180_000),
  LLM_MAX_RETRIES: int(2, 0, 6),
  LLM_TEMPERATURE: num(0.1, 0, 2),
  LLM_MAX_OUTPUT_TOKENS: int(2048, 128, 32_768),
  LLM_CACHE_ENABLED: bool(true),
  LLM_CACHE_TTL_SECONDS: int(86_400, 0, 2_592_000),
  LLM_BREAKER_THRESHOLD: int(5, 1, 100),
  LLM_BREAKER_COOLDOWN_MS: int(30_000, 1_000, 600_000),

  /* ── Embeddings ─────────────────────────────────────────────────────── */
  EMBEDDING_PROVIDER: str('local').pipe(z.enum(EMBEDDING_PROVIDERS)),
  EMBEDDING_MODEL: str('Xenova/multilingual-e5-small'),
  /**
   * Must equal the vector(N) width the migrations were applied with. The
   * migration runner records the width it used in `system_meta`, and
   * assertEmbeddingDim() refuses to start on a mismatch rather than writing
   * garbage into the index.
   */
  EMBEDDING_DIM: int(384, 8, 4096),
  EMBEDDING_BATCH_SIZE: int(16, 1, 256),
  TRANSFORMERS_CACHE: str('./data/models'),

  /* ── Retrieval ──────────────────────────────────────────────────────── */
  RAG_TOP_K: int(8, 1, 50),
  RAG_CANDIDATE_K: int(24, 1, 200),
  RAG_MIN_SIMILARITY: num(0.75, 0, 1),
  RAG_SUFFICIENCY_SIMILARITY: num(0.84, 0, 1),
  RAG_RRF_K: int(60, 1, 1000),
  RAG_MAX_QUERY_EXPANSIONS: int(3, 0, 8),
  RAG_MAX_RETRIEVAL_LOOPS: int(2, 1, 5),
  RAG_RERANK_ENABLED: bool(true),

  /* ── Grounding & safety ─────────────────────────────────────────────── */
  SOURCE_STALE_AFTER_DAYS: int(180, 1, 3650),
  SERVICE_CONFIDENCE_THRESHOLD: num(0.62, 0, 1),
  STRICT_GROUNDING: bool(true),

  /* ── Session & limits ───────────────────────────────────────────────── */
  SESSION_TTL_HOURS: int(72, 1, 8760),
  SESSION_ID_BYTES: int(32, 16, 64),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000, 3_600_000),
  RATE_LIMIT_MAX_REQUESTS: int(60, 1, 10_000),
  MAX_INPUT_CHARS: int(1200, 40, 20_000),
  MAX_UPLOAD_BYTES: int(5_242_880, 1024, 52_428_800),

  /* ── Documents ──────────────────────────────────────────────────────── */
  OCR_PROVIDER: str('mock').pipe(z.enum(['mock'])),
  DOCUMENT_RETENTION_ENABLED: bool(false),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>> & {
  readonly dashscopeKeys: readonly string[];
  readonly groqKeys: readonly string[];
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

function build(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Only reachable for values that are present but structurally invalid
    // (e.g. LOG_LEVEL=loud). Absent values already have defaults, so this is a
    // genuine misconfiguration and failing loudly is correct.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const raw = parsed.data;
  const keysFor = (list: readonly string[], single: string): readonly string[] =>
    Object.freeze(list.length > 0 ? [...list] : single ? [single] : []);

  return Object.freeze({
    ...raw,
    dashscopeKeys: keysFor(raw.DASHSCOPE_API_KEYS, raw.DASHSCOPE_API_KEY),
    groqKeys: keysFor(raw.GROQ_API_KEYS, raw.GROQ_API_KEY),
    isProduction: raw.NODE_ENV === 'production',
    isTest: raw.NODE_ENV === 'test',
  });
}

let cached: AppConfig | null = null;

/** Typed, validated, frozen configuration. Safe to call from anywhere. */
export function getConfig(): AppConfig {
  cached ??= build();
  return cached;
}

/** Test-only: force a re-read after mutating process.env. */
export function resetConfigForTests(): void {
  cached = null;
}

export const config: AppConfig = new Proxy({} as AppConfig, {
  get: (_t, prop) => getConfig()[prop as keyof AppConfig],
  has: (_t, prop) => prop in getConfig(),
  ownKeys: () => Reflect.ownKeys(getConfig()),
  getOwnPropertyDescriptor: (_t, prop) => ({
    ...Object.getOwnPropertyDescriptor(getConfig(), prop),
    configurable: true,
  }),
});

/** API keys configured for a given provider, in dispatch order. */
export function keysForProvider(provider: LlmProviderName): readonly string[] {
  const c = getConfig();
  switch (provider) {
    case 'dashscope':
      return c.dashscopeKeys;
    case 'groq':
      return c.groqKeys;
    case 'mock':
      return ['mock'];
  }
}

export function isProviderConfigured(provider: LlmProviderName): boolean {
  return keysForProvider(provider).length > 0;
}

/**
 * Provider dispatch order: primary, then fallback, then the deterministic
 * provider. `mock` is always last and always present, which is what makes the
 * "it still works with no network" guarantee real rather than aspirational.
 */
export function llmProviderChain(): LlmProviderName[] {
  const c = getConfig();
  const chain: LlmProviderName[] = [];
  for (const p of [c.LLM_PROVIDER, c.LLM_FALLBACK_PROVIDER]) {
    if (!chain.includes(p) && (p === 'mock' || isProviderConfigured(p))) chain.push(p);
  }
  if (!chain.includes('mock')) chain.push('mock');
  return chain;
}

/**
 * Capability report, surfaced verbatim by /api/health and by the architecture
 * panel in the UI. The point is that a degraded capability is *visible* rather
 * than inferred from odd output.
 */
export interface CapabilityReport {
  llm: {
    configured: LlmProviderName;
    fallback: LlmProviderName;
    activeChain: LlmProviderName[];
    live: boolean;
    keys: Record<string, number>;
    reason?: string;
  };
  embeddings: {
    provider: EmbeddingProviderName;
    model: string;
    dim: number;
    degraded: boolean;
    reason?: string;
  };
  database: { driver: string; embedded: boolean };
  grounding: { strict: boolean; staleAfterDays: number; minSimilarity: number };
}

export function describeCapabilities(): CapabilityReport {
  const c = getConfig();
  const chain = llmProviderChain();
  const live = chain.some((p) => p !== 'mock');

  const embeddingModel =
    c.EMBEDDING_PROVIDER === 'hash'
      ? 'builtin-hash'
      : c.EMBEDDING_PROVIDER === 'dashscope'
        ? c.DASHSCOPE_EMBEDDING_MODEL
        : c.EMBEDDING_MODEL;

  return {
    llm: {
      configured: c.LLM_PROVIDER,
      fallback: c.LLM_FALLBACK_PROVIDER,
      activeChain: chain,
      live,
      keys: { dashscope: c.dashscopeKeys.length, groq: c.groqKeys.length },
      ...(live
        ? {}
        : {
            reason:
              'No LLM credentials configured. Running on the deterministic provider: ' +
              'phrasing and translation are templated, but every government fact still ' +
              'comes from the database exactly as it would with a live model.',
          }),
    },
    embeddings: {
      provider: c.EMBEDDING_PROVIDER,
      model: embeddingModel,
      dim: c.EMBEDDING_DIM,
      degraded: c.EMBEDDING_PROVIDER === 'hash',
      ...(c.EMBEDDING_PROVIDER === 'hash'
        ? {
            reason:
              'Lexical-only embeddings. Hybrid BM25 retrieval still applies; semantic recall is reduced.',
          }
        : {}),
    },
    database: { driver: c.DB_DRIVER, embedded: c.DB_DRIVER === 'pglite' },
    grounding: {
      strict: c.STRICT_GROUNDING,
      staleAfterDays: c.SOURCE_STALE_AFTER_DAYS,
      minSimilarity: c.RAG_MIN_SIMILARITY,
    },
  };
}
