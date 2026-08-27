/**
 * POST /api/intake
 *
 * The front door. Takes the citizen's opening sentence and returns one of
 * three shapes:
 *
 *   refused        the input guardrail blocked it, with a message in the
 *                  citizen's own language
 *   disambiguate   several services are plausible; ask rather than guess
 *   session        the service is resolved and the interview can begin
 *
 * The response deliberately does not include a plan. Resolving a service is
 * not the same as knowing the citizen's situation, and answering before the
 * interview is exactly the "generic procedure dump" this product exists to
 * replace.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config/env';
import { loadServiceBundle } from '@/lib/db/knowledge';
import { createSession, updateSession } from '@/lib/db/sessions';
import { applyInferredAnswers, runIntake } from '@/lib/engine/orchestrator';
import { persistGuardrailEvent, persistTrace } from '@/lib/agents/base';
import { route, LanguageParam } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  query: z.string().min(1).max(getConfig().MAX_INPUT_CHARS),
  /** Set when the citizen picked a language rather than just typing. */
  language: LanguageParam.optional(),
});

export const POST = route({ bodySchema: BodySchema }, async ({ body, fingerprint, log }) => {
  const session = await createSession({
    language: body.language ?? 'en',
    originalQuery: body.query,
    normalizedQuery: null,
    clientFingerprint: fingerprint,
  });

  const intake = await runIntake({
    session,
    query: body.query,
    explicitLanguage: body.language ?? null,
  });

  // The guardrail's sanitized text is what gets stored — the raw input, which
  // may contain a CNIC number, is never persisted.
  await updateSession(session.token, {
    detectedLanguage: intake.guardrail.language.language,
    preferredLanguage: intake.language,
    normalizedQuery: intake.guardrail.sanitized || null,
    ...(intake.guardrail.ok ? {} : { originalQuery: null }),
  });

  for (const finding of intake.guardrail.findings) {
    void persistGuardrailEvent({
      sessionId: session.id,
      turnId: intake.context.turnId,
      direction: 'input',
      rule: finding.rule,
      severity: finding.severity,
      action: intake.guardrail.action,
      detail: { detail: finding.detail },
    });
  }

  await persistTrace(intake.context);

  if (!intake.guardrail.ok) {
    log.info({ rules: intake.guardrail.findings.map((f) => f.rule) }, 'intake refused');
    return {
      kind: 'refused' as const,
      sessionToken: session.token,
      language: intake.language,
      refusal: intake.guardrail.refusal,
      findings: intake.guardrail.findings.map((f) => ({ rule: f.rule, severity: f.severity })),
      turnId: intake.context.turnId,
    };
  }

  const resolution = intake.resolution;

  if (!resolution?.resolved) {
    return {
      kind: 'disambiguate' as const,
      sessionToken: session.token,
      language: intake.language,
      candidates: (resolution?.candidates ?? []).slice(0, 4).map((c) => ({
        code: c.serviceCode,
        name: c.service.name,
        summary: c.service.summary,
        confidence: Number(c.confidence.toFixed(2)),
        matchedOn: c.matchedAliases,
      })),
      reasoning: resolution?.reasoning ?? [],
      turnId: intake.context.turnId,
    };
  }

  const bundle = await loadServiceBundle(resolution.resolved.service.id);
  if (!bundle) throw new Error('resolved service bundle could not be loaded');

  // Inferred answers are stored as assumptions, not as statements the citizen
  // made. The UI shows them as correctable chips.
  const applied = await applyInferredAnswers(session.id, bundle, intake.inferredAnswers);

  await updateSession(session.token, {
    status: 'interviewing',
    serviceId: bundle.service.id,
    serviceConfidence: resolution.resolved.confidence,
    locationCity: intake.inferredAnswers.find((a) => a.variableCode === 'city')?.value as string | undefined ?? null,
    locationProvince:
      (intake.inferredAnswers.find((a) => a.variableCode === 'province')?.value as string | undefined) ?? null,
  });

  return {
    kind: 'session' as const,
    sessionToken: session.token,
    language: intake.language,
    service: {
      code: bundle.service.code,
      name: bundle.service.name,
      summary: bundle.service.summary,
      department: bundle.service.departmentName,
      officialUrl: bundle.service.officialUrl,
      onlineApplicationUrl: bundle.service.onlineApplicationUrl,
      verificationStatus: bundle.service.verificationStatus,
    },
    confidence: Number(resolution.resolved.confidence.toFixed(2)),
    reasoning: resolution.reasoning,
    assumptions: intake.inferredAnswers
      .filter((a) => applied.includes(a.variableCode))
      .map((a) => ({
        variable: a.variableCode,
        value: a.value,
        evidence: a.evidence,
        label:
          bundle.variables.find((v) => v.code === a.variableCode)?.prompt.en ?? a.variableCode,
      })),
    turnId: intake.context.turnId,
  };
});
