/**
 * Text normalization for a trilingual corpus.
 *
 * Postgres has no Urdu stemmer and no Roman-Urdu anything, so the lexical arm
 * of hybrid retrieval only works if both the corpus and the query are folded
 * into a shared shape first. That is what `content_norm` in document_chunks
 * holds, and what this module produces.
 *
 * The folding is deliberately conservative. Aggressive Roman-Urdu
 * normalization destroys real distinctions (`main` = I, `mein` = in) and the
 * cost of a wrong merge is a wrong retrieval on a legal procedure. Semantic
 * recall is the vector arm's job; this arm only has to make obvious spelling
 * variance stop mattering.
 */

/** Arabic-Indic and extended Arabic-Indic digits -> ASCII. */
const DIGIT_MAP: Readonly<Record<string, string>> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/**
 * Urdu orthographic variants that must collapse.
 *
 * Urdu text in the wild mixes Arabic and Urdu codepoints for the same letter —
 * an official PDF may use ي where a citizen types ی. Without this, the two
 * simply never match.
 */
const URDU_LETTER_MAP: Readonly<Record<string, string>> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ے': 'ی',
  'ة': 'ہ', 'ه': 'ہ', 'ھ': 'ہ',
  'ك': 'ک',
  'ؤ': 'و',
};

/** Tashkeel / harakat and joiners: invisible or decorative, never semantic here. */
const URDU_STRIP = /[ؐ-ًؚ-ٰٟۖ-ۭ​-‏⁠﻿]/g;

/** Combining marks left over after NFD, for Latin text. */
const COMBINING = /[̀-ͯ]/g;

export const URDU_SCRIPT_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const URDU_SCRIPT_GLOBAL = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_LETTER_GLOBAL = /[A-Za-z]/g;

export function containsUrduScript(text: string): boolean {
  return URDU_SCRIPT_RANGE.test(text);
}

/** Proportion of letters written in Arabic script, 0..1. */
export function urduScriptRatio(text: string): number {
  const urdu = text.match(URDU_SCRIPT_GLOBAL)?.length ?? 0;
  const latin = text.match(LATIN_LETTER_GLOBAL)?.length ?? 0;
  const total = urdu + latin;
  return total === 0 ? 0 : urdu / total;
}

function mapChars(text: string, table: Readonly<Record<string, string>>): string {
  let out = '';
  for (const ch of text) out += table[ch] ?? ch;
  return out;
}

/**
 * Fold a string into its search-normal form.
 *
 * Applied identically at ingest time (to build `content_norm`) and at query
 * time. If the two ever diverge, lexical retrieval silently degrades to
 * nothing, so both paths call exactly this function.
 */
export function normalizeForSearch(input: string): string {
  if (!input) return '';

  let text = input.normalize('NFKC');
  text = mapChars(text, DIGIT_MAP);
  text = text.replace(URDU_STRIP, '');
  text = mapChars(text, URDU_LETTER_MAP);

  // Latin side: strip accents, lowercase.
  text = text.normalize('NFD').replace(COMBINING, '').normalize('NFC').toLowerCase();

  // Punctuation (Latin and Urdu) becomes whitespace so tokens split cleanly.
  text = text.replace(/[.,;:!?()[\]{}"'`~@#$%^&*_+=|\\/<>«»“”‘’—–…،؛؟٪]/g, ' ');
  text = text.replace(/[-]+/g, ' ');

  // Collapse letter runs: "aaap" -> "aap", "hellooo" -> "helloo". Two is the
  // floor because Roman Urdu uses doubling meaningfully ("aap", "hai" vs "haii").
  text = text.replace(/([a-z؀-ۿ])\1{2,}/g, '$1$1');

  return text.replace(/\s+/g, ' ').trim();
}

/** Tokens for lexical scoring and lexicon matching. */
export function tokenize(input: string): string[] {
  const normalized = normalizeForSearch(input);
  if (!normalized) return [];
  return normalized.split(' ').filter((t) => t.length > 0);
}

/**
 * A stable key for near-duplicate detection.
 *
 * Used by the ingest pipeline to avoid indexing the same paragraph twice when
 * a department publishes the same notice on two pages.
 */
export function shingleKey(input: string, size = 8): string {
  const tokens = tokenize(input);
  return tokens.slice(0, size).join(' ');
}

/**
 * Truncate on a word boundary, for trace summaries and UI snippets.
 * Never used for anything a decision depends on.
 */
export function truncateWords(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const cut = input.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
