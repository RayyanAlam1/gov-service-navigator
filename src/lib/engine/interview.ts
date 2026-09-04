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
import { collectProbeConstants, type ProbeConstants } from '@/lib/schemas/conditions';
import type { AnswerMap, AnswerValue } from '@/lib/schemas/core';
import type { DecisionVariable, ServiceBundle } from '@/lib/schemas/domain';
import { allBundleConditions, decide, outcomeFingerprint, type DecisionState } from './rules';

/**
 * The comparison constants of every condition tree in the bundle, keyed by
 * variable. This is what makes numeric, date and text probing sound: probes
 * are derived from the thresholds the rules actually use, so a threshold
 * cannot exist that the probe set fails to straddle. The previous design — a
 * hardcoded probe list with a comment asserting it covered "every threshold
 * this domain uses" — was an invariant enforced by nobody, and it broke the
 * moment a rule compared against a value above the list's maximum.
 */
export function probeConstantsFor(bundle: ServiceBundle): ProbeConstants {
  return collectProbeConstants(allBundleConditions(bundle));
}

export interface QuestionCandidate {
  variable: DecisionVariable;
  /**
   * Distinct outcomes across every probed answer AND the unanswered baseline.
   * 1 = nothing this question could change; >1 = either different answers
   * lead to different plans, or answering at all changes the plan relative to
   * leaving it unanswered. The baseline must be part of this set: a variable
   * whose every answer agrees — but disagrees with "not yet asked" — is a
   * question that changes the plan, and skipping it shows the citizen an
   * outcome no possible answer of theirs would produce.
   */
  distinctOutcomes: number;
  /** Normalized 0..1 usefulness. Ranks candidates. */
  gain: number;
  /** Which decisions this question moves, in plain language, for the UI. */
  affects: string[];
  /** True when a blocking eligibility rule cannot be settled without it. */
  isBlocking: boolean;
}

export interface InterviewPlan {
  /** The next question, or null when the interview is over. */
  next: DecisionVariable | null;
  /** Why `next` was chosen; surfaced by the "why are you asking?" affordance. */
  rationale: string[];
  candidates: QuestionCandidate[];
  /** True when the interview asks nothing further, for any reason. */
  complete: boolean;
  /**
   * True when the interview stopped on the question budget with useful
   * questions still outstanding. A truncated interview is NOT a finished one:
   * the plan built from it must stay hedged (readiness `undetermined`,
   * unresolved items in the may-apply band, an explicit caveat). Callers that
   * branch on `complete` alone treat truncation as completion — that mistake
   * shipped once, in the readiness check, which is why this is a separate
   * field rather than a fourth completionReason to remember to check.
   */
  truncated: boolean;
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
 * For numbers, dates and free text it is a sample derived from the constants
 * the condition trees actually compare against (see `probeConstantsFor`):
 *
 *   - numbers probe every threshold, the midpoint of every gap between
 *     consecutive thresholds, and one value beyond each end — which reaches
 *     every equivalence region the comparison operators can distinguish;
 *   - dates and text probe every literal the rules mention, plus values that
 *     exercise the `answered` / `truthy` / `falsy` gates.
 *
 * Sampling can then only ever *under*-report gain for value regions no rule
 * distinguishes — which by construction cannot change any outcome.
 */
export function candidateValues(
  variable: DecisionVariable,
  constants?: ProbeConstants,
): AnswerValue[] {
  switch (variable.type) {
    case 'boolean':
      return [true, false];
    case 'enum': {
      const values = variable.options.map((o) => o.value as AnswerValue);
      return values.length > 0 ? values : [null];
    }
    case 'number': {
      const thresholds = [...(constants?.numbers.get(variable.code) ?? [])].sort((a, b) => a - b);
      if (thresholds.length === 0) return [0, 1];
      const probes = new Set<number>();
      const first = thresholds[0];
      const last = thresholds[thresholds.length - 1];
      if (first !== undefined) probes.add(first - 1);
      for (let i = 0; i < thresholds.length; i++) {
        const t = thresholds[i];
        if (t === undefined) continue;
        probes.add(t);
        const nextT = thresholds[i + 1];
        if (nextT !== undefined) probes.add((t + nextT) / 2);
      }
      if (last !== undefined) probes.add(last + 1);
      return [...probes];
    }
    case 'date': {
      const literals = constants?.strings.get(variable.code) ?? new Set<string>();
      return [...new Set(['1990-01-01', new Date().toISOString().slice(0, 10), ...literals])];
    }
    case 'text': {
      const literals = constants?.strings.get(variable.code) ?? new Set<string>();
      return [...new Set(['', 'value', ...literals])];
    }
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
  constants?: ProbeConstants,
): QuestionCandidate {
  const probes = candidateValues(variable, constants ?? probeConstantsFor(bundle));

  // Seeded with the baseline: the comparison that matters is not only
  // "do different answers disagree with each other" but "does answering at
  // all change what the citizen is told". Before the baseline was included,
  // a variable whose every answer produced the same outcome — different from
  // the unanswered state — computed zero gain, was never asked, and the
  // interview ended on a plan that no possible answer could produce. Same
  // failure class as the recorded `is_overseas` incident: a wrong answer
  // reached by never asking, invisible to a suite whose scenarios only
  // script the questions the planner chooses to ask.
  const fingerprints = new Set<string>([outcomeFingerprint(baseline)]);
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

  // Normalize: the fingerprint set can hold at most probes + baseline
  // members. A yes/no that splits into two answer outcomes both distinct
  // from the baseline is a perfect split; answers that merely settle a
  // hedge (all agreeing, baseline different) score half.
  const maxPossible = Math.max(2, probes.length + 1);
  const raw = (distinctOutcomes - 1) / (maxPossible - 1);
  const gain = Math.min(1, Math.max(0, raw)) * (isBlocking ? 1.25 : 1);

  return { variable, distinctOutcomes, gain, affects: [...affects], isBlocking };
}

export interface PlanInterviewInput {
  bundle: ServiceBundle;
  answers: AnswerMap;
  /** Variable codes already put to the citizen, including ones they skipped. */
  asked: readonly string[];
  /**
   * Override for the question budget; defaults to config
   * (`INTERVIEW_MAX_QUESTIONS`). Exists so tests can force budget exhaustion
   * deterministically — the seeded services never reach the real ceiling.
   */
  maxQuestions?: number;
}

/**
 * Choose the next question, or decide the interview is done.
 *
 * Ordering among useful candidates: blocking rules first, then information
 * gain, then the curated `askPriority` from the database, then variable code
 * for a stable tie-break so the same session always asks in the same order.
 */
export function planInterview({ bundle, answers, asked, maxQuestions }: PlanInterviewInput): InterviewPlan {
  const askedSet = new Set(asked);
  const baseline = decide(bundle, answers);
  const askedCount = asked.length;
  const budget = maxQuestions ?? getConfig().INTERVIEW_MAX_QUESTIONS;

  // Computed once per turn, not once per candidate: the walk over every
  // condition tree is the same for all of them.
  const constants = probeConstantsFor(bundle);

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
      truncated: false,
      completionReason: 'no_open_variables',
      askedCount,
      progress: 1,
    };
  }

  const scored = open
    .map((variable) => scoreCandidate(bundle, variable, answers, baseline, constants))
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
      truncated: false,
      completionReason: 'no_information_gain',
      askedCount,
      progress: 1,
    };
  }

  // The budget is a hard ceiling against interrogation, not an optimisation.
  // Deliberately NOT a minimum-gain threshold: "useful" already means some
  // answer changes the plan, and skipping any such question — however small
  // its gain score — breaks the safety property that a finished interview is
  // one no remaining answer could alter. A citizen two questions from a
  // definitive plan will answer two more; the ceiling exists for pathological
  // rule sets, and hitting it is reported as truncation, never as completion.
  if (askedCount >= budget) {
    return {
      next: null,
      rationale: [],
      candidates: scored,
      complete: true,
      truncated: true,
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
      truncated: false,
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
    truncated: false,
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
  return bundle.variables
    .filter((v) => !v.isSensitive && (v.type === 'boolean' || v.type === 'enum'))
    .sort((a, b) => a.askPriority - b.askPriority);
}
