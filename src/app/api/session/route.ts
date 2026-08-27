/**
 * Session lifecycle.
 *
 *   GET   /api/session   current state, checklist holdings and latest plan
 *   PATCH /api/session   change display language, or pick a service after
 *                        disambiguation
 *
 * The language change is the important one. It writes exactly one column and
 * touches nothing else, because a citizen switching to Urdu mid-interview must
 * keep every answer, the resolved service and their position in the flow.
 * Losing that is the single most common way this class of app abandons the
 * people it was built for.
 */
import { z } from 'zod';
import { getServiceByCode, loadServiceBundle } from '@/lib/db/knowledge';
import {
  getAnswers,
  getLatestPlan,
  setLanguage,
  toAnswerMap,
  updateSession,
} from '@/lib/db/sessions';
import { possessionVariable } from '@/lib/engine/readiness';
import { badRequest, notFound, route, LanguageParam } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route({ requireSession: true, skipRateLimit: true }, async ({ session }) => {
  const answers = await getAnswers(session.id);
  const answerMap = toAnswerMap(answers);
  const latest = await getLatestPlan(session.id);

  const bundle = session.serviceId === null ? null : await loadServiceBundle(session.serviceId);

  return {
    session: {
      token: session.token,
      status: session.status,
      language: session.preferredLanguage,
      detectedLanguage: session.detectedLanguage,
      readiness: session.readiness,
      originalQuery: session.originalQuery,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
    service: bundle
      ? {
          code: bundle.service.code,
          name: bundle.service.name,
          summary: bundle.service.summary,
          department: bundle.service.departmentName,
          officialUrl: bundle.service.officialUrl,
          onlineApplicationUrl: bundle.service.onlineApplicationUrl,
        }
      : null,
    answers: answers.map((a) => ({
      variable: a.variableCode,
      value: a.value,
      origin: a.origin,
      label: bundle?.variables.find((v) => v.code === a.variableCode)?.prompt ?? null,
    })),
    holdings: bundle
      ? Object.fromEntries(
          bundle.requirements.map((r) => [r.code, answerMap[possessionVariable(r.code)] ?? null]),
        )
      : {},
    latestPlan: latest,
  };
});

const PatchSchema = z.object({
  language: LanguageParam.optional(),
  /** Chosen from the disambiguation list. */
  serviceCode: z.string().min(1).max(64).optional(),
});

export const PATCH = route({ bodySchema: PatchSchema, requireSession: true }, async ({ body, session }) => {
  if (!body.language && !body.serviceCode) {
    throw badRequest('Provide `language`, `serviceCode`, or both.');
  }

  let current = session;

  if (body.language) {
    // One column. No remount, no re-key, no answer loss.
    const updated = await setLanguage(session.token, body.language);
    if (!updated) throw notFound('Session not found.');
    current = updated;
  }

  if (body.serviceCode) {
    const service = await getServiceByCode(body.serviceCode);
    if (!service) throw badRequest(`Unknown service '${body.serviceCode}'.`);

    const updated = await updateSession(session.token, {
      serviceId: service.id,
      status: 'interviewing',
      // Chosen by the citizen rather than inferred, so confidence is absolute.
      serviceConfidence: 1,
    });
    if (!updated) throw notFound('Session not found.');
    current = updated;
  }

  const answers = await getAnswers(current.id);

  return {
    session: {
      token: current.token,
      status: current.status,
      language: current.preferredLanguage,
      readiness: current.readiness,
    },
    // Returned so the client can prove to itself that nothing was dropped.
    answersRetained: answers.length,
  };
});
