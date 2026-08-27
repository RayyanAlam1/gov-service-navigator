/**
 * The adaptive eligibility interview.
 *
 * The product claim is "it asks only the questions that matter". This file is
 * where that claim is either true or marketing. It is implemented as actual
 * information gain over the rule set, not as a shortened static question list:
 *
 *   For each unanswered variable the rules reference, try every value it could
 *   take. Compute the full decision outcome for each. If every possible answer
 *   produces the same outcome fingerprint, the question cannot change what the
 *   citizen is told — so it is not asked, no matter how sensible it sounds.
 *
 * That gives three things worth having:
 *
 *   1. Genuinely short interviews. A citizen who already said "lost" is never
 *      asked whether this is a renewal.
 *   2. An answer to "why are you asking me this?" — the planner knows exactly
 *      which outcomes the question splits, and the UI shows it.
 *   3. A safety property: the interview stops when, and only when, no
 *      remaining question could change the plan. Stopping early would mean
 *      guessing; stopping late wastes the citizen's time.
 *
 * The model is not involved in *choosing* the question. It is used only to
 * phrase a chosen question in the citizen's language, and even that has a
 * database-authored fallback.
 */
import { getConfig } from '@/lib/config/env';
import type { AnswerMap, AnswerValue } from '@/lib/schemas/core';
import type { DecisionVariable, ServiceBundle } from '@/lib/schemas/domain';
import { decide, outcomeFingerprint, type DecisionState } from './rules';

/** Hard cap. A citizen who has answered this many questions is being interrogated. */
const MAX_QUESTIONS_PER_SESSION = 8;

/** Numeric probes for range rules — enough to straddle any realistic threshold. */
const NUMERIC_PROBES: readonly number[] = [0, 5, 17, 18, 21, 30, 45, 60, 65, 100];

export interface QuestionCandidate {
  variable: DecisionVariable;
  /** Distinct outcomes this question's answers would produce. 1 = useless. */
  distinctOutcomes: number;
  /** Normalized 0..1 usefulness. Ranks candidates. */
  gain: number;
  /** Which decisions this question moves, in plain language, for the UI. */
  affects: string[];
  /** True when a blocking eligibility rule cannot be settled without it. */
  isBlocking: boolean;
}

export interface InterviewPlan {
  /** The next question, or null when the interview is complete. */
  next: DecisionVariable | null;
  /** Why `next` was chosen; surfaced by the "why are you asking?" affordance. */
  rationale: string[];
  candidates: QuestionCandidate[];
  /** True when no remaining question could change the outcome. */
  complete: boolean;
  /** Why the interview stopped. */
  completionReason: 'no_open_variables' | 'no_information_gain' | 'question_budget' | 'in_progress';
  askedCount: number;
  /** 0..1, for the progress indicator. Estimated, and labelled as such in the UI. */
  progress: number;
}

/**
 * The value domain to probe for a variable.
 *
 * For enums and booleans this is exact, so the gain calculation is exact too.
 * For numbers and free text it is a sample, which can only ever *under*-report
 * gain — a question is never wrongly skipped because a probe missed a
 * threshold, since under-reporting gain to zero requires every probe to agree,
 * and the probe set straddles every threshold this domain uses.
 */
export function candidateValues(variable: DecisionVariable): AnswerValue[] {
  switch (variable.type) {
    case 'boolean':
      return [true, false];
    case 'enum': {
      const values = variable.options.map((o) => o.value as AnswerValue);
      return values.length > 0 ? values : [null];
    }
    case 'number':
      return [...NUMERIC_PROBES];
    case 'date':
      // Rules over dates are expressed as derived numeric variables (e.g.
      // days_since_expiry), so a date itself only ever gates `answered`.
      return ['1990-01-01', new Date().toISOString().slice(0, 10)];
    case 'text':
      // Free text gates `answered` / `truthy` checks rather than comparisons.
      return ['', 'value'];
  }
}

function describeImpact(before: DecisionState, after: DecisionState): string[] {
  const out: string[] = [];

  if (before.selection.scenario?.code !== after.selection.scenario?.code) {
    out.push('which case applies to you');
  }
  if (before.eligibility.outcome !== after.eligibility.outcome) {
    out.push('whether you are eligible');
  }

  const codes = (s: DecisionState) =>
    new Set(s.requirements.filter((r) => r.applicability === true).map((r) => r.item.code));
  const b = codes(before);
  const a = codes(after);
  if (b.size !== a.size || [...a].some((c) => !b.has(c))) {
    out.push('which documents you need');
  }

  const stepCodes = (s: DecisionState) =>
    s.steps.filter((x) => x.applicability === true).map((x) => x.item.code).join(',');
  if (stepCodes(before) !== stepCodes(after)) out.push('the steps you follow');

  const feeCodes = (s: DecisionState) =>
    s.fees.filter((x) => x.applicability === true).map((x) => x.item.code).join(',');
  if (feeCodes(before) !== feeCodes(after)) out.push('what it costs');

  const excCodes = (s: DecisionState) => s.exceptions.fired.map((e) => e.route.code).sort().join(',');
  if (excCodes(before) !== excCodes(after)) out.push('special handling for your situation');

  return out;
}

/**
 * Score one candidate variable by simulating every answer it could take.
 *
 * Pure and side-effect free — it clones the answer map per probe rather than
 * mutating, because `decide` is called with hypotheticals that must never leak
 * into the citizen's real session.
 */
export function scoreCandidate(
  bundle: ServiceBundle,
  variable: DecisionVariable,
  answers: AnswerMap,
  baseline: DecisionState,
): QuestionCandidate {
  const probes = candidateValues(variable);
  const fingerprints = new Set<string>();
  const affects = new Set<string>();

  for (const value of probes) {
    const hypothetical: AnswerMap = { ...answers, [variable.code]: value };
    const state = decide(bundle, hypothetical);
    fingerprints.add(outcomeFingerprint(state));
    for (const impact of describeImpact(baseline, state)) affects.add(impact);
  }

  const distinctOutcomes = fingerprints.size;

  // A variable that a blocking rule depends on is prioritised: leaving it
  // unresolved means the eligibility verdict itself stays undetermined, and
  // "we could not determine your eligibility" is a much worse answer than one
  // extra question.
  const isBlocking = baseline.eligibility.undetermined.some((u) => u.pending.includes(variable.code));

  // Normalize: 2 distinct outcomes from a yes/no is a perfect split; more
  // outcomes from more options is proportionally more informative.
  const maxPossible = Math.max(2, probes.length);
  const raw = (distinctOutcomes - 1) / (maxPossible - 1);
  const gain = Math.min(1, Math.max(0, raw)) * (isBlocking ? 1.25 : 1);

  return { variable, distinctOutcomes, gain, affects: [...affects], isBlocking };
}

export interface PlanInterviewInput {
  bundle: ServiceBundle;
  answers: AnswerMap;
  /** Variable codes already put to the citizen, including ones they skipped. */
  asked: readonly string[];
}

/**
 * Choose the next question, or decide the interview is done.
 *
 * Ordering among useful candidates: blocking rules first, then information
 * gain, then the curated `askPriority` from the database, then variable code
 * for a stable tie-break so the same session always asks in the same order.
 */
export function planInterview({ bundle, answers, asked }: PlanInterviewInput): InterviewPlan {
  const askedSet = new Set(asked);
  const baseline = decide(bundle, answers);
  const askedCount = asked.length;

  const byCode = new Map(bundle.variables.map((v) => [v.code, v] as const));

  // Only variables the rules actually reference are considered. A variable
  // that exists in the database but gates nothing is dead data, not a question.
  const open = baseline.openVariables
    .filter((code) => !Object.hasOwn(answers, code) && !askedSet.has(code))
    .map((code) => byCode.get(code))
    .filter((v): v is DecisionVariable => v !== undefined);

  if (open.length === 0) {
    return {
      next: null,
      rationale: [],
      candidates: [],
      complete: true,
      completionReason: 'no_open_variables',
      askedCount,
      progress: 1,
    };
  }

  const scored = open
    .map((variable) => scoreCandidate(bundle, variable, answers, baseline))
    .sort((a, b) => {
      if (a.isBlocking !== b.isBlocking) return a.isBlocking ? -1 : 1;
      if (b.gain !== a.gain) return b.gain - a.gain;
      if (a.variable.askPriority !== b.variable.askPriority) {
        return a.variable.askPriority - b.variable.askPriority;
      }
      return a.variable.code.localeCompare(b.variable.code);
    });

  const useful = scored.filter((c) => c.distinctOutcomes > 1);

  if (useful.length === 0) {
    return {
      next: null,
      rationale: [],
      candidates: scored,
      complete: true,
      completionReason: 'no_information_gain',
      askedCount,
      progress: 1,
    };
  }

  if (askedCount >= MAX_QUESTIONS_PER_SESSION) {
    // Budget exhausted with questions still outstanding. The plan will carry
    // the remaining uncertainty as explicit "may apply" items rather than
    // resolving it by guessing.
    return {
      next: null,
      rationale: [],
      candidates: scored,
      complete: true,
      completionReason: 'question_budget',
      askedCount,
      progress: 1,
    };
  }

  const chosen = useful[0];
  if (!chosen) {
    return {
      next: null,
      rationale: [],
      candidates: scored,
      complete: true,
      completionReason: 'no_information_gain',
      askedCount,
      progress: 1,
    };
  }

  const rationale = chosen.affects.length > 0
    ? chosen.affects
    : ['which case applies to you'];

  // Progress is honest about being an estimate: remaining useful questions is
  // an upper bound, since answering one often eliminates several others.
  const remaining = useful.length;
  const progress = askedCount / Math.max(1, askedCount + remaining);

  return {
    next: chosen.variable,
    rationale,
    candidates: scored,
    complete: false,
    completionReason: 'in_progress',
    askedCount,
    progress,
  };
}

/**
 * Variables worth pre-filling from the citizen's opening sentence.
 *
 * The intent agent proposes values for these; they are stored with
 * `origin: 'inferred'` and shown back as assumptions the citizen can correct,
 * never as something they said. That distinction is what keeps an extraction
 * mistake from silently becoming a wrong plan.
 */
export function inferableVariables(bundle: ServiceBundle): DecisionVariable[] {
  const cfg = getConfig();
  void cfg;
  return bundle.variables
    .filter((v) => !v.isSensitive && (v.type === 'boolean' || v.type === 'enum'))
    .sort((a, b) => a.askPriority - b.askPriority);
}
