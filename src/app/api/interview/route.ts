/**
 * POST /api/interview
 *
 * One turn of the adaptive interview. Optionally records an answer, then either
 * returns the next question or — when no remaining question could change the
 * outcome — the finished plan.
 *
 * The branch is decided by information gain over the rule set, never by a
 * model. `debug.skippedAsUseless` exposes the questions the planner considered
 * and discarded, which is the most direct evidence that "it only asks what
 * matters" is a mechanism rather than a slogan.
 */
import { z } from 'zod';
import { loadServiceBundle } from '@/lib/db/knowledge';
import { getAskedVariables, saveAnswer, savePlan, updateSession } from '@/lib/db/sessions';
import { advanceSession } from '@/lib/engine/orchestrator';
import { planSources } from '@/lib/engine/plan';
import { badRequest, notFound, route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AnswerValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

const BodySchema = z.object({
  /** Omit on the first call to receive the opening question. */
  answer: z
    .object({
      variable: z.string().min(1).max(64),
      value: AnswerValue,
    })
    .optional(),
  /** Skip a question the citizen does not want to answer. */
  skip: z.string().min(1).max(64).optional(),
  /** Stop interviewing and generate the plan with what we have. */
  finish: z.boolean().optional(),
});

export const POST = route({ bodySchema: BodySchema, requireSession: true }, async ({ body, session }) => {
  if (session.serviceId === null) {
    throw badRequest('No service has been resolved for this session yet. Call /api/intake first.');
  }

  const bundle = await loadServiceBundle(session.serviceId);
  if (!bundle) throw notFound('Service not found.');

  if (body.answer) {
    const variable = bundle.variables.find((v) => v.code === body.answer?.variable);
    if (!variable) throw badRequest(`Unknown variable '${body.answer.variable}'.`);

    // Coerce to the variable's declared domain rather than trusting the client:
    // a string "18" answering a numeric rule would otherwise evaluate as
    // unknown and silently stall the interview.
    const value = coerce(body.answer.value, variable.type);
    await saveAnswer({
      sessionId: session.id,
      variableCode: variable.code,
      value,
      origin: 'user',
      confidence: 1,
    });
  }

  if (body.skip) {
    // Recording a skip as an explicit null is what stops the planner from
    // asking the same question forever.
    await saveAnswer({
      sessionId: session.id,
      variableCode: body.skip,
      value: null,
      origin: 'user',
      confidence: 0,
    });
  }

  const asked = await getAskedVariables(session.id);

  const turn = await advanceSession({
    session,
    serviceId: bundle.service.id,
    language: session.preferredLanguage,
    forcePlan: body.finish === true,
  });

  if (turn.outcome.kind === 'question') {
    const q = turn.outcome.question;
    const trace = turn.context.steps.find((s) => s.agent === 'interview_planner');

    return {
      kind: 'question' as const,
      question: {
        variable: q.variableCode,
        type: q.type,
        text: q.question,
        help: q.help,
        why: q.why,
        options: q.options,
      },
      progress: Number(turn.outcome.progress.toFixed(2)),
      askedCount: turn.outcome.askedCount,
      language: session.preferredLanguage,
      debug: {
        // Shown in the trace panel: the questions that were considered and
        // discarded because no answer to them could change the outcome.
        skippedAsUseless: trace?.output.skippedAsUseless ?? [],
        openVariables: trace?.output.openVariables ?? [],
        selectionRationale: trace?.notes ?? null,
        alreadyAsked: asked,
      },
      turnId: turn.context.turnId,
    };
  }

  if (turn.outcome.kind !== 'plan') {
    throw badRequest('Unexpected interview state.');
  }

  const { plan, readiness, composed, evidence, grounding } = turn.outcome;

  const version = await savePlan({
    sessionId: session.id,
    plan,
    readiness,
    evidence: evidence.map((e) => ({
      chunkId: e.chunkId,
      documentTitle: e.documentTitle,
      score: Number(e.score.toFixed(3)),
      source: e.source,
    })),
    groundingReport: grounding,
    language: session.preferredLanguage,
  });

  await updateSession(session.token, {
    status: 'planned',
    scenarioId: bundle.scenarios.find((s) => s.code === turn.scenarioCode)?.id ?? null,
    readiness: readiness.state,
  });

  return {
    kind: 'plan' as const,
    version,
    language: session.preferredLanguage,
    plan,
    readiness,
    text: composed.text,
    sources: planSources(plan),
    evidence: evidence.map((e) => ({
      chunkId: e.chunkId,
      documentTitle: e.documentTitle,
      headingPath: e.headingPath,
      excerpt: e.content.slice(0, 400),
      score: Number(e.score.toFixed(3)),
      similarity: e.vectorSimilarity === null ? null : Number(e.vectorSimilarity.toFixed(3)),
      retrievedBy: e.retrievedBy,
      source: e.source,
    })),
    grounding: {
      ...grounding,
      // Rounded for display; the raw value stays in session_plans.
      deterministicShare: Number(grounding.deterministicShare.toFixed(2)),
    },
    turnId: turn.context.turnId,
  };
});

/** Bring a client-supplied answer into the variable's declared domain. */
function coerce(value: string | number | boolean | null, type: string): string | number | boolean | null {
  if (value === null) return null;

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const v = String(value).trim().toLowerCase();
    if (['yes', 'true', '1', 'haan', 'han', 'ji', 'ہاں'].includes(v)) return true;
    if (['no', 'false', '0', 'nahi', 'nahin', 'نہیں'].includes(v)) return false;
    return null;
  }

  if (type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return typeof value === 'string' ? value.trim() : value;
}
