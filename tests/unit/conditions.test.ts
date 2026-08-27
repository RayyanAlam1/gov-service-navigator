import { describe, expect, it } from 'vitest';
import {
  ALWAYS,
  evaluate,
  explainCondition,
  parseCondition,
  referencedVariables,
  triAnd,
  triNot,
  triOr,
  unresolvedVariables,
  type Condition,
} from '@/lib/schemas/conditions';

describe('three-valued logic', () => {
  it('AND: a definite false beats any number of unknowns', () => {
    // This is the safety-relevant case. If a requirement's condition contains
    // a false conjunct, the requirement does not apply — we do not need to
    // interrogate the citizen about the rest of it.
    expect(triAnd([false, 'unknown', 'unknown'])).toBe(false);
    expect(triAnd([true, 'unknown'])).toBe('unknown');
    expect(triAnd([true, true])).toBe(true);
    expect(triAnd([])).toBe(true);
  });

  it('OR: a definite true beats any number of unknowns', () => {
    expect(triOr([true, 'unknown'])).toBe(true);
    expect(triOr([false, 'unknown'])).toBe('unknown');
    expect(triOr([false, false])).toBe(false);
    expect(triOr([])).toBe(false);
  });

  it('NOT leaves unknown unknown', () => {
    expect(triNot('unknown')).toBe('unknown');
    expect(triNot(true)).toBe(false);
    expect(triNot(false)).toBe(true);
  });
});

describe('evaluate', () => {
  const lostCnic: Condition = {
    op: 'and',
    children: [
      { op: 'eq', var: 'application_type', value: 'lost' },
      { op: 'truthy', var: 'has_fir' },
    ],
  };

  it('returns unknown until every referenced variable is answered', () => {
    expect(evaluate(lostCnic, {})).toBe('unknown');
    expect(evaluate(lostCnic, { application_type: 'lost' })).toBe('unknown');
    expect(evaluate(lostCnic, { application_type: 'lost', has_fir: true })).toBe(true);
  });

  it('short-circuits to false without needing the rest', () => {
    expect(evaluate(lostCnic, { application_type: 'renewal' })).toBe(false);
  });

  it('treats an explicit null as answered, not unknown', () => {
    // "Asked, and the citizen has no value for this" is knowledge. Only
    // absence of the key is unknown.
    expect(evaluate({ op: 'answered', var: 'fir_number' }, { fir_number: null })).toBe(true);
    expect(evaluate({ op: 'answered', var: 'fir_number' }, {})).toBe(false);
  });

  it('compares strings case- and whitespace-insensitively', () => {
    expect(evaluate({ op: 'eq', var: 'city', value: 'karachi' }, { city: '  Karachi ' })).toBe(true);
  });

  it('accepts Urdu and Roman Urdu affirmatives as truthy', () => {
    for (const yes of ['haan', 'han', 'ji', 'ہاں', 'yes', 'true', '1']) {
      expect(evaluate({ op: 'truthy', var: 'x' }, { x: yes })).toBe(true);
    }
    expect(evaluate({ op: 'truthy', var: 'x' }, { x: 'nahi' })).toBe(false);
  });

  it('returns unknown for a numeric comparison against a non-numeric answer', () => {
    // Guessing here would silently decide an age-gated eligibility rule.
    expect(evaluate({ op: 'gte', var: 'age', value: 18 }, { age: 'bara' })).toBe('unknown');
    expect(evaluate({ op: 'gte', var: 'age', value: 18 }, { age: '19' })).toBe(true);
    expect(evaluate({ op: 'gte', var: 'age', value: 18 }, { age: 17 })).toBe(false);
  });

  it('handles in/nin over mixed value types', () => {
    const c: Condition = { op: 'in', var: 'province', value: ['Sindh', 'Punjab'] };
    expect(evaluate(c, { province: 'sindh' })).toBe(true);
    expect(evaluate(c, { province: 'Balochistan' })).toBe(false);
    expect(evaluate(c, {})).toBe('unknown');
  });

  it('does not recurse without bound on malformed depth', () => {
    let deep: Condition = { op: 'truthy', var: 'x' };
    for (let i = 0; i < 100; i += 1) deep = { op: 'not', child: deep };
    expect(() => evaluate(deep, { x: true })).not.toThrow();
  });
});

describe('parseCondition', () => {
  it('defaults a missing condition to always', () => {
    expect(parseCondition(null)).toEqual(ALWAYS);
    expect(parseCondition(undefined)).toEqual(ALWAYS);
  });

  it('fails closed: a malformed condition becomes never, not always', () => {
    // A rule we cannot evaluate must drop out, not apply to everyone.
    const errors: string[] = [];
    expect(parseCondition({ op: 'nonsense' }, (m) => errors.push(m))).toEqual({ op: 'never' });
    expect(errors).toHaveLength(1);
  });

  it('round-trips a nested tree from JSON', () => {
    const raw = {
      op: 'or',
      children: [
        { op: 'and', children: [{ op: 'eq', var: 'a', value: 1 }, { op: 'falsy', var: 'b' }] },
        { op: 'not', child: { op: 'in', var: 'c', value: ['x', 'y'] } },
      ],
    };
    const parsed = parseCondition(JSON.parse(JSON.stringify(raw)));
    expect(parsed).toEqual(raw);
    expect(evaluate(parsed, { a: 1, b: false })).toBe(true);
  });
});

describe('introspection', () => {
  const c: Condition = {
    op: 'and',
    children: [
      { op: 'eq', var: 'application_type', value: 'lost' },
      { op: 'or', children: [{ op: 'truthy', var: 'has_fir' }, { op: 'gte', var: 'age', value: 18 }] },
    ],
  };

  it('collects every referenced variable', () => {
    expect([...referencedVariables(c)].sort()).toEqual(['age', 'application_type', 'has_fir']);
  });

  it('reports only the unanswered ones', () => {
    expect([...unresolvedVariables(c, { application_type: 'lost' })].sort()).toEqual(['age', 'has_fir']);
    expect([...unresolvedVariables(c, { application_type: 'lost', has_fir: true, age: 20 })]).toEqual([]);
  });

  it('renders a citizen-readable explanation', () => {
    const label = (v: string) => ({ application_type: 'your application type', has_fir: 'you have an FIR' })[v] ?? v;
    expect(explainCondition(c, label)).toBe(
      'your application type is lost and (you have an FIR is yes or age is at least 18)',
    );
  });
});
