/**
 * Seed-data types.
 *
 * ── Read this before adding a row ──────────────────────────────────────────
 *
 * Every fact in the seed carries a `verification` tier, and the rule is
 * absolute:
 *
 *   'verified'    A human opened the cited official source on `lastVerified`
 *                 and confirmed this exact value. Nothing in the committed
 *                 seed uses this tier yet — see docs/DATA_PROVENANCE.md.
 *
 *   'unverified'  Structurally correct and attributed to a real official
 *                 source, but not yet confirmed by a human. The UI renders a
 *                 visible badge. This is the correct tier for almost all seed
 *                 content.
 *
 *   'synthetic'   Demo scaffolding. The UI labels it loudly. Use for anything
 *                 invented to make the demo coherent — sample office rows, the
 *                 placeholder corpus.
 *
 * A fee you do not have a source for is `amountMinor: null`, which renders as
 * "not verified — confirm at the counter". It is never a plausible-looking
 * number. The same goes for processing times: `null`, not a guess.
 *
 * The temptation to fill in "NADRA CNIC renewal: PKR 750, 15 working days"
 * because it sounds right is exactly the failure this file exists to prevent.
 * A wrong number here looks authoritative, survives review, and nobody
 * remembers it was invented.
 */

export type Verification = 'verified' | 'unverified' | 'synthetic';

export interface SeedSource {
  code: string;
  title: string;
  publisher: string;
  url: string | null;
  docType: 'web' | 'pdf' | 'notification' | 'synthetic';
  language: 'en' | 'ur' | 'roman_ur';
  /** ISO date a human confirmed the content, or null if never. */
  lastVerified: string | null;
  verification: Verification;
  notes: string;
}

export interface SeedDepartment {
  code: string;
  nameEn: string;
  nameUr?: string;
  shortName?: string;
  jurisdiction: 'federal' | 'provincial' | 'district';
  province?: string;
  website?: string;
  sourceCode?: string;
}

export interface Localized {
  en: string;
  ur?: string;
  roman_ur?: string;
}

export interface SeedService {
  code: string;
  departmentCode: string;
  name: Localized;
  summary: Localized;
  category: string;
  officialUrl: string | null;
  /** null means no official online route exists. Never invent one. */
  onlineApplicationUrl: string | null;
  displayOrder: number;
  sourceCode: string;
  verification: Verification;
  aliases: Array<{ alias: string; language: 'en' | 'ur' | 'roman_ur'; weight?: number; scenario?: string }>;
  scenarios: SeedScenario[];
  rules: SeedRule[];
  requirements: SeedRequirement[];
  steps: SeedStep[];
  fees: SeedFee[];
  processingTimes: SeedProcessingTime[];
  exceptions: SeedException[];
}

/** A condition tree. Mirrors src/lib/schemas/conditions.ts. */
export type SeedCondition =
  | { op: 'always' }
  | { op: 'never' }
  | { op: 'and'; children: SeedCondition[] }
  | { op: 'or'; children: SeedCondition[] }
  | { op: 'not'; child: SeedCondition }
  | { op: 'eq'; var: string; value: string | number | boolean | null }
  | { op: 'neq'; var: string; value: string | number | boolean | null }
  | { op: 'in'; var: string; value: Array<string | number | boolean | null> }
  | { op: 'nin'; var: string; value: Array<string | number | boolean | null> }
  | { op: 'gt'; var: string; value: number }
  | { op: 'gte'; var: string; value: number }
  | { op: 'lt'; var: string; value: number }
  | { op: 'lte'; var: string; value: number }
  | { op: 'truthy'; var: string }
  | { op: 'falsy'; var: string }
  | { op: 'answered'; var: string };

export interface SeedScenario {
  code: string;
  name: Localized;
  descriptionEn?: string;
  selector: SeedCondition;
  /** Lower wins when several scenarios match. */
  priority: number;
  isExceptionPath?: boolean;
  sourceCode: string;
  verification: Verification;
}

export interface SeedRule {
  code: string;
  scenario?: string | null;
  statement: Localized;
  /** When this condition holds, the rule FIRES. */
  condition: SeedCondition;
  outcome: 'eligible' | 'ineligible' | 'conditional' | 'route_exception';
  failureMessageEn?: string;
  remedyEn?: string;
  severity?: 'blocking' | 'advisory';
  sourceCode: string;
  verification: Verification;
}

export interface SeedRequirement {
  code: string;
  scenario?: string | null;
  documentType: string;
  title: Localized;
  descriptionEn?: string;
  isMandatory: boolean;
  appliesWhen?: SeedCondition;
  copiesRequired?: number | null;
  mustBeOriginal?: boolean;
  /** Requirement codes that satisfy this one instead. */
  substitutes?: string[];
  obtainFrom?: string;
  /** When the missing document is itself a service this system covers. */
  obtainServiceCode?: string;
  displayOrder: number;
  sourceCode: string;
  verification: Verification;
}

export interface SeedStep {
  code: string;
  scenario?: string | null;
  order: number;
  title: Localized;
  instruction: Localized;
  channel: 'online' | 'in_person' | 'either' | 'postal';
  appliesWhen?: SeedCondition;
  actionUrl?: string | null;
  estimatedDuration?: string | null;
  sourceCode: string;
  verification: Verification;
}

export interface SeedFee {
  code: string;
  scenario?: string | null;
  category: 'normal' | 'urgent' | 'executive' | 'fast_track';
  label: Localized;
  /** null = we have no verified figure. Renders as "not verified". */
  amountMinor: number | null;
  currency?: string;
  appliesWhen?: SeedCondition;
  noteEn?: string;
  sourceCode: string;
  verification: Verification;
}

export interface SeedProcessingTime {
  code: string;
  scenario?: string | null;
  category: 'normal' | 'urgent' | 'executive' | 'fast_track';
  labelEn: string;
  /** null = we have no verified figure. */
  minDays: number | null;
  maxDays: number | null;
  appliesWhen?: SeedCondition;
  sourceCode: string;
  verification: Verification;
}

export interface SeedException {
  code: string;
  name: Localized;
  trigger: SeedCondition;
  guidance: Localized;
  extraRequirementCodes?: string[];
  extraStepCodes?: string[];
  escalateToOffice?: boolean;
  sourceCode: string;
  verification: Verification;
}

export interface SeedVariable {
  code: string;
  /** null = shared across every service. */
  serviceCode: string | null;
  type: 'boolean' | 'enum' | 'number' | 'text' | 'date';
  prompt: Localized;
  help?: Localized;
  options?: Array<{ value: string | number | boolean; label: Localized }>;
  askPriority: number;
  isSensitive?: boolean;
}

export interface SeedOffice {
  code: string;
  departmentCode: string;
  name: Localized;
  officeType: string;
  addressEn: string | null;
  city: string;
  district?: string;
  province: string;
  latitude?: number | null;
  longitude?: number | null;
  phone?: string | null;
  email?: string | null;
  hoursEn?: string | null;
  appointmentUrl?: string | null;
  serviceCodes: string[];
  sourceCode: string;
  verification: Verification;
}

/** A document for the retrieval corpus. */
export interface SeedDocument {
  sourceCode: string;
  serviceCode: string | null;
  title: string;
  language: 'en' | 'ur' | 'roman_ur';
  /** Split on blank lines into chunks by the seeder. */
  body: string;
  scenarioCode?: string | null;
}
