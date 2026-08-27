/**
 * Chunking.
 *
 * Paragraph-first, with a token budget and overlap. Government guidance is
 * written in self-contained paragraphs — one paragraph, one rule — so splitting
 * on blank lines preserves the unit of meaning far better than a fixed window
 * would. A fixed window routinely cuts "the fee is X" away from "for category
 * Y", which is exactly the kind of severance that produces a confident wrong
 * answer downstream.
 *
 * Overlap exists for the opposite failure: a rule whose condition sits in the
 * previous paragraph. Carrying the tail of the previous chunk forward means a
 * retrieved chunk usually contains its own qualifying context.
 */
import { normalizeForSearch } from '@/lib/i18n/normalize';

export interface Chunk {
  index: number;
  content: string;
  /** Folded copy used for lexical search. Must match query-time normalisation. */
  contentNorm: string;
  headingPath: string | null;
  tokenEstimate: number;
}

export interface ChunkOptions {
  /** Soft ceiling per chunk. Paragraphs are not split below this if avoidable. */
  maxTokens?: number;
  /** Chunks shorter than this are merged forward rather than stored alone. */
  minTokens?: number;
  /** Tokens of the previous chunk carried into the next. */
  overlapTokens?: number;
}

/**
 * Token estimate without a tokenizer dependency.
 *
 * Urdu script is denser per character under most BPE vocabularies than Latin
 * text, so it is counted more conservatively. This only has to be good enough
 * to keep chunks inside a context budget, not exact.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let urdu = 0;
  for (const ch of text) {
    if (/[؀-ۿݐ-ݿ]/.test(ch)) urdu += 1;
    else latin += 1;
  }
  return Math.ceil(latin / 4 + urdu / 2);
}

/** A line that reads as a heading rather than prose. */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 90) return false;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/[.!?۔]$/.test(trimmed)) return false;
  // ALL CAPS or Title Case with no terminal punctuation.
  return /^[A-Z0-9][^a-z]*$/.test(trimmed) || /^([A-Z][a-z0-9]*\s*){1,8}$/.test(trimmed);
}

function stripHeadingMarkers(line: string): string {
  return line.replace(/^#{1,6}\s*/, '').trim();
}

/** Last `budget` tokens' worth of sentences from a chunk, for overlap. */
function tailOf(text: string, budget: number): string {
  if (budget <= 0) return '';
  const sentences = text.split(/(?<=[.!?۔])\s+/);
  const kept: string[] = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i];
    if (!sentence) continue;
    const size = estimateTokens(sentence);
    if (total + size > budget && kept.length > 0) break;
    kept.unshift(sentence);
    total += size;
  }
  return kept.join(' ');
}

/**
 * Split a long paragraph that exceeds the budget on its own.
 *
 * Sentence boundaries, including the Urdu full stop (۔). A paragraph with no
 * sentence boundary at all is emitted whole rather than cut mid-word — an
 * oversized chunk is a performance problem, a truncated rule is a correctness
 * problem.
 */
function splitLongParagraph(paragraph: string, maxTokens: number): string[] {
  if (estimateTokens(paragraph) <= maxTokens) return [paragraph];

  const sentences = paragraph.split(/(?<=[.!?۔])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length <= 1) return [paragraph];

  const out: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (estimateTokens(candidate) > maxTokens && buffer) {
      out.push(buffer);
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 320;
  const minTokens = options.minTokens ?? 40;
  const overlapTokens = options.overlapTokens ?? 40;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);

  const chunks: Chunk[] = [];
  let headingPath: string | null = null;
  let buffer = '';
  let bufferHeading: string | null = null;

  const flush = () => {
    const content = buffer.trim();
    buffer = '';
    if (!content) return;
    chunks.push({
      index: chunks.length,
      content,
      contentNorm: normalizeForSearch(content),
      headingPath: bufferHeading,
      tokenEstimate: estimateTokens(content),
    });
  };

  for (const block of blocks) {
    const lines = block.split('\n');
    const firstLine = lines[0] ?? '';

    if (lines.length === 1 && isHeading(firstLine)) {
      // A heading closes the current chunk and scopes the next ones.
      flush();
      headingPath = stripHeadingMarkers(firstLine);
      bufferHeading = headingPath;
      continue;
    }

    for (const piece of splitLongParagraph(block, maxTokens)) {
      const candidate = buffer ? `${buffer}\n\n${piece}` : piece;

      if (estimateTokens(candidate) > maxTokens && buffer) {
        const carried = tailOf(buffer, overlapTokens);
        flush();
        bufferHeading = headingPath;
        buffer = carried ? `${carried}\n\n${piece}` : piece;
      } else {
        if (!buffer) bufferHeading = headingPath;
        buffer = candidate;
      }
    }
  }
  flush();

  // Merge a runt tail into its predecessor: a two-sentence chunk retrieves
  // badly and carries no context.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (last && previous && last.tokenEstimate < minTokens) {
      const merged = `${previous.content}\n\n${last.content}`;
      chunks.splice(chunks.length - 2, 2, {
        index: previous.index,
        content: merged,
        contentNorm: normalizeForSearch(merged),
        headingPath: previous.headingPath,
        tokenEstimate: estimateTokens(merged),
      });
    }
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}
