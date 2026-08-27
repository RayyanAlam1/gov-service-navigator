/**
 * Domain entities.
 *
 * These are the shapes the engine reasons about, hydrated from SQL rows by
 * src/lib/db/repositories/*. They are *not* raw rows: conditions are parsed
 * into ASTs, three language columns are collapsed into LocalizedText, and
 * source columns become a SourceRef. Doing that once at the repository
 * boundary means no downstream code has to remember which column suffix means
 * what.
 */
import { z } from 'zod';
import {
  DocumentMatchStatusSchema,
  LanguageSchema,
  LocalizedTextSchema,
  MoneySchema,
  ReadinessStateSchema,
  ServiceChannelSchema,
  SourceRefSchema,
  VariableTypeSchema,
  VerificationStatusSchema,
} from './core';
import { ConditionSchema } from './conditions';

/* ── Reference data ───────────────────────────────────────────────────── */

export const DepartmentSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: LocalizedTextSchema,
  shortName: z.string().nullable(),
  jurisdiction: z.string(),
  province: z.string().nullable(),
  website: z.string().nullable(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const ServiceSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  departmentId: z.number().int(),
  departmentName: z.string().nullable(),
  name: LocalizedTextSchema,
  summary: LocalizedTextSchema,
  category: z.string(),
  officialUrl: z.string().nullable(),
  /** NULL is meaningful: no official online route exists, so do not invent one. */
  onlineApplicationUrl: z.string().nullable(),
  displayOrder: z.number().int(),
  isActive: z.boolean(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type Service = z.infer<typeof ServiceSchema>;

export const ScenarioSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  code: z.string(),
  name: LocalizedTextSchema,
  description: z.string().nullable(),
  selector: ConditionSchema,
  priority: z.number().int(),
  isExceptionPath: z.boolean(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const VariableOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: LocalizedTextSchema,
});
export type VariableOption = z.infer<typeof VariableOptionSchema>;

export const DecisionVariableSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  serviceId: z.number().int().nullable(),
  type: VariableTypeSchema,
  prompt: LocalizedTextSchema,
  help: LocalizedTextSchema.nullable(),
  options: z.array(VariableOptionSchema),
  askPriority: z.number().int(),
  isSensitive: z.boolean(),
});
export type DecisionVariable = z.infer<typeof DecisionVariableSchema>;

export const EligibilityRuleSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  scenarioId: z.number().int().nullable(),
  code: z.string(),
  statement: LocalizedTextSchema,
  condition: ConditionSchema,
  outcome: z.enum(['eligible', 'ineligible', 'conditional', 'route_exception']),
  failureMessage: z.string().nullable(),
  remedy: z.string().nullable(),
  severity: z.enum(['blocking', 'advisory']),
  version: z.number().int(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type EligibilityRule = z.infer<typeof EligibilityRuleSchema>;

export const RequirementSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  scenarioId: z.number().int().nullable(),
  code: z.string(),
  documentType: z.string(),
  title: LocalizedTextSchema,
  description: z.string().nullable(),
  isMandatory: z.boolean(),
  appliesWhen: ConditionSchema,
  copiesRequired: z.number().int().nullable(),
  mustBeOriginal: z.boolean(),
  /** Requirement codes that satisfy this one instead. */
  substitutes: z.array(z.string()),
  obtainFrom: z.string().nullable(),
  /** When the missing document is itself a service this system covers. */
  obtainServiceCode: z.string().nullable(),
  displayOrder: z.number().int(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const ProcedureStepSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  scenarioId: z.number().int().nullable(),
  code: z.string(),
  stepOrder: z.number().int(),
  title: LocalizedTextSchema,
  instruction: LocalizedTextSchema,
  channel: ServiceChannelSchema,
  appliesWhen: ConditionSchema,
  actionUrl: z.string().nullable(),
  estimatedDuration: z.string().nullable(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type ProcedureStep = z.infer<typeof ProcedureStepSchema>;

export const FeeSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  scenarioId: z.number().int().nullable(),
  code: z.string(),
  category: z.string(),
  label: LocalizedTextSchema,
  amount: MoneySchema,
  appliesWhen: ConditionSchema,
  note: z.string().nullable(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type Fee = z.infer<typeof FeeSchema>;

export const ProcessingTimeSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  scenarioId: z.number().int().nullable(),
  code: z.string(),
  category: z.string(),
  label: z.string(),
  minDays: z.number().int().nullable(),
  maxDays: z.number().int().nullable(),
  appliesWhen: ConditionSchema,
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type ProcessingTime = z.infer<typeof ProcessingTimeSchema>;

export const OfficeSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  departmentId: z.number().int(),
  name: LocalizedTextSchema,
  officeType: z.string(),
  address: z.string().nullable(),
  city: z.string(),
  district: z.string().nullable(),
  province: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  hours: z.string().nullable(),
  appointmentUrl: z.string().nullable(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type Office = z.infer<typeof OfficeSchema>;

export const ExceptionRouteSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  code: z.string(),
  name: LocalizedTextSchema,
  trigger: ConditionSchema,
  guidance: LocalizedTextSchema,
  extraRequirementCodes: z.array(z.string()),
  extraStepCodes: z.array(z.string()),
  escalateToOffice: z.boolean(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type ExceptionRoute = z.infer<typeof ExceptionRouteSchema>;

/**
 * Everything the engine needs about one service, loaded once per turn.
 *
 * Loading the whole bundle rather than querying per-decision matters: the
 * rules engine has to evaluate every rule against every candidate scenario to
 * work out which questions are still worth asking, and doing that with N+1
 * queries would make the interview visibly slow.
 */
export const ServiceBundleSchema = z.object({
  service: ServiceSchema,
  scenarios: z.array(ScenarioSchema),
  variables: z.array(DecisionVariableSchema),
  rules: z.array(EligibilityRuleSchema),
  requirements: z.array(RequirementSchema),
  steps: z.array(ProcedureStepSchema),
  fees: z.array(FeeSchema),
  processingTimes: z.array(ProcessingTimeSchema),
  exceptions: z.array(ExceptionRouteSchema),
});
export type ServiceBundle = z.infer<typeof ServiceBundleSchema>;

/* ── Retrieval ────────────────────────────────────────────────────────── */

export const EvidenceChunkSchema = z.object({
  chunkId: z.number().int(),
  documentId: z.number().int(),
  documentTitle: z.string(),
  headingPath: z.string().nullable(),
  content: z.string(),
  language: LanguageSchema,
  source: SourceRefSchema,
  /** Fused relevance after RRF + optional rerank, 0..1. */
  score: z.number(),
  /** Raw cosine similarity from the vector arm, when that arm matched. */
  vectorSimilarity: z.number().nullable(),
  /** Rank from the lexical arm, when that arm matched. */
  lexicalRank: z.number().int().nullable(),
  retrievedBy: z.array(z.enum(['vector', 'lexical'])),
});
export type EvidenceChunk = z.infer<typeof EvidenceChunkSchema>;

/* ── Document checking ────────────────────────────────────────────────── */

export const ExtractedFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  /** True when the value was masked before storage (CNIC, passport number). */
  redacted: z.boolean(),
});
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

export const DocumentCheckResultSchema = z.object({
  id: z.number().int().nullable(),
  declaredType: z.string(),
  detectedType: z.string().nullable(),
  requirementCode: z.string().nullable(),
  matchStatus: DocumentMatchStatusSchema,
  confidence: z.number().min(0).max(1),
  fields: z.array(ExtractedFieldSchema),
  issues: z.array(z.string()),
  ocrProvider: z.string(),
  checkedAt: z.string(),
});
export type DocumentCheckResult = z.infer<typeof DocumentCheckResultSchema>;

/* ── Readiness ────────────────────────────────────────────────────────── */

export const ChecklistItemSchema = z.object({
  requirementCode: z.string(),
  documentType: z.string(),
  title: LocalizedTextSchema,
  description: z.string().nullable(),
  isMandatory: z.boolean(),
  status: z.enum(['have', 'missing', 'unknown', 'substituted', 'not_applicable']),
  /** Set when `status === 'substituted'`: which alternative satisfied it. */
  satisfiedBy: z.string().nullable(),
  copiesRequired: z.number().int().nullable(),
  mustBeOriginal: z.boolean(),
  obtainFrom: z.string().nullable(),
  obtainServiceCode: z.string().nullable(),
  /** Why this item is on the citizen's list rather than someone else's. */
  reason: z.string(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
  documentCheck: DocumentCheckResultSchema.nullable(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ReadinessReportSchema = z.object({
  state: ReadinessStateSchema,
  /** 0..1. Mandatory items only; optional items never gate readiness. */
  completion: z.number().min(0).max(1),
  satisfied: z.array(z.string()),
  missing: z.array(z.string()),
  unknown: z.array(z.string()),
  blockingRules: z.array(
    z.object({
      code: z.string(),
      statement: LocalizedTextSchema,
      failureMessage: z.string().nullable(),
      remedy: z.string().nullable(),
      source: SourceRefSchema.nullable(),
    }),
  ),
  /** The single most useful thing the citizen can do next. */
  nextAction: z.string(),
  summary: LocalizedTextSchema,
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

/* ── The action plan ──────────────────────────────────────────────────── */

export const PlanStepSchema = z.object({
  order: z.number().int(),
  code: z.string(),
  title: LocalizedTextSchema,
  instruction: LocalizedTextSchema,
  channel: ServiceChannelSchema,
  actionUrl: z.string().nullable(),
  estimatedDuration: z.string().nullable(),
  source: SourceRefSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ActionPlanSchema = z.object({
  serviceCode: z.string(),
  serviceName: LocalizedTextSchema,
  scenarioCode: z.string().nullable(),
  scenarioName: LocalizedTextSchema.nullable(),
  department: z.string(),
  headline: LocalizedTextSchema,
  steps: z.array(PlanStepSchema),
  checklist: z.array(ChecklistItemSchema),
  fees: z.array(FeeSchema),
  processingTimes: z.array(ProcessingTimeSchema),
  offices: z.array(OfficeSchema),
  officialUrl: z.string().nullable(),
  onlineApplicationUrl: z.string().nullable(),
  exceptions: z.array(
    z.object({
      code: z.string(),
      name: LocalizedTextSchema,
      guidance: LocalizedTextSchema,
      escalateToOffice: z.boolean(),
      source: SourceRefSchema.nullable(),
    }),
  ),
  /** Populated when evidence was thin or conflicting. Rendered prominently. */
  caveats: z.array(z.string()),
  generatedAt: z.string(),
});
export type ActionPlan = z.infer<typeof ActionPlanSchema>;
