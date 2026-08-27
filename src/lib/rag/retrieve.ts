/**
 * Hybrid retrieval.
 *
 * Two independent arms, fused with reciprocal rank fusion:
 *
 *   lexical  Postgres full-text over `content_norm`, using the 'simple'
 *            configuration. Catches exact terms — form numbers, office names,
 *            "B-Form", "NICOP" — that a small embedding model routinely
 *            misplaces.
 *
 *   vector   pgvector cosine over the same chunks. Catches paraphrase and
 *            cross-language matches, which is the whole reason a citizen can
 *            ask in Roman Urdu about an English-language notification.
 *
 * Neither arm alone is good enough here. The lexical arm cannot bridge
 * languages; the vector arm, at 384 dimensions on a small multilingual model,
 * is unreliable on rare proper nouns. RRF is used rather than score blending
 * because the two arms produce incomparable scales (ts_rank is unbounded,
 * cosine is [-1,1]) and rank fusion needs no calibration to stay stable.
 *
 * Retrieval finds text. It does not decide truth. Everything here returns
 * candidate evidence with its provenance attached; whether that evidence is
 * sufficient is decided in rag/index.ts, and whether a claim may be made from
 * it is decided by the output verifier.
 */
import { getConfig } from '@/lib/config/env';
import { sql, toVectorLiteral } from '@/lib/db/client';
import { embedQueryCached } from '@/lib/embeddings';
import { normalizeForSearch, tokenize } from '@/lib/i18n/normalize';
import { logger } from '@/lib/obs/logger';
import type { Language } from '@/lib/schemas/core';
import type { EvidenceChunk } from '@/lib/schemas/domain';
import { toSourceRef, type SourceRow } from '@/lib/db/rows';

export interface RetrievalFilters {
  /** Restrict to one service, plus service-agnostic chunks. */
  serviceId?: number | null;
  scenarioCode?: string | null;
  language?: Language | null;
}

interface ChunkRow extends SourceRow {
  chunk_id: number;
  document_id: number;
  document_title: string;
  heading_path: string | null;
  content: string;
  chunk_language: Language;
  similarity?: number | null;
  lexical_rank?: number | null;
}

const CHUNK_SELECT = `
  c.id                    AS chunk_id,
  c.document_id           AS document_id,
  d.title                 AS document_title,
  c.heading_path          AS heading_path,
  c.content               AS content,
  c.language              AS chunk_language,
  s.id                    AS source_id,
  s.code                  AS source_code,
  s.title                 AS source_title,
  s.publisher             AS source_publisher,
  s.url                   AS source_url,
  s.last_verified         AS source_last_verified,
  s.retrieved_at          AS source_retrieved_at,
  s.verification_status   AS source_verification_status
`;

/**
 * Function words, in all three languages.
 *
 * Postgres's 'simple' text-search configuration does no stopword removal — that
 * is exactly why it is safe for Urdu — so the filtering has to happen here.
 * Without it, "how do I bake sourdough bread at home" matches a dozen chunks on
 * "how", "do", "at" and "home", and the lexical arm contributes pure noise to
 * the fusion.
 *
 * Domain words are deliberately absent from this list even when they are
 * grammatically common: "gum" (lost), "form", "card" and "office" carry the
 * signal in this corpus.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'about',
  'to', 'from', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'can', 'could',
  'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them', 'their', 'this', 'that',
  'these', 'those', 'there', 'here', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'not', 'no', 'so', 'than', 'then', 'too', 'very', 'just', 'now',
  'get', 'got', 'need', 'want', 'please', 'help', 'know', 'tell', 'give', 'make',
  // Roman Urdu function words
  'mera', 'meri', 'mere', 'mujhe', 'mujhay', 'hamara', 'hamari', 'humara', 'humari',
  'aap', 'apka', 'apki', 'apna', 'apni', 'apne', 'hum', 'ham', 'tum', 'yeh', 'woh',
  'wo', 'hai', 'hain', 'hay', 'hun', 'hoon', 'ho', 'tha', 'thi', 'thay', 'raha',
  'rahi', 'rahe', 'gaya', 'gya', 'gayi', 'gyi', 'hua', 'hui', 'huwa', 'kya', 'kia',
  'kaise', 'kese', 'kaisay', 'kab', 'kyun', 'kyu', 'kon', 'kaun', 'mein', 'mai',
  'ka', 'ki', 'ke', 'ko', 'se', 'par', 'pe', 'tak', 'aur', 'ya', 'lekin', 'magar',
  'phir', 'abhi', 'ab', 'bhi', 'hi', 'agar', 'jab', 'liye', 'liay', 'nahi', 'nahin',
  'haan', 'han', 'ji', 'sakta', 'sakti', 'sakte', 'chahiye', 'chaiye',
  // Urdu script function words
  'کا', 'کی', 'کے', 'کو', 'سے', 'میں', 'اور', 'یا', 'ہے', 'ہیں', 'ہو', 'تھا', 'تھی',
  'یہ', 'وہ', 'جو', 'پر', 'نے', 'کہ', 'بھی', 'ایک', 'اپنے', 'اپنی', 'کیا', 'گیا',
]);

/**
 * Build a tsquery from free text.
 *
 * Tokens are OR-ed rather than AND-ed: recall matters more than precision at
 * the candidate stage, because RRF and the coverage assessment downstream are
 * what impose precision. An AND query on a seven-word citizen question
 * routinely returns nothing at all.
 *
 * Input has already been normalised to letters, digits and spaces, so tokens
 * cannot carry tsquery operators. They are still filtered defensively.
 */
export function buildTsQuery(text: string): string | null {
  const tokens = tokenize(text)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  if (tokens.length === 0) return null;
  // Cap: a very long paste should not produce a pathological query.
  return [...new Set(tokens)].slice(0, 32).join(' | ');
}

function serviceFilterSql(paramIndex: number): string {
  // A NULL service_id on a chunk means "applies to any service" (general
  // guidance). Those must stay reachable when a service filter is applied.
  return `($${paramIndex}::bigint IS NULL OR c.service_id = $${paramIndex}::bigint OR c.service_id IS NULL)`;
}

export async function lexicalSearch(
  query: string,
  limit: number,
  filters: RetrievalFilters = {},
): Promise<ChunkRow[]> {
  const tsquery = buildTsQuery(query);
  if (!tsquery) return [];

  try {
    return await sql<ChunkRow>(
      `SELECT ${CHUNK_SELECT},
              ts_rank(c.content_tsv, q) AS lexical_rank
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN sources   s ON s.id = c.source_id,
              to_tsquery('simple', $1) q
        WHERE c.content_tsv @@ q
          AND ${serviceFilterSql(2)}
        ORDER BY lexical_rank DESC, c.id ASC
        LIMIT $3`,
      [tsquery, filters.serviceId ?? null, limit],
    );
  } catch (err) {
    logger().warn({ err }, 'lexical retrieval failed; continuing with vector arm only');
    return [];
  }
}

export async function vectorSearch(
  query: string,
  limit: number,
  filters: RetrievalFilters = {},
): Promise<ChunkRow[]> {
  try {
    const embedding = await embedQueryCached(query);
    // `<=>` is cosine distance under vector_cosine_ops, so similarity is 1 - d.
    return await sql<ChunkRow>(
      `SELECT ${CHUNK_SELECT},
              1 - (c.embedding <=> $1::vector) AS similarity
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN sources   s ON s.id = c.source_id
        WHERE c.embedding IS NOT NULL
          AND ${serviceFilterSql(2)}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(embedding), filters.serviceId ?? null, limit],
    );
  } catch (err) {
    logger().warn({ err }, 'vector retrieval failed; continuing with lexical arm only');
    return [];
  }
}

export interface FusedCandidate {
  row: ChunkRow;
  rrfScore: number;
  vectorRank: number | null;
  lexicalRank: number | null;
  similarity: number | null;
}

/**
 * Reciprocal rank fusion.
 *
 * score(d) = Σ_arms 1 / (k + rank_arm(d))
 *
 * k (RAG_RRF_K, default 60) damps the influence of top ranks so a single arm
 * cannot dominate; a document found by both arms outranks one found brilliantly
 * by either. That property is what makes the fusion robust when the embedding
 * provider has degraded to lexical hashing.
 */
export function fuse(
  lexical: readonly ChunkRow[],
  vector: readonly ChunkRow[],
  k: number,
): FusedCandidate[] {
  const byChunk = new Map<number, FusedCandidate>();

  const ensure = (row: ChunkRow): FusedCandidate => {
    const existing = byChunk.get(row.chunk_id);
    if (existing) return existing;
    const created: FusedCandidate = {
      row,
      rrfScore: 0,
      vectorRank: null,
      lexicalRank: null,
      similarity: null,
    };
    byChunk.set(row.chunk_id, created);
    return created;
  };

  lexical.forEach((row, index) => {
    const entry = ensure(row);
    entry.lexicalRank = index + 1;
    entry.rrfScore += 1 / (k + index + 1);
  });

  vector.forEach((row, index) => {
    const entry = ensure(row);
    entry.vectorRank = index + 1;
    entry.similarity = typeof row.similarity === 'number' ? row.similarity : null;
    entry.rrfScore += 1 / (k + index + 1);
  });

  return [...byChunk.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.row.chunk_id - b.row.chunk_id);
}

function toEvidence(candidate: FusedCandidate, normalizedScore: number): EvidenceChunk {
  const retrievedBy: Array<'vector' | 'lexical'> = [];
  if (candidate.vectorRank !== null) retrievedBy.push('vector');
  if (candidate.lexicalRank !== null) retrievedBy.push('lexical');

  return {
    chunkId: candidate.row.chunk_id,
    documentId: candidate.row.document_id,
    documentTitle: candidate.row.document_title,
    headingPath: candidate.row.heading_path,
    content: candidate.row.content,
    language: candidate.row.chunk_language,
    source: toSourceRef(candidate.row),
    score: normalizedScore,
    vectorSimilarity: candidate.similarity,
    lexicalRank: candidate.lexicalRank,
    retrievedBy,
  };
}

export interface HybridSearchResult {
  evidence: EvidenceChunk[];
  /** Candidates that were retrieved but fell below the similarity floor. */
  rejected: number;
  lexicalCount: number;
  vectorCount: number;
}

/**
 * One hybrid retrieval pass.
 *
 * The similarity floor is applied only to chunks the vector arm found alone.
 * A chunk both arms agree on is kept regardless of its cosine score, because
 * exact lexical agreement on a rare term ("Form-B", "NICOP") is strong
 * evidence precisely in the cases where a small embedding model is weakest.
 */
export async function hybridSearch(
  query: string,
  filters: RetrievalFilters = {},
  overrides: { candidateK?: number; topK?: number; minSimilarity?: number } = {},
): Promise<HybridSearchResult> {
  const cfg = getConfig();
  const candidateK = overrides.candidateK ?? cfg.RAG_CANDIDATE_K;
  const topK = overrides.topK ?? cfg.RAG_TOP_K;
  const minSimilarity = overrides.minSimilarity ?? cfg.RAG_MIN_SIMILARITY;

  const normalized = normalizeForSearch(query);
  if (!normalized) {
    return { evidence: [], rejected: 0, lexicalCount: 0, vectorCount: 0 };
  }

  const [lexical, vector] = await Promise.all([
    lexicalSearch(normalized, candidateK, filters),
    vectorSearch(query, candidateK, filters),
  ]);

  const fused = fuse(lexical, vector, cfg.RAG_RRF_K);

  const kept: FusedCandidate[] = [];
  let rejected = 0;

  for (const candidate of fused) {
    const bothArms = candidate.vectorRank !== null && candidate.lexicalRank !== null;
    const similarity = candidate.similarity;
    const passesFloor = bothArms || similarity === null || similarity >= minSimilarity;
    if (passesFloor) kept.push(candidate);
    else rejected += 1;
  }

  const top = kept.slice(0, topK);
  const best = top[0]?.rrfScore ?? 1;

  return {
    evidence: top.map((c) => toEvidence(c, best > 0 ? Math.min(1, c.rrfScore / best) : 0)),
    rejected,
    lexicalCount: lexical.length,
    vectorCount: vector.length,
  };
}
