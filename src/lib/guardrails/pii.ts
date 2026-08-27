/**
 * PII detection and redaction.
 *
 * This system asks citizens about identity documents, so they will type their
 * CNIC number into it. Not occasionally — routinely, because that is what the
 * question sounds like it is asking for. Treating that as an edge case is how
 * national identity numbers end up in a log aggregator.
 *
 * Policy:
 *   * Detect and mask before the text reaches a model, a log, a trace or a
 *     database column. The pipeline never needs the digits: eligibility turns
 *     on whether a document exists, not on its number.
 *   * Masking preserves shape (`#####-#######-#`) so the citizen can still see
 *     that we understood what they sent, and so a trace stays readable.
 *   * Detection is conservative on phone numbers, which overlap with fees and
 *     dates; a false positive there costs retrieval quality.
 */

export type PiiKind = 'cnic' | 'passport' | 'phone' | 'email' | 'card';

export interface PiiMatch {
  kind: PiiKind;
  /** The masked form that replaced it. The original is never retained. */
  masked: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  matches: PiiMatch[];
  hasPii: boolean;
}

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  mask: (match: string) => string;
  /** Reject a syntactic match that is not actually this kind of thing. */
  validate?: (match: string) => boolean;
}

/**
 * A Pakistani CNIC is 13 digits, conventionally written 5-7-1. Both the
 * hyphenated and bare forms are common in user input.
 */
const CNIC_HYPHENATED = /\b\d{5}-\d{7}-\d\b/g;
const CNIC_BARE = /\b\d{13}\b/g;

/** Pakistani machine-readable passport numbers: two letters then seven digits. */
const PASSPORT = /\b[A-Z]{2}\d{7}\b/g;

/**
 * Phone numbers, deliberately narrow: an explicit +92 / 0092 country code, or
 * a leading 03 mobile prefix. A bare run of digits is far more likely to be a
 * fee, a form number or a year.
 */
const PHONE = /\b(?:\+92|0092|92)?[-\s]?0?3\d{2}[-\s]?\d{7}\b/g;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** 13-19 digit payment card runs. No government service here should ever see one. */
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;

function maskDigits(input: string): string {
  return input.replace(/\d/g, '#');
}

function luhn(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const DETECTORS: readonly Detector[] = [
  { kind: 'cnic', pattern: CNIC_HYPHENATED, mask: maskDigits },
  { kind: 'email', pattern: EMAIL, mask: () => '[email]' },
  // Card before bare-CNIC so a 16-digit card is not mislabelled as a CNIC.
  { kind: 'card', pattern: CARD, mask: maskDigits, validate: luhn },
  { kind: 'cnic', pattern: CNIC_BARE, mask: maskDigits },
  { kind: 'passport', pattern: PASSPORT, mask: (m) => `${m.slice(0, 2)}#######` },
  { kind: 'phone', pattern: PHONE, mask: maskDigits },
];

/**
 * Mask every PII occurrence in a string.
 *
 * Applied at the API boundary before anything is stored, logged or sent to a
 * provider. Idempotent: masked output contains no digits to re-detect.
 */
export function redactPii(input: string): RedactionResult {
  if (!input) return { text: '', matches: [], hasPii: false };

  const matches: PiiMatch[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  let text = input;

  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    const replacements: Array<{ start: number; end: number; value: string }> = [];

    for (const match of text.matchAll(detector.pattern)) {
      const raw = match[0];
      const start = match.index ?? -1;
      if (start < 0) continue;
      const end = start + raw.length;
      if (overlaps(start, end)) continue;
      if (detector.validate && !detector.validate(raw)) continue;

      const masked = detector.mask(raw);
      claimed.push([start, end]);
      replacements.push({ start, end, value: masked });
      matches.push({ kind: detector.kind, masked, start, end });
    }

    // Apply right-to-left so earlier offsets stay valid. Masks are the same
    // length as what they replace (except emails), so offsets stay stable
    // enough for the trace view.
    for (const r of replacements.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, r.start) + r.value + text.slice(r.end);
    }
  }

  return { text, matches, hasPii: matches.length > 0 };
}

/** Mask a value being written to a trace or a document-check record. */
export function maskValue(kind: PiiKind, value: string): string {
  switch (kind) {
    case 'email':
      return '[email]';
    case 'passport':
      return `${value.slice(0, 2)}${'#'.repeat(Math.max(0, value.length - 2))}`;
    default:
      return maskDigits(value);
  }
}

/**
 * Whether a field name suggests sensitive content.
 *
 * Used by the document checker to decide which extracted fields to mask before
 * persisting the check result. Errs toward masking.
 */
export function isSensitiveFieldName(name: string): boolean {
  return /(cnic|nic|nadra|passport|card|account|iban|phone|mobile|contact|dob|birth|address)/i.test(name);
}
