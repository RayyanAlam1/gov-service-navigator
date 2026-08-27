/**
 * Row → entity mapping.
 *
 * The one place in the codebase that knows about column-name conventions
 * (`*_en` / `*_ur` / `*_roman_ur`, `source_*` join aliases, JSONB condition
 * columns). Everything above this layer works with domain types and never sees
 * a raw row, which is what keeps three-language handling from being
 * copy-pasted into twenty query sites and drifting.
 *
 * Two invariants are enforced here rather than trusted:
 *   1. A JSONB condition that fails to parse becomes `never`, not `always`.
 *      A rule we cannot read must not silently apply to every citizen.
 *   2. Source freshness is computed once, from SOURCE_STALE_AFTER_DAYS, so
 *      "last verified" and "is stale" can never disagree.
 */
import { getConfig } from '@/lib/config/env';
import { logger } from '@/lib/obs/logger';
import { parseCondition, type Condition } from '@/lib/schemas/conditions';
import {
  localized,
  type Language,
  type LocalizedText,
  type SourceRef,
  type VerificationStatus,
} from '@/lib/schemas/core';
import type {
  DecisionVariable,
  EligibilityRule,
  ExceptionRoute,
  Fee,
  Office,
  ProcedureStep,
  ProcessingTime,
  Requirement,
  Scenario,
  Service,
  VariableOption,
} from '@/lib/schemas/domain';

/* ── Primitives ───────────────────────────────────────────────────────── */

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = asNumber(value);
  return Number.isFinite(n) ? n : null;
}

export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['t', 'true', '1', 'yes'].includes(value.toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return false;
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

export function asIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Read a JSONB column.
 *
 * Both drivers hand back JSONB already parsed, so an object column arrives as
 * an object. A string column, however, arrives as a plain JS string — and
 * `JSON.parse('renewal')` throws. Treating that as a parse failure and
 * returning the fallback is how a stored answer silently reads as null, which
 * then makes every rule referencing it evaluate to false. Use `asJsonValue`
 * for columns that may hold a JSON scalar.
 */
export function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Read a JSONB column that may hold a scalar (string, number, boolean, null).
 *
 * This is the shape `session_answers.value` uses. A bare string is returned as
 * itself rather than being run through JSON.parse, because the driver has
 * already done the decoding and the remaining string IS the value.
 */
export function asJsonValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // A driver that returns raw JSON text would give '"renewal"' with quotes;
    // one that pre-parses gives 'renewal'. Handle both without losing either.
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      trimmed === 'true' ||
      trimmed === 'false' ||
      trimmed === 'null' ||
      /^-?\d+(\.\d+)?$/.test(trimmed)
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed === null) return null;
        if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
          return parsed;
        }
      } catch {
        /* fall through and return the string as-is */
      }
    }
    return value;
  }
  return null;
}

export function asStringArray(value: unknown): string[] {
  const parsed = asJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string');
}

export function asVerificationStatus(value: unknown): VerificationStatus {
  const s = asString(value, 'unverified');
  return s === 'verified' || s === 'unverified' || s === 'synthetic' || s === 'deprecated'
    ? s
    : 'unverified';
}

export function asLanguage(value: unknown): Language {
  const s = asString(value, 'en');
  return s === 'ur' || s === 'roman_ur' ? s : 'en';
}

/** Collapse `<base>_en` / `<base>_ur` / `<base>_roman_ur` into one value. */
export function localizedFrom(row: Record<string, unknown>, base: string, fallback = ''): LocalizedText {
  return localized(
    asString(row[`${base}_en`], fallback),
    asNullableString(row[`${base}_ur`]),
    asNullableString(row[`${base}_roman_ur`]),
  );
}

export function conditionFrom(row: Record<string, unknown>, column: string, context: string): Condition {
  return parseCondition(asJson(row[column], null), (msg) =>
    logger().error({ context, column, msg }, 'malformed condition in database; rule will not apply'),
  );
}

/* ── Sources ──────────────────────────────────────────────────────────── */

/** Columns a query must alias in to produce a SourceRef. */
export interface SourceRow {
  source_id: number | null;
  source_code: string | null;
  source_title: string | null;
  source_publisher: string | null;
  source_url: string | null;
  source_last_verified: string | Date | null;
  source_retrieved_at: string | Date | null;
  source_verification_status: string | null;
}

export const SOURCE_JOIN_COLUMNS = `
  s.id                  AS source_id,
  s.code                AS source_code,
  s.title               AS source_title,
  s.publisher           AS source_publisher,
  s.url                 AS source_url,
  s.last_verified       AS source_last_verified,
  s.retrieved_at        AS source_retrieved_at,
  s.verification_status AS source_verification_status
`;

/**
 * Is this source past its freshness window?
 *
 * A source that has never been verified counts as stale. That is deliberate:
 * the citizen-facing consequence of "we last checked this 9 months ago" and
 * "nobody has ever checked this" is the same, and both deserve the caveat.
 */
export function isSourceStale(lastVerified: string | null, now: Date = new Date()): boolean {
  if (!lastVerified) return true;
  const verified = new Date(lastVerified);
  if (Number.isNaN(verified.getTime())) return true;
  const ageDays = (now.getTime() - verified.getTime()) / 86_400_000;
  return ageDays > getConfig().SOURCE_STALE_AFTER_DAYS;
}

export function toSourceRef(row: Partial<SourceRow>): SourceRef {
  const lastVerified = asIsoDate(row.source_last_verified);
  return {
    id: asNullableNumber(row.source_id),
    code: asString(row.source_code, 'unknown'),
    title: asString(row.source_title, 'Source not recorded'),
    publisher: asString(row.source_publisher, 'Unknown'),
    url: asNullableString(row.source_url),
    lastVerified,
    retrievedAt: asIsoDate(row.source_retrieved_at),
    verificationStatus: asVerificationStatus(row.source_verification_status),
    isStale: isSourceStale(lastVerified),
  };
}

export function toNullableSourceRef(row: Partial<SourceRow>): SourceRef | null {
  return row.source_id === null || row.source_id === undefined ? null : toSourceRef(row);
}

/* ── Entities ─────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

export function toService(row: Row): Service {
  return {
    id: asNumber(row.id),
    code: asString(row.code),
    departmentId: asNumber(row.department_id),
    departmentName: asNullableString(row.department_name),
    name: localizedFrom(row, 'name'),
    summary: localizedFrom(row, 'summary'),
    category: asString(row.category, 'identity'),
    officialUrl: asNullableString(row.official_url),
    onlineApplicationUrl: asNullableString(row.online_application_url),
    displayOrder: asNumber(row.display_order),
    isActive: asBoolean(row.is_active),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toScenario(row: Row): Scenario {
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    code: asString(row.code),
    name: localizedFrom(row, 'name'),
    description: asNullableString(row.description_en),
    selector: conditionFrom(row, 'selector', `scenario:${asString(row.code)}`),
    priority: asNumber(row.priority),
    isExceptionPath: asBoolean(row.is_exception_path),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

function toVariableOptions(value: unknown): VariableOption[] {
  const raw = asJson<unknown>(value, []);
  if (!Array.isArray(raw)) return [];
  const out: VariableOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const value_ = o.value;
    if (typeof value_ !== 'string' && typeof value_ !== 'number' && typeof value_ !== 'boolean') continue;
    out.push({
      value: value_,
      label: localized(
        asString(o.label_en, String(value_)),
        asNullableString(o.label_ur),
        asNullableString(o.label_roman_ur),
      ),
    });
  }
  return out;
}

export function toDecisionVariable(row: Row): DecisionVariable {
  const type = asString(row.var_type, 'text');
  return {
    id: asNumber(row.id),
    code: asString(row.code),
    serviceId: asNullableNumber(row.service_id),
    type: (['boolean', 'enum', 'number', 'text', 'date'] as const).includes(type as never)
      ? (type as DecisionVariable['type'])
      : 'text',
    prompt: localizedFrom(row, 'prompt'),
    help: row.help_en ? localizedFrom(row, 'help') : null,
    options: toVariableOptions(row.options),
    askPriority: asNumber(row.ask_priority),
    isSensitive: asBoolean(row.is_sensitive),
  };
}

export function toEligibilityRule(row: Row): EligibilityRule {
  const outcome = asString(row.outcome, 'conditional');
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    scenarioId: asNullableNumber(row.scenario_id),
    code: asString(row.code),
    statement: localizedFrom(row, 'statement'),
    condition: conditionFrom(row, 'condition', `rule:${asString(row.code)}`),
    outcome: (['eligible', 'ineligible', 'conditional', 'route_exception'] as const).includes(outcome as never)
      ? (outcome as EligibilityRule['outcome'])
      : 'conditional',
    failureMessage: asNullableString(row.failure_message_en),
    remedy: asNullableString(row.remedy_en),
    severity: asString(row.severity, 'blocking') === 'advisory' ? 'advisory' : 'blocking',
    version: asNumber(row.version),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toRequirement(row: Row): Requirement {
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    scenarioId: asNullableNumber(row.scenario_id),
    code: asString(row.code),
    documentType: asString(row.document_type),
    title: localizedFrom(row, 'title'),
    description: asNullableString(row.description_en),
    isMandatory: asBoolean(row.is_mandatory),
    appliesWhen: conditionFrom(row, 'applies_when', `requirement:${asString(row.code)}`),
    copiesRequired: asNullableNumber(row.copies_required),
    mustBeOriginal: asBoolean(row.must_be_original),
    substitutes: asStringArray(row.substitutes),
    obtainFrom: asNullableString(row.obtain_from),
    obtainServiceCode: asNullableString(row.obtain_service_code),
    displayOrder: asNumber(row.display_order),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toProcedureStep(row: Row): ProcedureStep {
  const channel = asString(row.channel, 'in_person');
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    scenarioId: asNullableNumber(row.scenario_id),
    code: asString(row.code),
    stepOrder: asNumber(row.step_order),
    title: localizedFrom(row, 'title'),
    instruction: localizedFrom(row, 'instruction'),
    channel: (['online', 'in_person', 'either', 'postal'] as const).includes(channel as never)
      ? (channel as ProcedureStep['channel'])
      : 'in_person',
    appliesWhen: conditionFrom(row, 'applies_when', `step:${asString(row.code)}`),
    actionUrl: asNullableString(row.action_url),
    estimatedDuration: asNullableString(row.estimated_duration),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toFee(row: Row): Fee {
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    scenarioId: asNullableNumber(row.scenario_id),
    code: asString(row.code),
    category: asString(row.category, 'normal'),
    label: localizedFrom(row, 'label'),
    amount: {
      // NULL survives as null all the way to the UI, where it renders as
      // "not verified" rather than as a number nobody checked.
      amountMinor: asNullableNumber(row.amount_minor),
      currency: asString(row.currency, 'PKR'),
    },
    appliesWhen: conditionFrom(row, 'applies_when', `fee:${asString(row.code)}`),
    note: asNullableString(row.note_en),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toProcessingTime(row: Row): ProcessingTime {
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    scenarioId: asNullableNumber(row.scenario_id),
    code: asString(row.code),
    category: asString(row.category, 'normal'),
    label: asString(row.label_en),
    minDays: asNullableNumber(row.min_days),
    maxDays: asNullableNumber(row.max_days),
    appliesWhen: conditionFrom(row, 'applies_when', `time:${asString(row.code)}`),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toOffice(row: Row): Office {
  return {
    id: asNumber(row.id),
    code: asString(row.code),
    departmentId: asNumber(row.department_id),
    name: localizedFrom(row, 'name'),
    officeType: asString(row.office_type, 'registration_centre'),
    address: asNullableString(row.address_en),
    city: asString(row.city),
    district: asNullableString(row.district),
    province: asString(row.province),
    latitude: asNullableNumber(row.latitude),
    longitude: asNullableNumber(row.longitude),
    phone: asNullableString(row.phone),
    email: asNullableString(row.email),
    hours: asNullableString(row.hours_en),
    appointmentUrl: asNullableString(row.appointment_url),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}

export function toExceptionRoute(row: Row): ExceptionRoute {
  return {
    id: asNumber(row.id),
    serviceId: asNumber(row.service_id),
    code: asString(row.code),
    name: localizedFrom(row, 'name'),
    trigger: conditionFrom(row, 'trigger_condition', `exception:${asString(row.code)}`),
    guidance: localizedFrom(row, 'guidance'),
    extraRequirementCodes: asStringArray(row.extra_requirement_codes),
    extraStepCodes: asStringArray(row.extra_step_codes),
    escalateToOffice: asBoolean(row.escalate_to_office),
    source: toNullableSourceRef(row as Partial<SourceRow>),
    verificationStatus: asVerificationStatus(row.verification_status),
  };
}
