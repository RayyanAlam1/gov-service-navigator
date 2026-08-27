/**
 * Output guardrails: the claim verifier.
 *
 * This is the last thing between the language model and a citizen, and the
 * only mechanism that makes "zero unsupported claims" a measured property
 * rather than a hope.
 *
 * The model is given facts and asked to render them. It may still produce a
 * number, a URL, a duration or a promise that was not in what it was given —
 * not maliciously, just by completing a pattern. So every rendered string is
 * scanned for the categories of claim that can hurt a citizen if wrong:
 *
 *   fees        a wrong number sends someone to a counter with too little money
 *   durations   a wrong number sets a false expectation about a deadline
 *   URLs        an invented gov.pk URL is indistinguishable from a real one
 *   promises    "your application has been submitted" is never true here
 *
 * Anything not traceable to the supplied fact set is a violation. Under
 * STRICT_GROUNDING the offending text is replaced with the deterministic
 * rendering; otherwise it is annotated. Either way the event is written to
 * `guardrail_events`, so the hallucination rate is a query, not an estimate.
 *
 * Deliberately not an LLM-as-judge. Checking a model's arithmetic with the same
 * model, on a fee a citizen will act on, is not a control.
 */
import type { SourceRef } from '@/lib/schemas/core';

export type ClaimKind = 'currency' | 'duration' | 'count' | 'url' | 'large_number' | 'promise';

export interface ClaimViolation {
  kind: ClaimKind;
  /** The exact text that could not be grounded. */
  text: string;
  reason: string;
}

export interface GroundingContext {
  /** Numeric values that legitimately appear, as canonical digit strings. */
  allowedNumbers: Set<string>;
  /** Full URLs taken from service rows, step action links and sources. */
  allowedUrls: Set<string>;
  /** Hostnames those URLs live on, so a path variation is still acceptable. */
  allowedHosts: Set<string>;
  /** How many steps the plan has, so "Step 3" is not read as a claim. */
  stepCount: number;
}

/* ── Context construction ─────────────────────────────────────────────── */

function canonicalNumber(raw: string): string {
  const digits = raw.replace(/[,\s٬،]/g, '');
  const n = Number.parseFloat(digits);
  if (!Number.isFinite(n)) return digits;
  // Normalise 1500.00 and 1,500 to the same key.
  return Number.isInteger(n) ? String(n) : String(n);
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export interface BuildContextInput {
  /** Fee amounts in minor units, as stored. */
  feeAmountsMinor?: readonly (number | null)[];
  /** Processing-time bounds in days. */
  dayCounts?: readonly (number | null)[];
  /** Copy counts, ages, and any other numeric requirement values. */
  otherNumbers?: readonly (number | null)[];
  urls?: readonly (string | null)[];
  sources?: readonly SourceRef[];
  stepCount?: number;
}

export function buildGroundingContext(input: BuildContextInput): GroundingContext {
  const allowedNumbers = new Set<string>();
  const allowedUrls = new Set<string>();
  const allowedHosts = new Set<string>();

  for (const minor of input.feeAmountsMinor ?? []) {
    if (minor === null || minor === undefined) continue;
    // A fee stored as paisa may legitimately be rendered as rupees.
    allowedNumbers.add(canonicalNumber(String(minor)));
    allowedNumbers.add(canonicalNumber(String(minor / 100)));
  }
  for (const value of [...(input.dayCounts ?? []), ...(input.otherNumbers ?? [])]) {
    if (value === null || value === undefined) continue;
    allowedNumbers.add(canonicalNumber(String(value)));
  }

  const addUrl = (url: string | null | undefined) => {
    if (!url) return;
    allowedUrls.add(url.replace(/\/+$/, '').toLowerCase());
    const host = hostOf(url);
    if (host) allowedHosts.add(host);
  };

  for (const url of input.urls ?? []) addUrl(url);
  for (const source of input.sources ?? []) addUrl(source.url);

  return { allowedNumbers, allowedUrls, allowedHosts, stepCount: input.stepCount ?? 0 };
}

/* ── Claim extraction ─────────────────────────────────────────────────── */

const CURRENCY_PATTERNS: readonly RegExp[] = [
  /(?:PKR|Rs\.?|rupees?|روپے|روپیہ)\s*([\d][\d,٬،.]*)/gi,
  /([\d][\d,٬،.]*)\s*(?:PKR|Rs\.?|rupees?|روپے)/gi,
];

const DURATION_PATTERN =
  /\b([\d][\d,]*)\s*(?:working\s+|kaam\s+ke\s+)?(days?|weeks?|months?|years?|din|hafte?|mahine?|saal|دن|ہفتے?|مہینے?|سال)\b/gi;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

const LARGE_NUMBER_PATTERN = /\b\d{3,}\b/g;

/**
 * Small integers in a counting context.
 *
 * "You need 4 documents" is as dangerous as an invented fee and is a single
 * digit, so the large-number rule misses it entirely: a citizen who packs four
 * papers for a six-paper checklist is turned away at the counter. Restricted
 * to explicit count nouns so that ordinals ("step 3 of 5") and dates stay
 * exempt.
 */
const COUNT_PATTERN =
  /\b(\d{1,3})\s*(documents?|copies|copy|photocopies|photographs?|photos?|pictures?|forms?|originals?|attestations?|witnesses?|dastavez|dastawez|kaghaz|دستاویزات?|کاپیاں|تصاویر)\b/gi;

/**
 * Statements that are never true of this system.
 *
 * The product spec is explicit: do not claim the AI can submit a government
 * application unless a real integration exists. There is none, so any phrasing
 * that implies submission, approval or a guarantee is a hard violation
 * regardless of what the facts contain.
 */
const FORBIDDEN_PROMISES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'claims_submission', pattern: /\b(I|we)\s+(have\s+)?(submitted|filed|lodged|registered)\s+(your|the)\s+(application|form|request)/i },
  { id: 'claims_will_submit', pattern: /\b(I|we)\s+will\s+(submit|file|lodge|apply)\s+(this|it|your|the)\b/i },
  { id: 'claims_approval', pattern: /\byour\s+(application|request|cnic|passport|domicile)\s+(has\s+been|is)\s+(approved|issued|accepted)\b/i },
  { id: 'claims_booking', pattern: /\b(I|we)\s+(have\s+)?booked\s+(your|an)\s+appointment\b/i },
  { id: 'guarantees_outcome', pattern: /\b(guaranteed|we guarantee|definitely will be (approved|issued)|100%\s+(sure|approved))\b/i },
  { id: 'impersonates_department', pattern: /\b(this is|I am)\s+(NADRA|the\s+(passport|immigration)\s+office|the government)\b/i },
];

function stripLocaleDigits(text: string): string {
  // Arabic-Indic digits must be caught by the numeric patterns too.
  const map: Record<string, string> = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };
  let out = '';
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}

/**
 * Verify one rendered string against the fact set.
 *
 * Small integers up to the plan's step count are exempt: "Step 3 of 5" is
 * structure, not a claim. Everything else that looks like a fee, a duration,
 * a URL or a three-digit-plus number must be traceable.
 */
export function verifyText(text: string, context: GroundingContext): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  if (!text) return violations;

  const normalized = stripLocaleDigits(text);
  const seen = new Set<string>();
  const flag = (kind: ClaimKind, claim: string, reason: string) => {
    const key = `${kind}:${claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ kind, text: claim, reason });
  };

  for (const pattern of CURRENCY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      if (!context.allowedNumbers.has(canonicalNumber(raw))) {
        flag('currency', match[0], 'no fee with this amount is recorded for this service');
      }
    }
  }

  DURATION_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(DURATION_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    if (!context.allowedNumbers.has(canonicalNumber(raw))) {
      flag('duration', match[0], 'no processing time with this value is recorded for this service');
    }
  }

  COUNT_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(COUNT_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    if (!context.allowedNumbers.has(canonicalNumber(raw))) {
      flag('count', match[0], 'this count does not match the checklist derived from the rules');
    }
  }

  URL_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;)]+$/, '');
    const normalizedUrl = url.replace(/\/+$/, '').toLowerCase();
    const host = hostOf(url);
    if (context.allowedUrls.has(normalizedUrl)) continue;
    if (host && context.allowedHosts.has(host)) continue;
    flag(
      'url',
      url,
      host
        ? `${host} is not among the official sources recorded for this service`
        : 'malformed link',
    );
  }

  LARGE_NUMBER_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(LARGE_NUMBER_PATTERN)) {
    const raw = match[0];
    // Skip numbers already reported as part of a currency or duration claim,
    // and anything inside a URL we have already judged.
    if (violations.some((v) => v.text.includes(raw))) continue;
    if (context.allowedNumbers.has(canonicalNumber(raw))) continue;
    // Four-digit values in a plausible year range are dates, not claims.
    const asNumber = Number.parseInt(raw, 10);
    if (raw.length === 4 && asNumber >= 1900 && asNumber <= 2100) continue;
    if (normalized.includes(`http`) && new RegExp(`https?://[^\\s]*${raw}`).test(normalized)) continue;
    flag('large_number', raw, 'this number does not appear in the retrieved facts');
  }

  for (const { id, pattern } of FORBIDDEN_PROMISES) {
    const match = pattern.exec(normalized);
    if (match) {
      flag('promise', match[0], `forbidden claim (${id}): this system cannot perform or guarantee this`);
    }
  }

  return violations;
}

export interface VerifiedField {
  /** Which field of the rendered payload this was, for the audit trail. */
  path: string;
  original: string;
  /** What will actually be shown. Equals `original` when there was nothing to fix. */
  final: string;
  violations: ClaimViolation[];
}

export interface OutputVerificationResult {
  ok: boolean;
  fields: VerifiedField[];
  violations: ClaimViolation[];
  /** True when at least one field was replaced by its deterministic rendering. */
  replaced: boolean;
}

/**
 * Verify a set of model-rendered fields against the facts, replacing any
 * ungroundable field with the deterministic rendering of the same content.
 *
 * The fallback is per-field rather than all-or-nothing: one invented fee in a
 * summary paragraph should not discard a correctly translated checklist.
 */
export function verifyRendered(
  fields: ReadonlyArray<{ path: string; rendered: string; deterministic: string }>,
  context: GroundingContext,
  strict: boolean,
): OutputVerificationResult {
  const verified: VerifiedField[] = [];
  const all: ClaimViolation[] = [];
  let replaced = false;

  for (const field of fields) {
    const violations = verifyText(field.rendered, context);
    all.push(...violations);

    const shouldReplace = violations.length > 0 && strict;
    if (shouldReplace) replaced = true;

    verified.push({
      path: field.path,
      original: field.rendered,
      final: shouldReplace ? field.deterministic : field.rendered,
      violations,
    });
  }

  return { ok: all.length === 0, fields: verified, violations: all, replaced };
}
