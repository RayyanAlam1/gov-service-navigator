/**
 * Embeddings.
 *
 * Three implementations behind one interface, chosen by EMBEDDING_PROVIDER:
 *
 *   local     Multilingual ONNX model running in-process (multilingual-e5-small,
 *             384d). Free, offline once fetched, and genuinely multilingual —
 *             it puts an Urdu sentence near its English translation, which is
 *             the whole point when the corpus is in one language and the
 *             citizen writes in another.
 *
 *   dashscope Alibaba text-embedding-v3. Better quality, costs quota, needs
 *             network. Set EMBEDDING_DIM to a width the model supports.
 *
 *   hash      Dependency-free deterministic fallback. Feature-hashed character
 *             n-grams; lexical similarity only, no semantics. It exists so the
 *             system never hard-fails on a missing model download, and
 *             /api/health reports it as degraded rather than pretending.
 *
 * `local` degrades to `hash` automatically if the model cannot be loaded, and
 * says so once, loudly. A demo that silently returns no evidence is worse than
 * one that returns weaker evidence and tells you why.
 */
import { createHash } from 'node:crypto';
import { getConfig, type EmbeddingProviderName } from '@/lib/config/env';
import { logger } from '@/lib/obs/logger';
import { normalizeForSearch } from '@/lib/i18n/normalize';

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;
  readonly model: string;
  readonly dim: number;
  readonly degraded: boolean;
  /** Embed documents for storage. */
  embedPassages(texts: readonly string[]): Promise<number[][]>;
  /** Embed a query. Asymmetric models (e5) need a different prefix here. */
  embedQuery(text: string): Promise<number[]>;
}

/* ── Vector helpers ───────────────────────────────────────────────────── */

export function l2Normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return [...vector];
  return vector.map((v) => v / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Fit a vector to the storage width.
 *
 * Zero-padding a shorter vector preserves cosine similarity exactly, so a
 * provider that emits fewer dimensions than the column is safe. Truncation is
 * lossy and is only ever a last resort against a misconfiguration; it is
 * logged rather than silently accepted.
 */
export function fitToDim(vector: readonly number[], dim: number, context: string): number[] {
  if (vector.length === dim) return [...vector];
  if (vector.length < dim) {
    return [...vector, ...new Array<number>(dim - vector.length).fill(0)];
  }
  logger().warn(
    { context, produced: vector.length, expected: dim },
    'embedding wider than the storage column; truncating — set EMBEDDING_DIM to match and reindex',
  );
  return vector.slice(0, dim);
}

/* ── Hash provider ────────────────────────────────────────────────────── */

/**
 * Deterministic feature hashing over character n-grams and word tokens.
 *
 * Not a semantic embedding and does not pretend to be. Two strings that share
 * substrings land near each other, which is enough for the vector arm to
 * contribute *something* to reciprocal rank fusion while the lexical arm does
 * the real work. Its value is that it has no dependencies, no download, and no
 * failure mode.
 */
class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash' as const;
  readonly model = 'builtin-hash';
  readonly degraded = true;

  constructor(readonly dim: number) {}

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const normalized = normalizeForSearch(text);
    if (!normalized) return vector;

    const add = (feature: string, weight: number) => {
      const digest = createHash('md5').update(feature).digest();
      const first = digest[0] ?? 0;
      const second = digest[1] ?? 0;
      const third = digest[2] ?? 0;
      const index = ((first << 16) | (second << 8) | third) % this.dim;
      // Sign from a separate byte so collisions cancel rather than compound.
      const sign = ((digest[3] ?? 0) & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign * weight;
    };

    for (const token of normalized.split(' ')) {
      if (!token) continue;
      add(`w:${token}`, 1);
      // Character trigrams give partial credit for morphological variants,
      // which matters a lot for Urdu and for Roman-Urdu spelling drift.
      const padded = `  ${token} `;
      for (let i = 0; i < padded.length - 2; i += 1) {
        add(`c:${padded.slice(i, i + 3)}`, 0.35);
      }
    }

    return l2Normalize(vector);
  }

  async embedPassages(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text);
  }
}

/* ── Local ONNX provider ──────────────────────────────────────────────── */

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * e5-family models are asymmetric: passages and queries must carry different
 * prefixes or retrieval quality drops noticeably. Getting this wrong is a
 * silent 10-20% recall loss, so it is centralised here rather than left to
 * call sites.
 */
function e5Prefix(model: string, kind: 'query' | 'passage', text: string): string {
  return /e5/i.test(model) ? `${kind}: ${text}` : text;
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local' as const;
  readonly degraded = false;
  private pipeline: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    readonly model: string,
    readonly dim: number,
  ) {}

  private async load(): Promise<FeatureExtractionPipeline> {
    if (this.pipeline) return this.pipeline;
    this.loading ??= (async () => {
      const cfg = getConfig();
      const transformers = await import('@huggingface/transformers');
      // Keep the model on disk next to the repo so a container build can bake
      // it in and a demo never waits on a download.
      transformers.env.cacheDir = cfg.TRANSFORMERS_CACHE;
      transformers.env.allowLocalModels = true;

      const pipe = await transformers.pipeline('feature-extraction', this.model, {
        dtype: 'q8',
      });
      this.pipeline = pipe as unknown as FeatureExtractionPipeline;
      return this.pipeline;
    })();
    return this.loading;
  }

  private async run(texts: readonly string[]): Promise<number[][]> {
    const pipe = await this.load();
    const cfg = getConfig();
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += cfg.EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + cfg.EMBEDDING_BATCH_SIZE);
      const tensor = await pipe([...batch], { pooling: 'mean', normalize: true });
      for (const row of tensor.tolist()) {
        out.push(fitToDim(l2Normalize(row), this.dim, `local:${this.model}`));
      }
    }
    return out;
  }

  async embedPassages(texts: readonly string[]): Promise<number[][]> {
    return this.run(texts.map((t) => e5Prefix(this.model, 'passage', t)));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.run([e5Prefix(this.model, 'query', text)]);
    return vector ?? new Array<number>(this.dim).fill(0);
  }
}

/* ── DashScope provider ───────────────────────────────────────────────── */

interface DashScopeEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

class DashScopeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'dashscope' as const;
  readonly degraded = false;

  constructor(
    readonly model: string,
    readonly dim: number,
  ) {}

  private async call(texts: readonly string[]): Promise<number[][]> {
    const cfg = getConfig();
    const key = cfg.dashscopeKeys[0];
    if (!key) throw new Error('DASHSCOPE_API_KEY is not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.LLM_TIMEOUT_MS);
    try {
      const response = await fetch(`${cfg.DASHSCOPE_BASE_URL.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.model, input: [...texts], dimensions: this.dim, encoding_format: 'float' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`dashscope embeddings: HTTP ${response.status}`);
      }
      const payload = (await response.json()) as DashScopeEmbeddingResponse;
      if (payload.error) throw new Error(`dashscope embeddings: ${payload.error.message ?? 'error'}`);

      const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return rows.map((r) => fitToDim(l2Normalize(r.embedding ?? []), this.dim, 'dashscope'));
    } finally {
      clearTimeout(timeout);
    }
  }

  async embedPassages(texts: readonly string[]): Promise<number[][]> {
    const cfg = getConfig();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += cfg.EMBEDDING_BATCH_SIZE) {
      out.push(...(await this.call(texts.slice(i, i + cfg.EMBEDDING_BATCH_SIZE))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.call([text]);
    return vector ?? new Array<number>(this.dim).fill(0);
  }
}

/* ── Resolution ───────────────────────────────────────────────────────── */

/**
 * Wraps a preferred provider and falls back to hashing on first failure.
 *
 * The failure is logged once, at warn level, with the reason. Silently
 * returning empty vectors would make retrieval quietly return nothing, which
 * is the hardest kind of problem to notice during a live demo.
 */
class ResilientProvider implements EmbeddingProvider {
  private failed = false;

  constructor(
    private readonly preferred: EmbeddingProvider,
    private readonly fallbackProvider: EmbeddingProvider,
  ) {}

  get name(): EmbeddingProviderName {
    return this.failed ? this.fallbackProvider.name : this.preferred.name;
  }
  get model(): string {
    return this.failed ? this.fallbackProvider.model : this.preferred.model;
  }
  get dim(): number {
    return this.preferred.dim;
  }
  get degraded(): boolean {
    return this.failed || this.preferred.degraded;
  }

  private demote(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    logger().warn(
      { provider: this.preferred.name, err: err instanceof Error ? err.message : String(err) },
      'embedding provider unavailable — degrading to lexical hash embeddings for the rest of this process',
    );
  }

  async embedPassages(texts: readonly string[]): Promise<number[][]> {
    if (!this.failed) {
      try {
        return await this.preferred.embedPassages(texts);
      } catch (err) {
        this.demote(err);
      }
    }
    return this.fallbackProvider.embedPassages(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!this.failed) {
      try {
        return await this.preferred.embedQuery(text);
      } catch (err) {
        this.demote(err);
      }
    }
    return this.fallbackProvider.embedQuery(text);
  }
}

const PROVIDER = Symbol.for('gsn.embeddings.provider');
type GlobalWithEmbeddings = typeof globalThis & { [PROVIDER]?: EmbeddingProvider };

export function getEmbeddingProvider(): EmbeddingProvider {
  const g = globalThis as GlobalWithEmbeddings;
  if (g[PROVIDER]) return g[PROVIDER];

  const cfg = getConfig();
  const hash = new HashEmbeddingProvider(cfg.EMBEDDING_DIM);

  let provider: EmbeddingProvider;
  switch (cfg.EMBEDDING_PROVIDER) {
    case 'hash':
      provider = hash;
      break;
    case 'dashscope':
      provider = new ResilientProvider(
        new DashScopeEmbeddingProvider(cfg.DASHSCOPE_EMBEDDING_MODEL, cfg.EMBEDDING_DIM),
        hash,
      );
      break;
    case 'local':
      provider = new ResilientProvider(
        new LocalEmbeddingProvider(cfg.EMBEDDING_MODEL, cfg.EMBEDDING_DIM),
        hash,
      );
      break;
  }

  g[PROVIDER] = provider;
  return provider;
}

export function resetEmbeddingProviderForTests(): void {
  delete (globalThis as GlobalWithEmbeddings)[PROVIDER];
}

/* ── Cached embedding ─────────────────────────────────────────────────── */

function cacheKeyFor(model: string, kind: string, text: string): string {
  return createHash('sha256').update(`${model}|${kind}|${text}`).digest('hex');
}

/**
 * Embed a query, memoised in Postgres.
 *
 * Queries repeat constantly — the same demo question, the same evaluation
 * scenario, the same expanded sub-query across turns. Caching turns the second
 * run of an eval suite from minutes into seconds and keeps a rate limit from
 * being the thing that breaks a pitch.
 */
export async function embedQueryCached(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  const trimmed = text.trim();
  if (!trimmed) return new Array<number>(provider.dim).fill(0);

  const key = cacheKeyFor(provider.model, 'query', trimmed);

  try {
    const { sqlOne, sql, toVectorLiteral } = await import('@/lib/db/client');
    const row = await sqlOne<{ embedding: string | number[] }>(
      'SELECT embedding FROM embedding_cache WHERE cache_key = $1',
      [key],
    );
    if (row) {
      void sql('UPDATE embedding_cache SET hits = hits + 1, last_used_at = NOW() WHERE cache_key = $1', [key]).catch(
        () => null,
      );
      return parseVector(row.embedding, provider.dim);
    }

    const vector = await provider.embedQuery(trimmed);
    void sql(
      `INSERT INTO embedding_cache (cache_key, model, dim, embedding)
       VALUES ($1, $2, $3, $4::vector) ON CONFLICT (cache_key) DO NOTHING`,
      [key, provider.model, provider.dim, toVectorLiteral(vector)],
    ).catch(() => null);
    return vector;
  } catch {
    // Cache unavailable: embed directly rather than failing the request.
    return provider.embedQuery(trimmed);
  }
}

/** pgvector returns '[0.1,0.2,...]'; the pglite driver may return an array. */
export function parseVector(raw: string | number[] | null | undefined, dim: number): number[] {
  if (Array.isArray(raw)) return fitToDim(raw, dim, 'parseVector');
  if (typeof raw !== 'string' || raw.length === 0) return new Array<number>(dim).fill(0);
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner) return new Array<number>(dim).fill(0);
  const values = inner.split(',').map((v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  });
  return fitToDim(values, dim, 'parseVector');
}
