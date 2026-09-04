/**
 * The orchestrator.
 *
 * Control flow here is a deterministic state machine, not an agent deciding
 * what to do next. That is a deliberate rejection of the "give the model tools
 * and let it plan" pattern: the sequence a citizen goes through is fixed,
 * knowable and auditable, and letting a model choose it would make the same
 * question produce different journeys on different runs — which is exactly
 * what you cannot have when the output is a legal procedure.
 *
 * Agents are called *at* nodes. The graph between nodes is code.
 *
 *   intake ──► guardrail ──► language ──► intent ──► resolve service
 *                                                          │
 *                        ┌─────────────────────────────────┤
 *                        ▼                                 ▼
 *                  disambiguate                     interview loop
 *                                                          │
 *                                                          ▼
 *                                             retrieve ──► decide ──► compose
 *                                                          │
 *                                                          ▼
 *                                                  verify ──► plan + readiness
 *
 * Each transition is recorded in the turn trace with a `deterministic` flag, so
 * the architecture panel can show which boxes were code and which were model.
 */
import { getConfig } from '@/lib/config/env';
import { persistTrace, TurnContext, type AgentName } from '@/lib/agents/base';
import { composePlanText, type ComposedPlan } from '@/lib/agents/composer';
import { extractIntent } from '@/lib/agents/intent';
import { phraseQuestion, type PresentedQuestion } from '@/lib/agents/phrasing';
import { findOffices, listServiceAliases, listServices, loadServiceBundle } from '@/lib/db/knowledge';
import {
  getAnswers,
  saveAnswers,
  toAnswerMap,
  type SessionRecord,
} from '@/lib/db/sessions';
import { checkInput, type InputGuardrailResult } from '@/lib/guardrails/input';
import { buildGroundingContext, verifyText, type ClaimViolation } from '@/lib/guardrails/output';
import { resolveSessionLanguage } from '@/lib/i18n/detect';
import { retrieveEvidence, type InformationNeed, type SufficiencyReport } from '@/lib/rag/agentic';
import type { AnswerMap, Language } from '@/lib/schemas/core';
import type { ActionPlan, EvidenceChunk, ReadinessReport, ServiceBundle } from '@/lib/schemas/domain';
import { planInterview, type InterviewPlan } from './interview';
import { assembleActionPlan, planFactInventory } from './plan';
import { assessReadiness, buildChecklist, possessionVariable } from './readiness';
import { decide, type DecisionState } from './rules';
import { resolveService, type ServiceCandidate, type ServiceResolution } from './service-resolver';

/* ── Turn results ─────────────────────────────────────────────────────── */

export type TurnOutcome =
  | { kind: 'refused'; refusal: { en: string; ur: string; roman_ur: string }; findings: InputGuardrailResult['findings'] }
  | { kind: 'disambiguate'; candidates: ServiceCandidate[]; reasoning: string[] }
  | { kind: 'question'; question: PresentedQuestion; progress: number; askedCount: number }
  | { kind: 'plan'; plan: ActionPlan; readiness: ReadinessReport; composed: ComposedPlan; evidence: EvidenceChunk[]; grounding: GroundingReport };

export interface GroundingReport {
  sufficiency: SufficiencyReport | null;
  violations: ClaimViolation[];
  /** Share of trace steps that ran with no model involved. */
  deterministicShare: number;
  sourcesUsed: number;
  strict: boolean;
}

export interface TurnResult {
  outcome: TurnOutcome;
  context: TurnContext;
  language: Language;
  serviceCode: string | null;
  scenarioCode: string | null;
  decision: DecisionState | null;
}

/* ── Information needs ────────────────────────────────────────────────── */

/**
 * What retrieval must find, derived from what the plan will actually assert.
 *
 * Asking for evidence we are not going to use wastes a retrieval loop; not
 * asking for evidence we *will* use means an unverified claim reaches a
 * citizen. So the need list is computed from the decision state rather than
 * fixed.
 */
function informationNeeds(state: DecisionState): InformationNeed[] {
  const needs: InformationNeed[] = ['procedure', 'documents'];
  if (state.eligibility.blocking.length > 0 || state.eligibility.outcome !== 'eligible') {
    needs.push('eligibility');
  }
  if (state.fees.some((f) => f.applicability === true)) needs.push('fees');
  if (state.processingTimes.some((t) => t.applicability === true)) needs.push('processing_time');
  if (state.exceptions.fired.length > 0) needs.push('exception');
  needs.push('office');
  return needs;
}

/* ── Intake ───────────────────────────────────────────────────────────── */

export interface IntakeInput {
  session: SessionRecord;
  query: string;
  /** Set when the citizen picked a language explicitly rather than by typing. */
  explicitLanguage?: Language | null;
}

export interface IntakeResult {
  guardrail: InputGuardrailResult;
  language: Language;
  resolution: ServiceResolution | null;
  inferredAnswers: Array<{ variableCode: string; value: string | number | boolean; evidence: string }>;
  context: TurnContext;
}

/**
 * Stage 1-4: guardrail, language, intent, service resolution.
 *
 * Separated from the interview loop because it runs once per session and has a
 * distinct failure mode — a refusal or a disambiguation — that the interview
 * never produces.
 */
export async function runIntake({ session, query, explicitLanguage }: IntakeInput): Promise<IntakeResult> {
  const context = new TurnContext(session.id, session.preferredLanguage);
  const started = Date.now();

  const guardrail = checkInput(query);
  context.record({
    agent: 'input_guardrail',
    stage: 'user_goal',
    deterministic: true,
    status: guardrail.ok ? (guardrail.action === 'redacted' ? 'degraded' : 'ok') : 'blocked',
    input: { length: query.length },
    output: { action: guardrail.action, findings: guardrail.findings.map((f) => f.rule) },
    notes: guardrail.findings.map((f) => `${f.rule}: ${f.detail}`).join('; ') || null,
    latencyMs: Date.now() - started,
  });

  const decided = resolveSessionLanguage(
    guardrail.language,
    session.preferredLanguage,
    explicitLanguage ?? null,
  );
  context.language = decided.language;

  context.record({
    agent: 'language',
    stage: 'language_intent',
    deterministic: true,
    status: 'ok',
    input: { detected: guardrail.language.language, current: session.preferredLanguage },
    output: { language: decided.language, confidence: Number(guardrail.language.confidence.toFixed(2)) },
    notes: `${decided.reason}; signals: ${guardrail.language.signals.join(' | ')}`,
    latencyMs: 0,
  });

  if (!guardrail.ok) {
    return { guardrail, language: decided.language, resolution: null, inferredAnswers: [], context };
  }

  const [services, aliases] = await Promise.all([listServices(), listServiceAliases()]);

  // The model may only fill variables that exist. Collecting the union across
  // services keeps the enum honest before a service is even chosen.
  const allowedVariables = [
    'application_type',
    'city',
    'province',
    'applicant_age',
    'has_fir',
    'address_matches_cnic',
  ];

  const intent = await extractIntent(
    { query: guardrail.sanitized, language: decided.language, services, aliases, allowedVariables },
    context,
  );

  const resolveStarted = Date.now();
  const resolution = resolveService({
    query: guardrail.sanitized,
    services,
    aliases,
    proposedCodes: intent.extraction.serviceCandidates,
    proposalConfidence: intent.extraction.confidence,
  });

  context.record({
    agent: 'service_resolver',
    stage: 'service_resolution',
    deterministic: true,
    status: resolution.resolved ? 'ok' : 'degraded',
    input: {
      modelProposed: intent.extraction.serviceCandidates,
      modelConfidence: intent.extraction.confidence,
    },
    output: {
      resolved: resolution.resolved?.serviceCode ?? null,
      candidates: resolution.candidates.map((c) => `${c.serviceCode}:${c.confidence.toFixed(2)}`),
      needsDisambiguation: resolution.needsDisambiguation,
    },
    notes: resolution.reasoning.join(' '),
    latencyMs: Date.now() - resolveStarted,
  });

  const inferredAnswers = intent.extraction.circumstances.map((c) => ({
    variableCode: c.variable,
    value: c.value,
    evidence: c.evidence,
  }));

  if (intent.extraction.city) {
    inferredAnswers.push({
      variableCode: 'city',
      value: intent.extraction.city,
      evidence: intent.extraction.city,
    });
  }
  if (intent.extraction.province) {
    inferredAnswers.push({
      variableCode: 'province',
      value: intent.extraction.province,
      evidence: intent.extraction.province,
    });
  }

  return { guardrail, language: decided.language, resolution, inferredAnswers, context };
}

/* ── Advance ──────────────────────────────────────────────────────────── */

export interface AdvanceInput {
  session: SessionRecord;
  serviceId: number;
  language: Language;
  /** Reuse the intake turn's context so one trace covers the whole turn. */
  context?: TurnContext;
  /** Force plan generation even if a useful question remains. */
  forcePlan?: boolean;
}

/**
 * Stage 3 and 5-9: interview, retrieval, decision, composition, verification.
 *
 * Either returns the next question or a complete plan. The branch is decided by
 * the interview planner's information-gain calculation, never by a model.
 */
export async function advanceSession({
  session,
  serviceId,
  language,
  context: existing,
  forcePlan = false,
}: AdvanceInput): Promise<TurnResult> {
  const cfg = getConfig();
  const context = existing ?? new TurnContext(session.id, language);
  context.language = language;

  const bundle = await loadServiceBundle(serviceId);
  if (!bundle) throw new Error(`service ${serviceId} not found`);

  const stored = await getAnswers(session.id);
  const answers = toAnswerMap(stored);
  const asked = stored.map((a) => a.variableCode);

  const interview = planInterview({ bundle, answers, asked });

  if (!forcePlan && interview.next) {
    const candidate = interview.candidates.find((c) => c.variable.code === interview.next?.code);
    const question = await phraseQuestion(
      {
        variable: interview.next,
        impacts: candidate?.affects ?? interview.rationale,
        language,
        situation: session.originalQuery ?? '',
      },
      context,
    );

    recordInterviewStep(context, interview, bundle, answers);
    await persistTrace(context);

    return {
      outcome: {
        kind: 'question',
        question,
        progress: interview.progress,
        askedCount: interview.askedCount,
      },
      context,
      language,
      serviceCode: bundle.service.code,
      scenarioCode: null,
      decision: null,
    };
  }

  recordInterviewStep(context, interview, bundle, answers);

  const plan = await buildPlan({
    bundle,
    answers,
    session,
    language,
    context,
    interviewComplete: interview.complete,
    interviewTruncated: interview.truncated,
  });
  await persistTrace(context);
  return plan;
}

function recordInterviewStep(
  context: TurnContext,
  interview: InterviewPlan,
  bundle: ServiceBundle,
  answers: AnswerMap,
): void {
  const state = decide(bundle, answers);
  context.record({
    agent: 'interview_planner',
    stage: 'situation_interview',
    deterministic: true,
    status: 'ok',
    input: { answered: Object.keys(answers).length, asked: interview.askedCount },
    output: {
      next: interview.next?.code ?? null,
      complete: interview.complete,
      truncated: interview.truncated,
      reason: interview.completionReason,
      // Showing the questions that were *considered and skipped* is the most
      // convincing single artefact for "it only asks what matters".
      skippedAsUseless: interview.candidates
        .filter((c) => c.distinctOutcomes <= 1)
        .map((c) => c.variable.code),
      openVariables: state.openVariables,
    },
    notes: interview.next
      ? `chosen by information gain (${interview.candidates.find((c) => c.variable.code === interview.next?.code)?.distinctOutcomes ?? '?'} distinct outcomes); affects: ${interview.rationale.join(', ')}`
      : `interview complete: ${interview.completionReason}`,
    latencyMs: 0,
  });
}

/* ── Plan construction ────────────────────────────────────────────────── */

interface BuildPlanInput {
  bundle: ServiceBundle;
  answers: AnswerMap;
  session: SessionRecord;
  language: Language;
  context: TurnContext;
  interviewComplete: boolean;
  interviewTruncated: boolean;
}

async function buildPlan({
  bundle,
  answers,
  session,
  language,
  context,
  interviewComplete,
  interviewTruncated,
}: BuildPlanInput): Promise<TurnResult> {
  const cfg = getConfig();
  const rulesStarted = Date.now();

  const state = decide(bundle, answers);

  context.record({
    agent: 'rules_engine',
    stage: 'eligibility_requirements',
    deterministic: true,
    status: state.eligibility.outcome === 'undetermined' ? 'degraded' : 'ok',
    input: { answers: Object.keys(answers).length },
    output: {
      scenario: state.selection.scenario?.code ?? null,
      eligibility: state.eligibility.outcome,
      requirements: state.requirements.filter((r) => r.applicability === true).length,
      maybeRequirements: state.requirements.filter((r) => r.applicability === 'unknown').length,
      blockingRules: state.eligibility.blocking.map((b) => b.rule.code),
      exceptions: state.exceptions.fired.map((e) => e.route.code),
    },
    notes: 'no model consulted: scenario, eligibility, documents and fees are pure rule evaluation',
    latencyMs: Date.now() - rulesStarted,
  });

  const needs = informationNeeds(state);
  const retrieval = await retrieveEvidence(
    {
      situation: session.originalQuery ?? bundle.service.name.en,
      serviceName: bundle.service.name.en,
      serviceId: bundle.service.id,
      scenarioName: state.selection.scenario?.name.en ?? null,
      scenarioCode: state.selection.scenario?.code ?? null,
      needs,
      language,
    },
    context,
  );

  const offices = await findOffices({
    serviceId: bundle.service.id,
    city: typeof answers.city === 'string' ? answers.city : session.locationCity,
    province: typeof answers.province === 'string' ? answers.province : session.locationProvince,
  });

  const checklist = buildChecklist({ bundle, state, answers, language });

  const readinessStarted = Date.now();
  const readiness = assessReadiness({ bundle, state, checklist, interviewComplete, interviewTruncated });
  context.record({
    agent: 'readiness',
    stage: 'readiness_check',
    deterministic: true,
    status: 'ok',
    input: { checklistSize: checklist.length },
    output: {
      state: readiness.state,
      completion: Number(readiness.completion.toFixed(2)),
      missing: readiness.missing,
      unknown: readiness.unknown,
      nextAction: readiness.nextAction,
    },
    notes: 'delta of required-vs-held; unknown never counts as satisfied',
    latencyMs: Date.now() - readinessStarted,
  });

  const plan = assembleActionPlan({
    bundle,
    state,
    checklist,
    offices,
    answers,
    sufficiency: retrieval.sufficiency,
    language,
    interviewTruncated,
  });

  const composed = await composePlanText({ plan, readiness, language }, context);

  // Final sweep: verify every string that will be shown, including ones that
  // came straight from the database. A stored translation with a typo'd fee is
  // just as dangerous as a model-invented one.
  const verifyStarted = Date.now();
  const grounding = buildGroundingContext(planFactInventory(plan));
  const violations: ClaimViolation[] = [];
  for (const [id, value] of Object.entries(composed.text)) {
    for (const violation of verifyText(value, grounding)) {
      violations.push({ ...violation, reason: `${id}: ${violation.reason}` });
    }
  }

  context.record({
    agent: 'output_verifier',
    stage: 'personalized_plan',
    deterministic: true,
    status: violations.length === 0 ? 'ok' : 'degraded',
    input: { fields: Object.keys(composed.text).length, strict: cfg.STRICT_GROUNDING },
    output: {
      violations: violations.length,
      kinds: [...new Set(violations.map((v) => v.kind))],
      translationsRejected: composed.rejectedCount,
    },
    notes:
      violations.length === 0
        ? 'every number, duration and link in the rendered output traces to a database row'
        : violations.slice(0, 4).map((v) => `${v.kind}: ${v.text} — ${v.reason}`).join('; '),
    latencyMs: Date.now() - verifyStarted,
  });

  const groundingReport: GroundingReport = {
    sufficiency: retrieval.sufficiency,
    violations,
    deterministicShare: context.deterministicShare,
    sourcesUsed: new Set(retrieval.evidence.map((e) => e.source.code)).size,
    strict: cfg.STRICT_GROUNDING,
  };

  return {
    outcome: {
      kind: 'plan',
      plan,
      readiness,
      composed,
      evidence: retrieval.evidence,
      grounding: groundingReport,
    },
    context,
    language,
    serviceCode: bundle.service.code,
    scenarioCode: state.selection.scenario?.code ?? null,
    decision: state,
  };
}

/* ── Answer application ───────────────────────────────────────────────── */

/**
 * Persist inferred answers from intake.
 *
 * Written with `origin: 'inferred'` so the UI can show them as assumptions the
 * citizen may correct, and so `saveAnswer`'s conflict rule refuses to let a
 * later extraction overwrite something the citizen stated themselves.
 */
export async function applyInferredAnswers(
  sessionId: number,
  bundle: ServiceBundle,
  inferred: ReadonlyArray<{ variableCode: string; value: string | number | boolean }>,
): Promise<string[]> {
  const known = new Set(bundle.variables.map((v) => v.code));
  const accepted = inferred.filter((a) => known.has(a.variableCode));

  await saveAnswers(
    sessionId,
    accepted.map((a) => ({
      variableCode: a.variableCode,
      value: a.value,
      origin: 'inferred' as const,
      confidence: 0.7,
    })),
  );

  return accepted.map((a) => a.variableCode);
}

/** The possession variable convention, re-exported so API routes agree with the engine. */
export { possessionVariable };
export type { AgentName };
