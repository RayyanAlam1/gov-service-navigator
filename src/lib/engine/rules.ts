/**
 * The decision layer.
 *
 * Everything in this file is deterministic. No model is consulted, no network
 * call is made, and the same answers always produce the same outcome. That is
 * the property that makes the product defensible: if the LLM provider vanished
 * and you swapped in a template renderer, the answers here would still be
 * factually correct — you would lose fluency and translation, not truth.
 *
 * The three-valued logic in schemas/conditions.ts runs through everything.
 * "I don't know yet" is a first-class result, distinct from "no", and it is
 * what drives the adaptive interview instead of a fixed question list.
 */
import {
  answeredGateVariables,
  evaluate,
  referencedVariables,
  type Condition,
  type Tri,
} from '@/lib/schemas/conditions';
import type { AnswerMap } from '@/lib/schemas/core';
import type {
  EligibilityRule,
  ExceptionRoute,
  Fee,
  ProcedureStep,
  ProcessingTime,
  Requirement,
  Scenario,
  ServiceBundle,
} from '@/lib/schemas/domain';

/* ── Scenario selection ───────────────────────────────────────────────── */

export interface ScenarioMatch {
  scenario: Scenario;
  verdict: Tri;
}

export interface ScenarioSelection {
  /** The chosen branch, or null while the answer set cannot distinguish. */
  scenario: Scenario | null;
  /** 0..1. 1 = exactly one definite match. Lower when candidates remain. */
  confidence: number;
  /** Definite matches, best-priority first. */
  matched: Scenario[];
  /** Still-possible branches that need more answers. */
  possible: Scenario[];
  /** Variables that, if answered, would narrow `possible`. */
  unresolved: string[];
  /** True when nothing matched and nothing could match. */
  noMatch: boolean;
}

/**
 * Pick the scenario branch (new / renewal / lost / …) the citizen is on.
 *
 * Lower `priority` wins among definite matches, which lets a specific
 * exception branch outrank a general one without the general one needing to
 * exclude every special case in its own selector.
 */
export function selectScenario(bundle: ServiceBundle, answers: AnswerMap): ScenarioSelection {
  const evaluated: ScenarioMatch[] = bundle.scenarios.map((scenario) => ({
    scenario,
    verdict: evaluate(scenario.selector, answers),
  }));

  const byPriority = (a: Scenario, b: Scenario) => a.priority - b.priority || a.id - b.id;
  const matched = evaluated.filter((e) => e.verdict === true).map((e) => e.scenario).sort(byPriority);
  const possible = evaluated.filter((e) => e.verdict === 'unknown').map((e) => e.scenario).sort(byPriority);

  const unresolved = new Set<string>();
  for (const { scenario, verdict } of evaluated) {
    if (verdict !== 'unknown') continue;
    for (const name of referencedVariables(scenario.selector)) {
      if (!Object.hasOwn(answers, name)) unresolved.add(name);
    }
  }

  const noMatch = matched.length === 0 && possible.length === 0 && bundle.scenarios.length > 0;

  // A definite match with nothing else still in play is full confidence.
  // Anything else is scaled by how much of the field is still open, so the
  // interview keeps going rather than committing early.
  let scenario: Scenario | null = null;
  let confidence = 0;

  const best = matched[0];
  if (best) {
    scenario = best;
    const contenders = matched.length + possible.length;
    confidence = contenders === 1 ? 1 : Math.max(0.4, 1 / contenders);
  } else if (possible.length === 1 && possible[0]) {
    // Only one branch can still be true — treat it as provisional, not chosen.
    scenario = null;
    confidence = 0.5;
  }

  return { scenario, confidence, matched, possible, unresolved: [...unresolved], noMatch };
}

/* ── Scope helpers ────────────────────────────────────────────────────── */

interface ScenarioScoped {
  scenarioId: number | null;
  appliesWhen?: Condition;
}

/** A row applies to this branch if it is global (NULL) or names it. */
function inScope(row: ScenarioScoped, scenarioId: number | null): boolean {
  return row.scenarioId === null || row.scenarioId === scenarioId;
}

export interface Applicable<T> {
  item: T;
  /** true = definitely applies, 'unknown' = may apply, pending an answer. */
  applicability: Tri;
  /** Unanswered variables that would settle `applicability`. */
  pending: string[];
}

function resolveApplicable<T extends ScenarioScoped>(
  rows: readonly T[],
  scenarioId: number | null,
  answers: AnswerMap,
): Applicable<T>[] {
  const out: Applicable<T>[] = [];
  for (const item of rows) {
    if (!inScope(item, scenarioId)) continue;
    const condition = item.appliesWhen;
    const applicability: Tri = condition ? evaluate(condition, answers) : true;
    if (applicability === false) continue;
    const pending = condition
      ? [...referencedVariables(condition)].filter((v) => !Object.hasOwn(answers, v))
      : [];
    out.push({ item, applicability, pending });
  }
  return out;
}

/* ── Requirements ─────────────────────────────────────────────────────── */

/**
 * The citizen's personalized document list.
 *
 * Items whose applicability is still UNKNOWN are returned rather than dropped.
 * Silently omitting a document because we have not asked the question yet is
 * exactly the failure this product exists to prevent — the citizen would
 * arrive at the office short one paper.
 */
export function applicableRequirements(
  bundle: ServiceBundle,
  scenarioId: number | null,
  answers: AnswerMap,
): Applicable<Requirement>[] {
  const rows = resolveApplicable(bundle.requirements, scenarioId, answers);
  return rows.sort((a, b) => {
    if (a.item.isMandatory !== b.item.isMandatory) return a.item.isMandatory ? -1 : 1;
    return a.item.displayOrder - b.item.displayOrder || a.item.id - b.item.id;
  });
}

export function applicableSteps(
  bundle: ServiceBundle,
  scenarioId: number | null,
  answers: AnswerMap,
): Applicable<ProcedureStep>[] {
  return resolveApplicable(bundle.steps, scenarioId, answers).sort(
    (a, b) => a.item.stepOrder - b.item.stepOrder || a.item.id - b.item.id,
  );
}

export function applicableFees(
  bundle: ServiceBundle,
  scenarioId: number | null,
  answers: AnswerMap,
): Applicable<Fee>[] {
  return resolveApplicable(bundle.fees, scenarioId, answers);
}

export function applicableProcessingTimes(
  bundle: ServiceBundle,
  scenarioId: number | null,
  answers: AnswerMap,
): Applicable<ProcessingTime>[] {
  return resolveApplicable(bundle.processingTimes, scenarioId, answers);
}

/* ── Eligibility ──────────────────────────────────────────────────────── */

export interface RuleVerdict {
  rule: EligibilityRule;
  /** Whether the rule's condition holds for this citizen. */
  verdict: Tri;
  pending: string[];
}

export interface EligibilityResult {
  /**
   * eligible      — no blocking rule fires, nothing outstanding
   * ineligible    — at least one blocking rule definitely fires
   * conditional   — eligible, but with advisory rules or an exception route
   * undetermined  — a blocking rule cannot be settled without more answers
   */
  outcome: 'eligible' | 'ineligible' | 'conditional' | 'undetermined';
  blocking: RuleVerdict[];
  advisory: RuleVerdict[];
  undetermined: RuleVerdict[];
  /** Variables that would settle at least one undetermined rule. */
  pending: string[];
}

/**
 * Evaluate the rule set.
 *
 * Rule semantics: a rule's `condition` describes when the rule FIRES.
 * `outcome: 'ineligible'` means firing blocks the citizen. `outcome:
 * 'eligible'` rules are documentation of a passing path and never block.
 */
export function evaluateEligibility(
  bundle: ServiceBundle,
  scenarioId: number | null,
  answers: AnswerMap,
): EligibilityResult {
  const scoped = bundle.rules.filter((r) => inScope(r, scenarioId));

  const verdicts: RuleVerdict[] = scoped.map((rule) => ({
    rule,
    verdict: evaluate(rule.condition, answers),
    pending: [...referencedVariables(rule.condition)].filter((v) => !Object.hasOwn(answers, v)),
  }));

  const fires = (v: RuleVerdict) => v.verdict === true;
  const isBlocker = (r: EligibilityRule) =>
    (r.outcome === 'ineligible' || r.outcome === 'route_exception') && r.severity === 'blocking';

  const isAdvisory = (r: EligibilityRule) => r.severity === 'advisory' || r.outcome === 'conditional';

  const blocking = verdicts.filter((v) => isBlocker(v.rule) && fires(v));
  const advisory = verdicts.filter((v) => fires(v) && isAdvisory(v.rule));
  const undetermined = verdicts.filter((v) => v.verdict === 'unknown' && isBlocker(v.rule));

  // An advisory rule that *might* fire is still worth resolving. Only counting
  // blocking rules here meant a variable like `is_overseas` was never asked,
  // so an applicant abroad was quietly told the domestic procedure applied —
  // a wrong answer produced by never asking rather than by reasoning badly.
  const advisoryPending = verdicts
    .filter((v) => v.verdict === 'unknown' && isAdvisory(v.rule))
    .flatMap((v) => v.pending);

  const pending = [...new Set([...undetermined.flatMap((v) => v.pending), ...advisoryPending])];

  let outcome: EligibilityResult['outcome'];
  if (blocking.length > 0) outcome = 'ineligible';
  else if (undetermined.length > 0) outcome = 'undetermined';
  else if (advisory.length > 0) outcome = 'conditional';
  else outcome = 'eligible';

  return { outcome, blocking, advisory, undetermined, pending };
}

/* ── Exception routing ────────────────────────────────────────────────── */

export interface ExceptionMatch {
  route: ExceptionRoute;
  verdict: Tri;
  pending: string[];
}

/**
 * Lost record, address mismatch, missing parental document, name mismatch.
 *
 * These are modelled explicitly rather than left to the model to improvise,
 * because they are precisely the cases where a generic procedure is wrong and
 * where a confident wrong answer costs the citizen a wasted trip.
 */
export function matchExceptions(
  bundle: ServiceBundle,
  answers: AnswerMap,
): { fired: ExceptionMatch[]; possible: ExceptionMatch[] } {
  const evaluated: ExceptionMatch[] = bundle.exceptions.map((route) => ({
    route,
    verdict: evaluate(route.trigger, answers),
    pending: [...referencedVariables(route.trigger)].filter((v) => !Object.hasOwn(answers, v)),
  }));

  return {
    fired: evaluated.filter((e) => e.verdict === true),
    possible: evaluated.filter((e) => e.verdict === 'unknown'),
  };
}

/* ── Condition enumeration ────────────────────────────────────────────── */

/**
 * Every condition tree in the bundle that is in play for the given scenario.
 * Selector conditions are always in play (they decide the scenario itself);
 * scoped rows contribute only when global or attached to the current branch.
 */
export function conditionsInScope(bundle: ServiceBundle, scenarioId: number | null): Condition[] {
  const out: Condition[] = [];
  for (const s of bundle.scenarios) out.push(s.selector);
  for (const r of bundle.rules) if (inScope(r, scenarioId)) out.push(r.condition);
  for (const r of bundle.requirements) if (inScope(r, scenarioId)) out.push(r.appliesWhen);
  for (const s of bundle.steps) if (inScope(s, scenarioId)) out.push(s.appliesWhen);
  for (const f of bundle.fees) if (inScope(f, scenarioId)) out.push(f.appliesWhen);
  for (const t of bundle.processingTimes) if (inScope(t, scenarioId)) out.push(t.appliesWhen);
  for (const e of bundle.exceptions) out.push(e.trigger);
  return out;
}

/** Every condition tree in the bundle, scope-blind. Probe-constant material. */
export function allBundleConditions(bundle: ServiceBundle): Condition[] {
  return conditionsInScope(bundle, null).concat(
    bundle.rules.filter((r) => r.scenarioId !== null).map((r) => r.condition),
    bundle.requirements.filter((r) => r.scenarioId !== null).map((r) => r.appliesWhen),
    bundle.steps.filter((s) => s.scenarioId !== null).map((s) => s.appliesWhen),
    bundle.fees.filter((f) => f.scenarioId !== null).map((f) => f.appliesWhen),
    bundle.processingTimes.filter((t) => t.scenarioId !== null).map((t) => t.appliesWhen),
  );
}

/* ── Aggregate decision ───────────────────────────────────────────────── */

export interface DecisionState {
  selection: ScenarioSelection;
  eligibility: EligibilityResult;
  requirements: Applicable<Requirement>[];
  steps: Applicable<ProcedureStep>[];
  fees: Applicable<Fee>[];
  processingTimes: Applicable<ProcessingTime>[];
  exceptions: { fired: ExceptionMatch[]; possible: ExceptionMatch[] };
  /** Union of everything still worth asking about, deduplicated. */
  openVariables: string[];
}

/**
 * One pass over the whole rule set for a given answer map.
 *
 * Called on every turn and, crucially, called repeatedly with hypothetical
 * answers by the interview planner to work out which question actually
 * changes something. It must therefore stay cheap and side-effect free.
 */
export function decide(bundle: ServiceBundle, answers: AnswerMap): DecisionState {
  const selection = selectScenario(bundle, answers);
  const scenarioId = selection.scenario?.id ?? null;

  const requirements = applicableRequirements(bundle, scenarioId, answers);
  const steps = applicableSteps(bundle, scenarioId, answers);
  const fees = applicableFees(bundle, scenarioId, answers);
  const processingTimes = applicableProcessingTimes(bundle, scenarioId, answers);
  const eligibility = evaluateEligibility(bundle, scenarioId, answers);
  const exceptions = matchExceptions(bundle, answers);

  const open = new Set<string>();
  for (const v of selection.unresolved) open.add(v);
  for (const v of eligibility.pending) open.add(v);
  for (const r of requirements) for (const v of r.pending) open.add(v);
  for (const s of steps) for (const v of s.pending) open.add(v);
  for (const f of fees) for (const v of f.pending) open.add(v);
  for (const e of exceptions.possible) for (const v of e.pending) open.add(v);

  // Exception triggers are worth resolving even when the branch is settled:
  // an unasked "is your current address different from your CNIC address?"
  // is the difference between a correct plan and a wasted trip.
  for (const e of exceptions.fired) for (const v of e.pending) open.add(v);

  // The `answered` operator is the one place three-valued evaluation is not
  // monotone in knowledge: a condition gated on it evaluates *definitely*
  // while the variable is missing — false for `answered(x)`, true for
  // `not(answered(x))` — and flips the moment any answer arrives. Rows in
  // that state are dropped or admitted as settled, so their variables never
  // reach the pending sets above, and the planner could not ask a question
  // whose only effect sits behind such a gate. Collect them explicitly.
  for (const condition of conditionsInScope(bundle, scenarioId)) {
    for (const v of answeredGateVariables(condition, answers)) open.add(v);
  }

  return {
    selection,
    eligibility,
    requirements,
    steps,
    fees,
    processingTimes,
    exceptions,
    openVariables: [...open],
  };
}

/**
 * A stable fingerprint of everything a citizen would be *told*.
 *
 * The interview planner compares fingerprints across hypothetical answers: if
 * every possible answer to a question yields the same fingerprint, the
 * question cannot change the outcome and must not be asked. This is the
 * mechanism behind "asks only the questions that matter" — not a heuristic
 * about question count.
 */
export function outcomeFingerprint(state: DecisionState): string {
  const parts = [
    `scenario:${state.selection.scenario?.code ?? '-'}`,
    `eligibility:${state.eligibility.outcome}`,
    `blocking:${state.eligibility.blocking.map((b) => b.rule.code).sort().join(',')}`,
    `req:${state.requirements
      .filter((r) => r.applicability === true)
      .map((r) => r.item.code)
      .sort()
      .join(',')}`,
    `maybe:${state.requirements
      .filter((r) => r.applicability === 'unknown')
      .map((r) => r.item.code)
      .sort()
      .join(',')}`,
    `steps:${state.steps
      .filter((s) => s.applicability === true)
      .map((s) => s.item.code)
      .sort()
      .join(',')}`,
    `fees:${state.fees
      .filter((f) => f.applicability === true)
      .map((f) => f.item.code)
      .sort()
      .join(',')}`,
    `exc:${state.exceptions.fired.map((e) => e.route.code).sort().join(',')}`,
  ];
  return parts.join('|');
}
