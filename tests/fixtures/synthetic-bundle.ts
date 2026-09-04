/**
 * Synthetic service bundles for engine tests.
 *
 * Everything in here is deliberately fake and labelled as such: variable codes
 * are `test_*` tokens, every row is `verificationStatus: 'synthetic'`, and no
 * value resembles a government fact. The one rule — the system never supplies
 * a government fact — applies to test fixtures too, so these bundles describe
 * *shapes* of rules (an enum fully covered by an `in`, an `answered` gate, a
 * numeric threshold) without ever naming a real fee, document or office.
 *
 * The shapes matter more than they look: several planner bugs only fire on
 * rule structures the seeded services happen not to use, which is exactly why
 * the seeded eval suite stayed green while the planner was wrong.
 */
import type { Condition } from '@/lib/schemas/conditions';
import type { LocalizedText } from '@/lib/schemas/core';
import type {
  DecisionVariable,
  EligibilityRule,
  ExceptionRoute,
  Fee,
  ProcedureStep,
  Requirement,
  Scenario,
  Service,
  ServiceBundle,
} from '@/lib/schemas/domain';

export const text = (s: string): LocalizedText => ({ en: s, ur: null, roman_ur: null });

let nextId = 1000;
const id = () => nextId++;

const SERVICE_ID = 1;

export function makeService(): Service {
  return {
    id: SERVICE_ID,
    code: 'test_service',
    departmentId: 1,
    departmentName: 'Test Department',
    name: text('Test service'),
    summary: text('Synthetic service for engine tests'),
    category: 'test',
    officialUrl: null,
    onlineApplicationUrl: null,
    displayOrder: 0,
    isActive: true,
    source: null,
    verificationStatus: 'synthetic',
  };
}

export function makeScenario(partial: Partial<Scenario> = {}): Scenario {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    code: 'test_default',
    name: text('Default branch'),
    description: null,
    selector: { op: 'always' },
    priority: 0,
    isExceptionPath: false,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export function makeVariable(partial: Partial<DecisionVariable> & Pick<DecisionVariable, 'code' | 'type'>): DecisionVariable {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    prompt: text(`Question about ${partial.code}`),
    help: null,
    options: [],
    askPriority: 100,
    isSensitive: false,
    ...partial,
  };
}

export function makeRequirement(partial: Partial<Requirement> & Pick<Requirement, 'code'>): Requirement {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    scenarioId: null,
    documentType: 'test_document',
    title: text(`Requirement ${partial.code}`),
    description: null,
    isMandatory: true,
    appliesWhen: { op: 'always' } as Condition,
    copiesRequired: null,
    mustBeOriginal: false,
    substitutes: [],
    obtainFrom: null,
    obtainServiceCode: null,
    displayOrder: 0,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export function makeRule(partial: Partial<EligibilityRule> & Pick<EligibilityRule, 'code'>): EligibilityRule {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    scenarioId: null,
    statement: text(`Rule ${partial.code}`),
    condition: { op: 'never' } as Condition,
    outcome: 'conditional',
    failureMessage: null,
    remedy: null,
    severity: 'advisory',
    version: 1,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export function makeStep(partial: Partial<ProcedureStep> & Pick<ProcedureStep, 'code'>): ProcedureStep {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    scenarioId: null,
    stepOrder: 1,
    title: text(`Step ${partial.code}`),
    instruction: text(`Do ${partial.code}`),
    channel: 'in_person',
    appliesWhen: { op: 'always' } as Condition,
    actionUrl: null,
    estimatedDuration: null,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export function makeFee(partial: Partial<Fee> & Pick<Fee, 'code'>): Fee {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    scenarioId: null,
    category: 'test',
    label: text(`Fee ${partial.code}`),
    // amountMinor stays null: even synthetic fixtures do not carry invented
    // money amounts, so a copy-paste from a test can never smuggle a number
    // into anything citizen-facing.
    amount: { amountMinor: null, currency: 'PKR' },
    appliesWhen: { op: 'always' } as Condition,
    note: null,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export function makeException(partial: Partial<ExceptionRoute> & Pick<ExceptionRoute, 'code'>): ExceptionRoute {
  return {
    id: id(),
    serviceId: SERVICE_ID,
    name: text(`Exception ${partial.code}`),
    trigger: { op: 'never' } as Condition,
    guidance: text(`Guidance for ${partial.code}`),
    extraRequirementCodes: [],
    extraStepCodes: [],
    escalateToOffice: false,
    source: null,
    verificationStatus: 'synthetic',
    ...partial,
  };
}

export interface BundleParts {
  variables?: DecisionVariable[];
  scenarios?: Scenario[];
  requirements?: Requirement[];
  rules?: EligibilityRule[];
  steps?: ProcedureStep[];
  fees?: Fee[];
  exceptions?: ExceptionRoute[];
}

export function makeBundle(parts: BundleParts = {}): ServiceBundle {
  return {
    service: makeService(),
    scenarios: parts.scenarios ?? [makeScenario()],
    variables: parts.variables ?? [],
    rules: parts.rules ?? [],
    requirements: parts.requirements ?? [],
    steps: parts.steps ?? [],
    fees: parts.fees ?? [],
    processingTimes: [],
    exceptions: parts.exceptions ?? [],
  };
}
