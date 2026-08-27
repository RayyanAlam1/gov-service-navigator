/**
 * Action-plan assembly.
 *
 * Deterministic end to end. The plan a citizen acts on — which steps, which
 * documents, which fee, which office — is built here from database rows and
 * rule evaluation. The language layer never contributes a plan element; it is
 * handed this object afterwards and asked only to phrase it.
 *
 * Exception routes are merged in rather than appended. A citizen whose address
 * does not match their CNIC needs the extra affidavit *in their checklist*, not
 * in a footnote they may not read.
 */
import {
  localized,
  type AnswerMap,
  type Language,
  type LocalizedText,
  type SourceRef,
} from '@/lib/schemas/core';
import type {
  ActionPlan,
  ChecklistItem,
  Office,
  PlanStep,
  ServiceBundle,
} from '@/lib/schemas/domain';
import type { SufficiencyReport } from '@/lib/rag/agentic';
import type { DecisionState } from './rules';

export interface AssemblePlanInput {
  bundle: ServiceBundle;
  state: DecisionState;
  checklist: readonly ChecklistItem[];
  offices: readonly Office[];
  answers: AnswerMap;
  sufficiency: SufficiencyReport | null;
  language: Language;
}

/**
 * Steps contributed by a fired exception route.
 *
 * Ordered ahead of the standard steps when the exception is a prerequisite
 * (an FIR must exist before a lost-document application is accepted), which is
 * expressed by the referenced step's own `step_order`.
 */
function exceptionSteps(bundle: ServiceBundle, state: DecisionState): PlanStep[] {
  const wanted = new Set(state.exceptions.fired.flatMap((e) => e.route.extraStepCodes));
  if (wanted.size === 0) return [];

  return bundle.steps
    .filter((s) => wanted.has(s.code))
    .map((s) => ({
      order: s.stepOrder,
      code: s.code,
      title: s.title,
      instruction: s.instruction,
      channel: s.channel,
      actionUrl: s.actionUrl,
      estimatedDuration: s.estimatedDuration,
      source: s.source,
      verificationStatus: s.verificationStatus,
    }));
}

function buildHeadline(
  bundle: ServiceBundle,
  state: DecisionState,
  language: Language,
): LocalizedText {
  void language;
  const serviceEn = bundle.service.name.en;
  const serviceUr = bundle.service.name.ur ?? serviceEn;
  const serviceRoman = bundle.service.name.roman_ur ?? serviceEn;

  const scenario = state.selection.scenario;
  if (!scenario) {
    return localized(
      `What you need for your ${serviceEn}`,
      `آپ کے ${serviceUr} کے لیے درکار معلومات`,
      `Aap ke ${serviceRoman} ke liye zaroori maloomat`,
    );
  }

  const scenarioEn = scenario.name.en;
  const scenarioUr = scenario.name.ur ?? scenarioEn;
  const scenarioRoman = scenario.name.roman_ur ?? scenarioEn;

  return localized(
    `Your plan: ${serviceEn} — ${scenarioEn}`,
    `آپ کا منصوبہ: ${serviceUr} — ${scenarioUr}`,
    `Aap ka plan: ${serviceRoman} — ${scenarioRoman}`,
  );
}

/**
 * Caveats the citizen must see.
 *
 * Three sources feed this, and all three are honest statements of a limit
 * rather than hedging: unresolved rules, thin retrieval coverage, and stale or
 * unverified provenance. A plan with no caveats means we genuinely had
 * everything, which is a claim worth being able to make.
 */
function buildCaveats(
  bundle: ServiceBundle,
  state: DecisionState,
  checklist: readonly ChecklistItem[],
  sufficiency: SufficiencyReport | null,
): string[] {
  const caveats: string[] = [];

  if (state.eligibility.outcome === 'undetermined') {
    caveats.push(
      'We could not fully determine your eligibility from the answers given. Confirm at the office before travelling.',
    );
  }

  const maybe = checklist.filter((i) => i.status === 'unknown' && i.isMandatory);
  if (maybe.length > 0) {
    caveats.push(
      `We are not certain whether ${maybe.length === 1 ? 'one document is' : `${maybe.length} documents are`} required in your case. Bring them if you have them.`,
    );
  }

  if (sufficiency && !sufficiency.sufficient) {
    caveats.push(...sufficiency.caveats);
  }

  const stale = new Set<string>();
  for (const item of checklist) {
    if (item.source?.isStale) stale.add(item.source.title);
  }
  if (stale.size > 0) {
    caveats.push(
      `Some sources have not been re-verified recently (${[...stale].slice(0, 2).join('; ')}). Government fees and requirements change.`,
    );
  }

  const unverifiedFees = state.fees.filter(
    (f) => f.applicability === true && f.item.amount.amountMinor === null,
  );
  if (unverifiedFees.length > 0) {
    caveats.push('The fee for this service is not verified in our data. Confirm the current amount at the counter.');
  }

  if (!bundle.service.onlineApplicationUrl) {
    caveats.push('There is no official online application route for this service — it must be done in person.');
  }

  return [...new Set(caveats)];
}

export function assembleActionPlan({
  bundle,
  state,
  checklist,
  offices,
  answers,
  sufficiency,
  language,
}: AssemblePlanInput): ActionPlan {
  void answers;

  const standardSteps: PlanStep[] = state.steps
    .filter((s) => s.applicability === true)
    .map((s) => ({
      order: s.item.stepOrder,
      code: s.item.code,
      title: s.item.title,
      instruction: s.item.instruction,
      channel: s.item.channel,
      actionUrl: s.item.actionUrl,
      estimatedDuration: s.item.estimatedDuration,
      source: s.item.source,
      verificationStatus: s.item.verificationStatus,
    }));

  const merged = new Map<string, PlanStep>();
  for (const step of [...exceptionSteps(bundle, state), ...standardSteps]) {
    merged.set(step.code, step);
  }

  const steps = [...merged.values()]
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
    // Renumber so the citizen sees 1..N with no gaps, whatever the underlying
    // step_order values happen to be after exception merging.
    .map((step, index) => ({ ...step, order: index + 1 }));

  const scenario = state.selection.scenario;

  return {
    serviceCode: bundle.service.code,
    serviceName: bundle.service.name,
    scenarioCode: scenario?.code ?? null,
    scenarioName: scenario?.name ?? null,
    department: bundle.service.departmentName ?? 'Government of Pakistan',
    headline: buildHeadline(bundle, state, language),
    steps,
    checklist: [...checklist],
    fees: state.fees.filter((f) => f.applicability === true).map((f) => f.item),
    processingTimes: state.processingTimes.filter((t) => t.applicability === true).map((t) => t.item),
    offices: [...offices],
    officialUrl: bundle.service.officialUrl,
    onlineApplicationUrl: bundle.service.onlineApplicationUrl,
    exceptions: state.exceptions.fired.map((e) => ({
      code: e.route.code,
      name: e.route.name,
      guidance: e.route.guidance,
      escalateToOffice: e.route.escalateToOffice,
      source: e.route.source,
    })),
    caveats: buildCaveats(bundle, state, checklist, sufficiency),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Every distinct source behind a plan, best-verified first.
 *
 * Drives the "Sources" panel. Deduplicated by code so one document cited by
 * ten requirements appears once.
 */
export function planSources(plan: ActionPlan): SourceRef[] {
  const byCode = new Map<string, SourceRef>();

  const add = (source: SourceRef | null) => {
    if (!source) return;
    const existing = byCode.get(source.code);
    if (!existing) byCode.set(source.code, source);
  };

  for (const step of plan.steps) add(step.source);
  for (const item of plan.checklist) add(item.source);
  for (const fee of plan.fees) add(fee.source);
  for (const time of plan.processingTimes) add(time.source);
  for (const office of plan.offices) add(office.source);
  for (const exception of plan.exceptions) add(exception.source);

  return [...byCode.values()].sort((a, b) => {
    if (a.isStale !== b.isStale) return a.isStale ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Numeric and URL facts the output verifier is allowed to see in rendered text.
 *
 * Assembled from the plan itself so the verifier's allow-list and the plan can
 * never disagree — which is the only way "every number shown traces to a row"
 * stays true as the plan grows new fields.
 */
export function planFactInventory(plan: ActionPlan): {
  feeAmountsMinor: (number | null)[];
  dayCounts: (number | null)[];
  otherNumbers: (number | null)[];
  urls: (string | null)[];
  sources: SourceRef[];
  stepCount: number;
} {
  const mandatory = plan.checklist.filter((i) => i.isMandatory).length;

  return {
    feeAmountsMinor: plan.fees.map((f) => f.amount.amountMinor),
    dayCounts: plan.processingTimes.flatMap((t) => [t.minDays, t.maxDays]),
    otherNumbers: [
      ...plan.checklist.map((i) => i.copiesRequired),
      plan.checklist.length,
      mandatory,
      plan.steps.length,
      plan.offices.length,
    ],
    urls: [
      plan.officialUrl,
      plan.onlineApplicationUrl,
      ...plan.steps.map((s) => s.actionUrl),
      ...plan.offices.map((o) => o.appointmentUrl),
    ],
    sources: planSources(plan),
    stepCount: plan.steps.length,
  };
}
