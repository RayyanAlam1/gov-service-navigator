/**
 * The condition language.
 *
 * Scenario selectors, eligibility rules, requirement applicability and
 * exception triggers are all expressed as small JSON condition trees stored in
 * the database and evaluated by code. Two reasons this is not prose handed to
 * a model:
 *
 *   1. It is testable and diffable. When NADRA changes a rule, the change is a
 *      row edit with a version bump, visible in a diff, coverable by a test.
 *   2. It is *inspectable*. A citizen can be shown exactly which condition put
 *      them on the lost-CNIC branch, and a judge can be shown that no model
 *      was involved in the decision.
 *
 * Evaluation is deliberately three-valued (Kleene logic): TRUE, FALSE, and
 * UNKNOWN when a referenced variable has not been answered yet. UNKNOWN is
 * what makes the adaptive interview possible — a question is worth asking
 * precisely when resolving its UNKNOWN can change an outcome.
 */
import { z } from 'zod';
import type { AnswerMap, AnswerValue } from './core';

/* ── AST ──────────────────────────────────────────────────────────────── */

export type Condition =
  | { op: 'always' }
  | { op: 'never' }
  | { op: 'and'; children: Condition[] }
  | { op: 'or'; children: Condition[] }
  | { op: 'not'; child: Condition }
  | { op: 'eq'; var: string; value: AnswerValue }
  | { op: 'neq'; var: string; value: AnswerValue }
  | { op: 'in'; var: string; value: AnswerValue[] }
  | { op: 'nin'; var: string; value: AnswerValue[] }
  | { op: 'gt'; var: string; value: number }
  | { op: 'gte'; var: string; value: number }
  | { op: 'lt'; var: string; value: number }
  | { op: 'lte'; var: string; value: number }
  | { op: 'truthy'; var: string }
  | { op: 'falsy'; var: string }
  | { op: 'answered'; var: string };

const AnswerValueLiteral = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('always') }),
    z.object({ op: z.literal('never') }),
    z.object({ op: z.literal('and'), children: z.array(ConditionSchema) }),
    z.object({ op: z.literal('or'), children: z.array(ConditionSchema) }),
    z.object({ op: z.literal('not'), child: ConditionSchema }),
    z.object({ op: z.literal('eq'), var: z.string(), value: AnswerValueLiteral }),
    z.object({ op: z.literal('neq'), var: z.string(), value: AnswerValueLiteral }),
    z.object({ op: z.literal('in'), var: z.string(), value: z.array(AnswerValueLiteral) }),
    z.object({ op: z.literal('nin'), var: z.string(), value: z.array(AnswerValueLiteral) }),
    z.object({ op: z.literal('gt'), var: z.string(), value: z.number() }),
    z.object({ op: z.literal('gte'), var: z.string(), value: z.number() }),
    z.object({ op: z.literal('lt'), var: z.string(), value: z.number() }),
    z.object({ op: z.literal('lte'), var: z.string(), value: z.number() }),
    z.object({ op: z.literal('truthy'), var: z.string() }),
    z.object({ op: z.literal('falsy'), var: z.string() }),
    z.object({ op: z.literal('answered'), var: z.string() }),
  ]) as unknown as z.ZodType<Condition>,
);

export const ALWAYS: Condition = { op: 'always' };

/**
 * Parse a condition from a database JSONB column.
 *
 * A malformed condition is a data bug, and the safe reading of "I cannot
 * evaluate this rule" is *not* "the rule passes". It returns `never`, which
 * makes the affected requirement or scenario drop out rather than silently
 * apply to everyone.
 */
export function parseCondition(raw: unknown, onError?: (msg: string) => void): Condition {
  if (raw === null || raw === undefined) return ALWAYS;
  const parsed = ConditionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  onError?.(`invalid condition: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return { op: 'never' };
}

/* ── Three-valued evaluation ──────────────────────────────────────────── */

export type Tri = true | false | 'unknown';

export function triAnd(values: readonly Tri[]): Tri {
  let sawUnknown = false;
  for (const v of values) {
    if (v === false) return false; // a single false short-circuits regardless of unknowns
    if (v === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : true;
}

export function triOr(values: readonly Tri[]): Tri {
  let sawUnknown = false;
  for (const v of values) {
    if (v === true) return true;
    if (v === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : false;
}

export function triNot(value: Tri): Tri {
  return value === 'unknown' ? 'unknown' : !value;
}

function lookup(answers: AnswerMap, name: string): { known: boolean; value: AnswerValue } {
  if (!Object.hasOwn(answers, name)) return { known: false, value: null };
  const value = answers[name];
  // An explicit null means "asked, and the citizen has no value for this",
  // which is knowledge. Only absence is unknown.
  return { known: value !== undefined, value: value ?? null };
}

/** Loose equality across the answer domain, with string comparison case- and space-insensitive. */
function valuesEqual(a: AnswerValue, b: AnswerValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return toBool(a) === toBool(b);
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function toBool(v: AnswerValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'yes', '1', 'haan', 'han', 'ji', 'ہاں'].includes(v.trim().toLowerCase());
  return false;
}

function toNumber(v: AnswerValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

const MAX_DEPTH = 32;

export function evaluate(condition: Condition, answers: AnswerMap, depth = 0): Tri {
  if (depth > MAX_DEPTH) return 'unknown'; // malformed/cyclic data must not hang a request

  switch (condition.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'and':
      return condition.children.length === 0
        ? true
        : triAnd(condition.children.map((c) => evaluate(c, answers, depth + 1)));
    case 'or':
      return condition.children.length === 0
        ? false
        : triOr(condition.children.map((c) => evaluate(c, answers, depth + 1)));
    case 'not':
      return triNot(evaluate(condition.child, answers, depth + 1));
    case 'answered':
      return lookup(answers, condition.var).known;
    default:
      break;
  }

  const { known, value } = lookup(answers, condition.var);
  if (!known) return 'unknown';

  switch (condition.op) {
    case 'eq':
      return valuesEqual(value, condition.value);
    case 'neq':
      return !valuesEqual(value, condition.value);
    case 'in':
      return condition.value.some((v) => valuesEqual(value, v));
    case 'nin':
      return !condition.value.some((v) => valuesEqual(value, v));
    case 'truthy':
      return toBool(value);
    case 'falsy':
      return !toBool(value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = toNumber(value);
      if (n === null) return 'unknown'; // non-numeric answer to a numeric comparison
      switch (condition.op) {
        case 'gt':
          return n > condition.value;
        case 'gte':
          return n >= condition.value;
        case 'lt':
          return n < condition.value;
        case 'lte':
          return n <= condition.value;
      }
    }
  }
}

/** Convenience: treat UNKNOWN as not-applicable. Used where a definite answer is required. */
export function isDefinitelyTrue(condition: Condition, answers: AnswerMap): boolean {
  return evaluate(condition, answers) === true;
}

/* ── Introspection ────────────────────────────────────────────────────── */

/** Every variable a condition tree reads. Drives question selection and coverage checks. */
export function referencedVariables(condition: Condition, into: Set<string> = new Set()): Set<string> {
  switch (condition.op) {
    case 'always':
    case 'never':
      break;
    case 'and':
    case 'or':
      for (const c of condition.children) referencedVariables(c, into);
      break;
    case 'not':
      referencedVariables(condition.child, into);
      break;
    default:
      into.add(condition.var);
  }
  return into;
}

/** Variables the tree reads that have no answer yet. */
export function unresolvedVariables(condition: Condition, answers: AnswerMap): Set<string> {
  const out = new Set<string>();
  for (const name of referencedVariables(condition)) {
    if (!lookup(answers, name).known) out.add(name);
  }
  return out;
}

/**
 * Unanswered variables sitting under an `answered` operator.
 *
 * Three-valued evaluation is monotone in knowledge for every operator except
 * this one: a comparison over a missing answer is UNKNOWN and can only refine
 * to a definite value, but `answered(x)` is definitively FALSE while x is
 * missing and flips to TRUE the moment any answer arrives. A row gated on it
 * therefore evaluates *definitely* at baseline and still changes when the
 * citizen speaks — so "the verdict is settled" is not evidence the variable
 * is settled. Open-variable collection has to treat these specially, or the
 * planner can never ask a question whose only effect is behind such a gate.
 */
export function answeredGateVariables(
  condition: Condition,
  answers: AnswerMap,
  into: Set<string> = new Set(),
): Set<string> {
  switch (condition.op) {
    case 'and':
    case 'or':
      for (const c of condition.children) answeredGateVariables(c, answers, into);
      break;
    case 'not':
      answeredGateVariables(condition.child, answers, into);
      break;
    case 'answered':
      if (!lookup(answers, condition.var).known) into.add(condition.var);
      break;
    default:
      break;
  }
  return into;
}

/* ── Probe constants ──────────────────────────────────────────────────── */

/**
 * Every literal a set of condition trees compares against, grouped by the
 * variable it is compared to.
 *
 * The interview planner simulates answers to measure whether a question can
 * change the plan. For enums and booleans the value domain is exact; for
 * numbers, dates and text it has to be sampled — and a sample that misses a
 * threshold silently under-reports a question's information gain to zero.
 * The probe set used to be a hardcoded list with a comment asserting it
 * straddled every threshold "this domain uses"; that invariant was true by
 * inspection and enforced by nothing, which is how a threshold of 400 made a
 * question unaskable. Deriving the constants from the condition trees makes
 * the straddling property hold by construction: a threshold cannot exist
 * that this walker did not see.
 */
export interface ProbeConstants {
  numbers: Map<string, Set<number>>;
  strings: Map<string, Set<string>>;
}

export function collectProbeConstants(
  conditions: Iterable<Condition>,
  into: ProbeConstants = { numbers: new Map(), strings: new Map() },
): ProbeConstants {
  const addNumber = (variable: string, value: number) => {
    if (!Number.isFinite(value)) return;
    const set = into.numbers.get(variable) ?? new Set<number>();
    set.add(value);
    into.numbers.set(variable, set);
  };
  const addString = (variable: string, value: string) => {
    const set = into.strings.get(variable) ?? new Set<string>();
    set.add(value);
    into.strings.set(variable, set);
  };
  const addValue = (variable: string, value: AnswerValue) => {
    if (typeof value === 'number') addNumber(variable, value);
    else if (typeof value === 'string') addString(variable, value);
    // Booleans and nulls need no constants: their domains are probed exactly.
  };

  const walk = (condition: Condition): void => {
    switch (condition.op) {
      case 'and':
      case 'or':
        for (const c of condition.children) walk(c);
        return;
      case 'not':
        walk(condition.child);
        return;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        addNumber(condition.var, condition.value);
        return;
      case 'eq':
      case 'neq':
        addValue(condition.var, condition.value);
        return;
      case 'in':
      case 'nin':
        for (const v of condition.value) addValue(condition.var, v);
        return;
      default:
        return;
    }
  };

  for (const condition of conditions) walk(condition);
  return into;
}

/**
 * Human-readable rendering, used by the "why are you asking this?" affordance
 * and by the trace panel. Deliberately plain: this is shown to citizens.
 */
export function explainCondition(condition: Condition, labelFor: (v: string) => string = (v) => v): string {
  switch (condition.op) {
    case 'always':
      return 'always applies';
    case 'never':
      return 'never applies';
    // Nested groups are parenthesised. "A and B or C" is ambiguous prose, and
    // this string is shown to a citizen to justify a question they are being
    // asked — it has to read unambiguously.
    case 'and':
      return condition.children.map((c) => group(c, labelFor)).join(' and ');
    case 'or':
      return condition.children.map((c) => group(c, labelFor)).join(' or ');
    case 'not':
      return `not (${explainCondition(condition.child, labelFor)})`;
    case 'answered':
      return `${labelFor(condition.var)} is known`;
    case 'truthy':
      return `${labelFor(condition.var)} is yes`;
    case 'falsy':
      return `${labelFor(condition.var)} is no`;
    case 'eq':
      return `${labelFor(condition.var)} is ${format(condition.value)}`;
    case 'neq':
      return `${labelFor(condition.var)} is not ${format(condition.value)}`;
    case 'in':
      return `${labelFor(condition.var)} is one of ${condition.value.map(format).join(', ')}`;
    case 'nin':
      return `${labelFor(condition.var)} is none of ${condition.value.map(format).join(', ')}`;
    case 'gt':
      return `${labelFor(condition.var)} is more than ${condition.value}`;
    case 'gte':
      return `${labelFor(condition.var)} is at least ${condition.value}`;
    case 'lt':
      return `${labelFor(condition.var)} is less than ${condition.value}`;
    case 'lte':
      return `${labelFor(condition.var)} is at most ${condition.value}`;
  }
}

/** Wrap a child in parentheses when it is itself a compound expression. */
function group(condition: Condition, labelFor: (v: string) => string): string {
  const rendered = explainCondition(condition, labelFor);
  const isCompound = condition.op === 'and' || condition.op === 'or';
  return isCompound && condition.children.length > 1 ? `(${rendered})` : rendered;
}

function format(v: AnswerValue): string {
  if (v === null) return 'not provided';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
