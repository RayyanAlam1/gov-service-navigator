/**
 * POST /api/readiness — "Am I Ready?"
 *
 * The citizen ticks which documents they hold; this recomputes the delta.
 *
 * Possession is recorded as a normal interview answer under the `has_<code>`
 * convention, which means it flows through the same rules engine as everything
 * else — a document the citizen has can therefore satisfy a substitution rule,
 * and ticking one box can legitimately remove another item from the list.
 *
 * The verdict is conservative by construction (see engine/readiness.ts): an
 * unticked box is never treated as held, and a fired blocking rule caps the
 * result at not-ready regardless of how complete the paperwork is.
 */
import { z } from 'zod';
import { loadServiceBundle } from '@/lib/db/knowledge';
import { getAnswers, saveAnswers, toAnswerMap, updateSession } from '@/lib/db/sessions';
import { possessionVariable } from '@/lib/engine/readiness';
import { advanceSession } from '@/lib/engine/orchestrator';
import { badRequest, notFound, route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  /** requirementCode -> does the citizen have it. */
  holdings: z.record(z.string().min(1).max(64), z.boolean()),
});

export const POST = route({ bodySchema: BodySchema, requireSession: true }, async ({ body, session }) => {
  if (session.serviceId === null) {
    throw badRequest('No service has been resolved for this session yet.');
  }

  const bundle = await loadServiceBundle(session.serviceId);
  if (!bundle) throw notFound('Service not found.');

  // Only accept codes that are real requirements of this service. A client
  // cannot invent a possession variable and steer the rules engine with it.
  const known = new Set(bundle.requirements.map((r) => r.code));
  const accepted: Array<{ variableCode: string; value: boolean; origin: 'user' }> = [];
  const rejected: string[] = [];

  for (const [code, held] of Object.entries(body.holdings)) {
    if (!known.has(code)) {
      rejected.push(code);
      continue;
    }
    accepted.push({ variableCode: possessionVariable(code), value: held, origin: 'user' });
  }

  await saveAnswers(session.id, accepted);

  const turn = await advanceSession({
    session,
    serviceId: bundle.service.id,
    language: session.preferredLanguage,
    // Ticking boxes must not restart the interview.
    forcePlan: true,
  });

  if (turn.outcome.kind !== 'plan') throw badRequest('Could not recompute readiness.');

  const { plan, readiness, composed, grounding } = turn.outcome;

  await updateSession(session.token, { readiness: readiness.state });

  const answers = toAnswerMap(await getAnswers(session.id));

  return {
    readiness,
    checklist: plan.checklist,
    text: composed.text,
    caveats: plan.caveats,
    grounding: {
      violations: grounding.violations,
      deterministicShare: Number(grounding.deterministicShare.toFixed(2)),
    },
    /** Echoed so the UI can render tick state from the server's view, not its own. */
    holdings: Object.fromEntries(
      bundle.requirements.map((r) => [r.code, answers[possessionVariable(r.code)] ?? null]),
    ),
    ...(rejected.length > 0
      ? { warnings: [`Ignored unknown requirement code(s): ${rejected.join(', ')}`] }
      : {}),
    turnId: turn.context.turnId,
  };
});
