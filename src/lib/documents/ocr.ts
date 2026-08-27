/**
 * Document intelligence.
 *
 * ── Privacy posture ────────────────────────────────────────────────────────
 *
 * Uploaded bytes are processed in memory and discarded before the request
 * returns. Nothing is written to disk, no path is stored, and the database
 * table for checks has no column that could hold an image or raw OCR text —
 * only the structured verdict. Extracted values that look like identifiers are
 * masked before they are persisted or traced.
 *
 * That is not caution for its own sake. This system asks citizens about
 * identity documents, so it will be handed CNIC images; a demo that quietly
 * accumulates a folder of national ID scans is a liability that outlives the
 * demo.
 *
 * ── Why the extractor is a mock ────────────────────────────────────────────
 *
 * Real OCR is behind the same interface, and swapping it in is one class. What
 * is deliberately NOT done is shipping a plausible-looking OCR that is actually
 * guessing, because a document checker that says "match" without reading the
 * document is worse than none: the citizen trusts it and stops checking.
 *
 * So the mock is explicit about what it is. It reads synthetic demo documents
 * (a small text-based format) and returns real extracted fields for those. Hand
 * it a photograph and it returns `unreadable` with a clear reason — which is
 * the honest answer, and which the readiness engine handles correctly.
 */
import { isSensitiveFieldName, maskValue, type PiiKind } from '@/lib/guardrails/pii';
import type { DocumentMatchStatus } from '@/lib/schemas/core';
import type { ExtractedField } from '@/lib/schemas/domain';

export interface OcrInput {
  /** Raw bytes. Never persisted. */
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  /** The requirement's `document_type` the citizen says this satisfies. */
  declaredType: string;
}

export interface OcrResult {
  detectedType: string | null;
  fields: ExtractedField[];
  confidence: number;
  issues: string[];
  /** True when the extractor could not read the document at all. */
  unreadable: boolean;
}

export interface OcrProvider {
  readonly name: string;
  extract(input: OcrInput): Promise<OcrResult>;
}

/* ── Synthetic document format ────────────────────────────────────────────
 * Demo documents are plain text with `KEY: value` lines and a `TYPE:` header.
 * Simple on purpose: the point of the demo is the *checking* logic — matching
 * extracted fields against a requirement — not a computer-vision showcase.
 *
 * Sample documents live in data/samples/. They contain invented names and
 * masked numbers, and none of them corresponds to a real person.
 */

const TEXT_MIME = /^(text\/|application\/json)/;
const MAX_TEXT_BYTES = 64 * 1024;

function parseSyntheticDocument(text: string): { type: string | null; fields: Map<string, string> } {
  const fields = new Map<string, string>();
  let type: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase().replace(/\s+/g, '_');
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;

    if (key === 'type' || key === 'document_type') {
      type = value.toLowerCase().replace(/\s+/g, '_');
      continue;
    }
    fields.set(key, value);
  }

  return { type, fields };
}

function piiKindFor(fieldName: string): PiiKind | null {
  if (/cnic|nic|nadra/i.test(fieldName)) return 'cnic';
  if (/passport/i.test(fieldName)) return 'passport';
  if (/phone|mobile|contact/i.test(fieldName)) return 'phone';
  if (/email/i.test(fieldName)) return 'email';
  return null;
}

class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';

  async extract(input: OcrInput): Promise<OcrResult> {
    const isText = TEXT_MIME.test(input.mimeType) || /\.(txt|json|md)$/i.test(input.fileName);

    if (!isText) {
      // The honest answer for an image. `unreadable` propagates to the
      // checklist as "we could not verify this", never as a pass.
      return {
        detectedType: null,
        fields: [],
        confidence: 0,
        issues: [
          `The demo document checker reads synthetic text documents only, and this is ${input.mimeType || 'an unrecognised format'}.`,
          'Real OCR plugs in behind the same interface — see src/lib/documents/ocr.ts.',
        ],
        unreadable: true,
      };
    }

    if (input.bytes.byteLength > MAX_TEXT_BYTES) {
      return {
        detectedType: null,
        fields: [],
        confidence: 0,
        issues: ['Document is too large to process.'],
        unreadable: true,
      };
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);
    const { type, fields } = parseSyntheticDocument(text);

    if (fields.size === 0) {
      return {
        detectedType: type,
        fields: [],
        confidence: 0,
        issues: ['No readable fields were found in this document.'],
        unreadable: true,
      };
    }

    const extracted: ExtractedField[] = [];
    for (const [name, value] of fields) {
      const kind = piiKindFor(name);
      const sensitive = kind !== null || isSensitiveFieldName(name);
      extracted.push({
        name,
        // Masked at extraction, not at persistence: the unmasked value never
        // exists anywhere it could be logged.
        value: kind ? maskValue(kind, value) : sensitive ? maskValue('cnic', value) : value,
        confidence: 0.95,
        redacted: sensitive,
      });
    }

    return {
      detectedType: type,
      fields: extracted,
      confidence: type ? 0.95 : 0.6,
      issues: type ? [] : ['Document did not declare its type; matching is by field content only.'],
      unreadable: false,
    };
  }
}

export function getOcrProvider(): OcrProvider {
  // OCR_PROVIDER only accepts 'mock' by design — see the header note.
  return new MockOcrProvider();
}

/* ── Matching ─────────────────────────────────────────────────────────── */

export interface MatchInput {
  result: OcrResult;
  declaredType: string;
  /** Field values the checklist expects, where known. */
  expected?: Record<string, string | number | null>;
}

export interface MatchVerdict {
  status: DocumentMatchStatus;
  confidence: number;
  issues: string[];
}

const EXPIRY_FIELDS = ['expiry', 'expires', 'expiry_date', 'valid_until', 'date_of_expiry'];

/**
 * Decide whether an uploaded document satisfies a requirement.
 *
 * Ordering matters and is conservative: unreadable and wrong-type are decided
 * before any field comparison, and an expired document fails regardless of how
 * well its fields match. A citizen holding an expired B-Form is not ready, and
 * saying otherwise sends them to a counter to be turned away.
 */
export function matchDocument({ result, declaredType, expected = {} }: MatchInput): MatchVerdict {
  if (result.unreadable) {
    return { status: 'unreadable', confidence: 0, issues: result.issues };
  }

  const issues = [...result.issues];

  if (result.detectedType && result.detectedType !== declaredType) {
    return {
      status: 'wrong_document',
      confidence: result.confidence,
      issues: [
        ...issues,
        `This looks like a ${humanise(result.detectedType)}, but it was submitted as a ${humanise(declaredType)}.`,
      ],
    };
  }

  const byName = new Map(result.fields.map((f) => [f.name, f.value] as const));

  for (const field of EXPIRY_FIELDS) {
    const raw = byName.get(field);
    if (!raw) continue;
    const expiry = new Date(raw);
    if (Number.isNaN(expiry.getTime())) continue;
    if (expiry.getTime() < Date.now()) {
      return {
        status: 'expired',
        confidence: result.confidence,
        issues: [...issues, `This document expired on ${expiry.toISOString().slice(0, 10)}.`],
      };
    }
  }

  const comparisons = Object.entries(expected).filter(([, value]) => value !== null && value !== undefined);
  const mismatches: string[] = [];

  for (const [key, value] of comparisons) {
    const actual = byName.get(key);
    if (actual === undefined) continue;
    if (normalise(actual) !== normalise(String(value))) {
      mismatches.push(`${humanise(key)} does not match what you told us.`);
    }
  }

  if (mismatches.length > 0) {
    return { status: 'mismatch', confidence: result.confidence, issues: [...issues, ...mismatches] };
  }

  // A document that read cleanly but had nothing to compare against is not a
  // confirmed match; it is inconclusive. The readiness engine treats that as
  // "still unknown" rather than as satisfied.
  if (comparisons.length === 0 && !result.detectedType) {
    return {
      status: 'inconclusive',
      confidence: result.confidence * 0.6,
      issues: [...issues, 'We could read this document but could not confirm it is the right one.'],
    };
  }

  return { status: 'match', confidence: result.confidence, issues };
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[-/]/g, '');
}

function humanise(key: string): string {
  return key.replace(/_/g, ' ');
}
