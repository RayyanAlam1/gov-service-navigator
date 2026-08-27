/**
 * The "Am I Ready?" engine.
 *
 * A delta, not a score: it compares what the rules require against what the
 * citizen has told us they hold, and names the gap. The output has to survive
 * being acted on — a citizen reads "Ready" and travels to an office — so the
 * bias is deliberately conservative:
 *
 *   * Unknown is never treated as satisfied. A document we have not asked
 *     about counts against readiness, not for it.
 *   * A single unsettled blocking rule caps the verdict at `not_ready`, even
 *     with every document in hand, because eligibility is not a document.
 *   * `ready` requires every mandatory item to be *positively* confirmed.
 *
 * Optional requirements never gate readiness; they are surfaced as "bring if
 * you have it" so the citizen is not scared off by a list they cannot complete.
 */
import {
  localized,
  pickLocalized,
  weakestStatus,
  type AnswerMap,
  type Language,
  type LocalizedText,
  type ReadinessState,
  type VerificationStatus,
} from '@/lib/schemas/core';
import { explainCondition, referencedVariables } from '@/lib/schemas/conditions';
import type {
  ChecklistItem,
  DocumentCheckResult,
  ReadinessReport,
  Requirement,
  ServiceBundle,
} from '@/lib/schemas/domain';
import type { Applicable, DecisionState } from './rules';

/**
 * How a citizen tells us they hold a document.
 *
 * Convention: the interview stores possession under `has_<requirement code>`.
 * Keeping it a convention rather than a separate table means a new requirement
 * automatically gets a possession variable without a migration.
 */
export function possessionVariable(requirementCode: string): string {
  return `has_${requirementCode}`;
}

export interface BuildChecklistInput {
  bundle: ServiceBundle;
  state: DecisionState;
  answers: AnswerMap;
  /** Verified document checks, keyed by requirement code. */
  documentChecks?: ReadonlyMap<string, DocumentCheckResult>;
  language: Language;
}

function possessionOf(answers: AnswerMap, code: string): boolean | null {
  const key = possessionVariable(code);
  if (!Object.hasOwn(answers, key)) return null;
  const value = answers[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['yes', 'true', 'haan', 'han', 'ji', 'ہاں', '1'].includes(v)) return true;
    if (['no', 'false', 'nahi', 'nahin', 'نہیں', '0'].includes(v)) return false;
    return null;
  }
  if (typeof value === 'number') return value !== 0;
  return null;
}

/**
 * Why this document is on THIS citizen's list.
 *
 * Phrased from the citizen's own answers rather than from the rule expression.
 * "Required because What do you need to do is lost" is technically accurate and
 * reads like a database error; "Because you said: What do you need to do →
 * Replace a lost or stolen one" is the same fact in language someone can take
 * to a counter and argue with.
 *
 * Uses the stored option *labels*, not the raw enum values, so the citizen sees
 * the words they actually clicked.
 */
function reasonFor(
  applicable: Applicable<Requirement>,
  bundle: ServiceBundle,
  state: DecisionState,
  answers: AnswerMap,
  language: Language,
): string {
  const variableFor = (code: string) => bundle.variables.find((v) => v.code === code);

  const promptOf = (code: string) => {
    const variable = variableFor(code);
    if (!variable) return code;
    return pickLocalized(variable.prompt, language).replace(/[?؟]\s*$/, '');
  };

  if (applicable.applicability === 'unknown') {
    const pending = applicable.pending.map(promptOf).join('; ');
    return pending
      ? `May be required — depends on: ${pending}`
      : 'May be required in your case';
  }

  const condition = applicable.item.appliesWhen;
  const scenario = state.selection.scenario;

  if (condition.op === 'always') {
    return scenario
      ? `Required for ${pickLocalized(scenario.name, language)}`
      : 'Required for this service';
  }

  // Render each referenced variable as "prompt → the answer they gave".
  const parts: string[] = [];
  for (const code of referencedVariables(condition)) {
    if (!Object.hasOwn(answers, code)) continue;
    const variable = variableFor(code);
    const raw = answers[code] ?? null;

    let shown: string;
    if (variable?.type === 'boolean' || typeof raw === 'boolean') {
      shown = raw === true || raw === 'true' ? 'Yes' : 'No';
    } else {
      const option = variable?.options.find(
        (o) => String(o.value).toLowerCase() === String(raw).toLowerCase(),
      );
      shown = option ? pickLocalized(option.label, language) : String(raw ?? '—');
    }
    parts.push(`${promptOf(code)} → ${shown}`);
  }

  if (parts.length === 0) {
    // Every referenced variable is unanswered: fall back to the rule text so
    // the item still explains itself rather than appearing unmotivated.
    return `Required when ${explainCondition(condition, promptOf)}`;
  }

  return `Because you said: ${parts.join('; ')}`;
}

/**
 * Build the personalized checklist.
 *
 * Substitution matters here: several Pakistani services accept an alternative
 * document (an affidavit in place of a missing record, a guardian's CNIC in
 * place of a parent's). A citizen who holds the substitute is ready, and a
 * checklist that says otherwise sends them away to fetch something they do not
 * need.
 */
export function buildChecklist({
  bundle,
  state,
  answers,
  documentChecks,
  language,
}: BuildChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // First pass: direct possession, so substitution can consult it.
  const held = new Map<string, boolean | null>();
  for (const applicable of state.requirements) {
    held.set(applicable.item.code, possessionOf(answers, applicable.item.code));
  }

  for (const applicable of state.requirements) {
    const requirement = applicable.item;
    const check = documentChecks?.get(requirement.code) ?? null;

    let status: ChecklistItem['status'];
    let satisfiedBy: string | null = null;

    if (applicable.applicability === 'unknown') {
      // We do not yet know whether this is even required. It cannot count as
      // satisfied, and it must not be silently dropped.
      status = 'unknown';
    } else {
      const direct = held.get(requirement.code) ?? null;

      // A document check is stronger evidence than a self-report, and it can
      // also *overturn* one: a citizen who says they have their B-Form but
      // uploads an expired one is not ready.
      if (check && check.matchStatus === 'match') {
        status = 'have';
      } else if (check && (check.matchStatus === 'mismatch' || check.matchStatus === 'expired' || check.matchStatus === 'wrong_document')) {
        status = 'missing';
      } else if (direct === true) {
        status = 'have';
      } else if (direct === false) {
        const substitute = requirement.substitutes.find((code) => held.get(code) === true);
        if (substitute) {
          status = 'substituted';
          satisfiedBy = substitute;
        } else {
          status = 'missing';
        }
      } else {
        const substitute = requirement.substitutes.find((code) => held.get(code) === true);
        if (substitute) {
          status = 'substituted';
          satisfiedBy = substitute;
        } else {
          status = 'unknown';
        }
      }
    }

    items.push({
      requirementCode: requirement.code,
      documentType: requirement.documentType,
      title: requirement.title,
      description: requirement.description,
      isMandatory: requirement.isMandatory,
      status,
      satisfiedBy,
      copiesRequired: requirement.copiesRequired,
      mustBeOriginal: requirement.mustBeOriginal,
      obtainFrom: requirement.obtainFrom,
      obtainServiceCode: requirement.obtainServiceCode,
      reason: reasonFor(applicable, bundle, state, answers, language),
      source: requirement.source,
      verificationStatus: requirement.verificationStatus,
      documentCheck: check,
    });
  }

  return items;
}

const SUMMARIES: Record<ReadinessState, Record<Language, (n: number) => string>> = {
  ready: {
    en: () => 'You have everything you need. You can go ahead.',
    ur: () => 'آپ کے پاس تمام ضروری دستاویزات موجود ہیں۔ آپ آگے بڑھ سکتے ہیں۔',
    roman_ur: () => 'Aap ke paas sab zaroori documents mojood hain. Aap aage barh sakte hain.',
  },
  nearly_ready: {
    en: (n) => `Almost there — ${n} item${n === 1 ? '' : 's'} still to sort out.`,
    ur: (n) => `تقریباً تیار — ${n} چیزیں ابھی باقی ہیں۔`,
    roman_ur: (n) => `Taqreeban tayyar — ${n} cheezein abhi baqi hain.`,
  },
  not_ready: {
    en: (n) => `Not ready yet — ${n} required item${n === 1 ? '' : 's'} missing.`,
    ur: (n) => `ابھی تیار نہیں — ${n} ضروری چیزیں کم ہیں۔`,
    roman_ur: (n) => `Abhi tayyar nahi — ${n} zaroori cheezein kam hain.`,
  },
  undetermined: {
    en: () => 'We need a little more information before we can tell you.',
    ur: () => 'بتانے سے پہلے ہمیں کچھ مزید معلومات درکار ہیں۔',
    roman_ur: () => 'Batane se pehle humein kuch aur maloomat darkar hain.',
  },
};

function summaryText(state: ReadinessState, count: number): LocalizedText {
  const set = SUMMARIES[state];
  return localized(set.en(count), set.ur(count), set.roman_ur(count));
}

export interface AssessReadinessInput {
  bundle: ServiceBundle;
  state: DecisionState;
  checklist: readonly ChecklistItem[];
  /** True while the interview still has a useful question outstanding. */
  interviewComplete: boolean;
}

/**
 * The readiness verdict.
 *
 * Order of precedence, strongest first:
 *   1. A fired blocking rule -> not_ready, regardless of documents.
 *   2. An unsettled blocking rule -> undetermined.
 *   3. Missing mandatory documents -> not_ready / nearly_ready by count.
 *   4. Unknown mandatory documents -> undetermined (never `ready`).
 */
export function assessReadiness({
  bundle,
  state,
  checklist,
  interviewComplete,
}: AssessReadinessInput): ReadinessReport {
  void bundle;
  const mandatory = checklist.filter((i) => i.isMandatory);
  const satisfied = mandatory.filter((i) => i.status === 'have' || i.status === 'substituted');
  const missing = mandatory.filter((i) => i.status === 'missing');
  const unknown = mandatory.filter((i) => i.status === 'unknown');

  const blockingRules = state.eligibility.blocking.map((b) => ({
    code: b.rule.code,
    statement: b.rule.statement,
    failureMessage: b.rule.failureMessage,
    remedy: b.rule.remedy,
    source: b.rule.source,
  }));

  const completion = mandatory.length === 0 ? 1 : satisfied.length / mandatory.length;

  let readinessState: ReadinessState;
  if (blockingRules.length > 0) {
    readinessState = 'not_ready';
  } else if (state.eligibility.outcome === 'undetermined' || !interviewComplete) {
    readinessState = 'undetermined';
  } else if (unknown.length > 0) {
    readinessState = 'undetermined';
  } else if (missing.length === 0) {
    readinessState = 'ready';
  } else if (missing.length <= 2 && completion >= 0.6) {
    readinessState = 'nearly_ready';
  } else {
    readinessState = 'not_ready';
  }

  const outstanding = missing.length + unknown.length;

  return {
    state: readinessState,
    completion,
    satisfied: satisfied.map((i) => i.requirementCode),
    missing: missing.map((i) => i.requirementCode),
    unknown: unknown.map((i) => i.requirementCode),
    blockingRules,
    nextAction: nextAction({ readinessState, blockingRules, missing, unknown, state }),
    summary: summaryText(readinessState, outstanding),
  };
}

interface NextActionInput {
  readinessState: ReadinessState;
  blockingRules: ReadinessReport['blockingRules'];
  missing: readonly ChecklistItem[];
  unknown: readonly ChecklistItem[];
  state: DecisionState;
}

/**
 * One clear next step.
 *
 * The product spec is explicit that the citizen gets a single next action, not
 * a menu. Ranking: fix a blocker, then obtain the most obtainable missing
 * document, then resolve an unknown, then go.
 */
function nextAction({ readinessState, blockingRules, missing, unknown, state }: NextActionInput): string {
  const firstBlocker = blockingRules[0];
  if (firstBlocker) {
    return firstBlocker.remedy?.trim() || firstBlocker.failureMessage?.trim() ||
      `Resolve: ${firstBlocker.statement.en}`;
  }

  // Prefer a missing document this system can route the citizen to obtain.
  const routable = missing.find((i) => i.obtainServiceCode);
  if (routable) {
    return `Get your ${routable.title.en} first — we can walk you through that too.`;
  }

  const firstMissing = missing[0];
  if (firstMissing) {
    const name = possessive(firstMissing.title.en);
    return firstMissing.obtainFrom
      ? `Obtain ${name} from ${firstMissing.obtainFrom}.`
      : `Arrange ${name} before you go.`;
  }

  const firstUnknown = unknown[0];
  if (firstUnknown) {
    return `Confirm whether you have ${possessive(firstUnknown.title.en)}.`;
  }

  if (readinessState === 'ready') {
    const firstStep = state.steps.find((s) => s.applicability === true);
    return firstStep ? firstStep.item.title.en : 'Proceed to the office with your documents.';
  }

  return 'Answer the remaining questions so we can complete your checklist.';
}

/**
 * Prefix a document title with "your" unless it already carries a possessive.
 *
 * Several requirement titles are authored as "Your valid CNIC", so a blind
 * prefix produces "Confirm whether you have your Your valid CNIC" — small, but
 * it is the single most-read sentence on the page.
 */
function possessive(title: string): string {
  return /^(your|my|the)\b/i.test(title.trim()) ? title : `your ${title}`;
}

/** Weakest verification status across everything the citizen is being shown. */
export function checklistTrust(checklist: readonly ChecklistItem[]): VerificationStatus {
  return weakestStatus(checklist.map((i) => i.verificationStatus));
}
