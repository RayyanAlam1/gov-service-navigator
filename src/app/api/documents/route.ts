/**
 * POST /api/documents — document check.
 *
 * multipart/form-data: `file`, `requirement`.
 *
 * ── What happens to the bytes ──────────────────────────────────────────────
 *
 * They are read into memory, passed to the extractor, and dropped when this
 * function returns. Nothing is written to disk, no path is recorded, and the
 * `document_checks` table has no column capable of holding an image or raw OCR
 * text. Extracted values that look like identifiers are masked at extraction
 * time, so an unmasked CNIC never exists anywhere it could be logged.
 *
 * A `match` verdict feeds the readiness engine as evidence the citizen holds
 * the document. `expired`, `wrong_document` and `mismatch` actively *overturn*
 * a self-reported "yes, I have it" — which is the entire value of the feature:
 * a citizen who believes they are ready and is not, finds out here rather than
 * at a counter.
 */
import { getConfig } from '@/lib/config/env';
import { sql } from '@/lib/db/client';
import { loadServiceBundle } from '@/lib/db/knowledge';
import { getAnswers, saveAnswer, toAnswerMap } from '@/lib/db/sessions';
import { getOcrProvider, matchDocument } from '@/lib/documents/ocr';
import { possessionVariable } from '@/lib/engine/readiness';
import { badRequest, notFound, route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route({ requireSession: true }, async ({ request, session, log }) => {
  const cfg = getConfig();

  if (session.serviceId === null) {
    throw badRequest('No service has been resolved for this session yet.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest('Expected multipart/form-data with a `file` field.');
  }

  const file = form.get('file');
  const requirementCode = String(form.get('requirement') ?? '').trim();

  if (!(file instanceof File)) throw badRequest('No file was uploaded.');
  if (!requirementCode) throw badRequest('`requirement` is required.');
  if (file.size === 0) throw badRequest('The uploaded file is empty.');
  if (file.size > cfg.MAX_UPLOAD_BYTES) {
    throw badRequest(`File exceeds the ${Math.floor(cfg.MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`);
  }

  const bundle = await loadServiceBundle(session.serviceId);
  if (!bundle) throw notFound('Service not found.');

  const requirement = bundle.requirements.find((r) => r.code === requirementCode);
  if (!requirement) throw badRequest(`Unknown requirement '${requirementCode}' for this service.`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const provider = getOcrProvider();

  const answers = toAnswerMap(await getAnswers(session.id));

  const result = await provider.extract({
    bytes,
    fileName: file.name,
    mimeType: file.type,
    declaredType: requirement.documentType,
  });

  const verdict = matchDocument({
    result,
    declaredType: requirement.documentType,
    expected: {
      // Only non-sensitive, already-known values are compared. We do not ask
      // for a CNIC number in order to check one.
      city: typeof answers.city === 'string' ? answers.city : null,
      province: typeof answers.province === 'string' ? answers.province : null,
    },
  });

  // Persist the verdict only. `extracted_fields` holds masked values.
  const [row] = await sql<{ id: number }>(
    `INSERT INTO document_checks
       (session_id, requirement_id, declared_type, detected_type, match_status,
        confidence, extracted_fields, issues, ocr_provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
     RETURNING id`,
    [
      session.id,
      requirement.id,
      requirement.documentType,
      result.detectedType,
      verdict.status,
      verdict.confidence,
      JSON.stringify(result.fields),
      JSON.stringify(verdict.issues),
      provider.name,
    ],
  );

  // A confirmed match records possession; a definite failure records its
  // absence, overturning an optimistic self-report. Ambiguous outcomes
  // (unreadable, inconclusive) deliberately change nothing.
  if (verdict.status === 'match') {
    await saveAnswer({
      sessionId: session.id,
      variableCode: possessionVariable(requirement.code),
      value: true,
      origin: 'document',
      confidence: verdict.confidence,
    });
  } else if (['expired', 'wrong_document', 'mismatch'].includes(verdict.status)) {
    await saveAnswer({
      sessionId: session.id,
      variableCode: possessionVariable(requirement.code),
      value: false,
      origin: 'document',
      confidence: verdict.confidence,
    });
  }

  log.info(
    { requirement: requirement.code, status: verdict.status, bytes: file.size },
    'document checked; bytes discarded',
  );

  return {
    checkId: row?.id ?? null,
    requirement: {
      code: requirement.code,
      documentType: requirement.documentType,
      title: requirement.title,
    },
    matchStatus: verdict.status,
    confidence: Number(verdict.confidence.toFixed(2)),
    detectedType: result.detectedType,
    fields: result.fields,
    issues: verdict.issues,
    ocrProvider: provider.name,
    retained: false,
    note:
      'The uploaded file was processed in memory and discarded. Only this verdict was stored, ' +
      'with identifier-like values masked.',
  };
});

/**
 * GET /api/documents — checks recorded for this session.
 */
export const GET = route({ requireSession: true }, async ({ session }) => {
  const rows = await sql<{
    id: number;
    declared_type: string;
    detected_type: string | null;
    match_status: string;
    confidence: number;
    extracted_fields: unknown;
    issues: unknown;
    created_at: string;
    requirement_code: string | null;
  }>(
    `SELECT dc.id, dc.declared_type, dc.detected_type, dc.match_status, dc.confidence,
            dc.extracted_fields, dc.issues, dc.created_at, r.code AS requirement_code
       FROM document_checks dc
       LEFT JOIN requirements r ON r.id = dc.requirement_id
      WHERE dc.session_id = $1
      ORDER BY dc.created_at DESC
      LIMIT 50`,
    [session.id],
  );

  return {
    checks: rows.map((r) => ({
      id: r.id,
      requirementCode: r.requirement_code,
      declaredType: r.declared_type,
      detectedType: r.detected_type,
      matchStatus: r.match_status,
      confidence: Number(r.confidence),
      fields: r.extracted_fields,
      issues: r.issues,
      checkedAt: new Date(r.created_at).toISOString(),
    })),
  };
});
