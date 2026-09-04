/**
 * Completeness implies stability — the interview's safety property, enforced.
 *
 * ARCHITECTURE.md claims: "the interview stops when, and only when, no
 * remaining question could change the plan." For a long time that was a claim
 * the seeded eval suite could not falsify, because its scenarios only script
 * answers for questions the planner chooses to ask — a question wrongly
 * skipped leaves the scenario green if the baseline happens to match the
 * expectation. Two real planner defects (the unseeded baseline fingerprint,
 * and probe sets that could not reach a rule's thresholds) lived exactly in
 * that blind spot.
 *
 * This suite makes the property testable directly:
 *
 *   For any bundle and any answer state, if the planner reports
 *   `complete: true` without truncation, then no unanswered variable, probed
 *   with ANY value — derived probes and out-of-band random values alike —
 *   may change the outcome fingerprint.
 *
 * Bundles are generated randomly across the full condition grammar (including
 * the `answered` operator and thresholds far outside any fixed probe list),
 * from a seeded PRNG so every failure is reproducible from the printed seed.
 * All content is synthetic; no government facts.
 */
import { describe, expect, it } from 'vitest';

import { candidateValues, planInterview, probeConstantsFor } from '@/lib/engine/interview';
import { decide, outcomeFingerprint } from '@/lib/engine/rules';
import type { Condition } from '@/lib/schemas/conditions';
import type { AnswerMap, AnswerValue } from '@/lib/schemas/core';
import type { DecisionVariable, ServiceBundle } from '@/lib/schemas/domain';
import {
  makeBundle,
  makeException,
  makeRequirement,
  makeRule,
  makeScenario,
  makeStep,
  makeVariable,
  text,
} from '../fixtures/synthetic-bundle';

/* ── Seeded PRNG (mulberry32) ─────────────────────────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;

const int = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/* ── Random bundle generation ─────────────────────────────────────────── */

const TEXT_POOL = ['', 'value', 'alpha', 'beta', 'gamma'] as const;
const DATE_POOL = ['1990-01-01', '2010-06-15', '2026-01-01'] as const;

function randomLeaf(rng: () => number, variable: DecisionVariable): Condition {
  const v = variable.code;
  switch (variable.type) {
    case 'boolean':
      return pick(rng, [
        { op: 'truthy', var: v },
        { op: 'falsy', var: v },
        { op: 'eq', var: v, value: rng() < 0.5 },
        { op: 'answered', var: v },
      ] as const);
    case 'enum': {
      const options = variable.options.map((o) => o.value as AnswerValue);
      const subsetSize = int(rng, 1, Math.max(1, options.length));
      const subset = [...options].sort(() => rng() - 0.5).slice(0, subsetSize);
      return pick(rng, [
        { op: 'eq', var: v, value: pick(rng, options) },
        { op: 'in', var: v, value: subset },
        { op: 'nin', var: v, value: subset },
        { op: 'answered', var: v },
      ] as const);
    }
    case 'number': {
      // Thresholds deliberately include values far above any fixed probe
      // list, and occasional non-integers so region midpoints matter.
      const threshold = rng() < 0.2 ? int(rng, 0, 900) + 0.5 : int(rng, -3, 900);
      return pick(rng, [
        { op: 'gt', var: v, value: threshold },
        { op: 'gte', var: v, value: threshold },
        { op: 'lt', var: v, value: threshold },
        { op: 'lte', var: v, value: threshold },
        { op: 'eq', var: v, value: threshold },
        { op: 'answered', var: v },
      ] as const);
    }
    case 'date':
      return pick(rng, [
        { op: 'eq', var: v, value: pick(rng, DATE_POOL) },
        { op: 'in', var: v, value: [pick(rng, DATE_POOL)] },
        { op: 'answered', var: v },
      ] as const);
    case 'text':
      return pick(rng, [
        { op: 'eq', var: v, value: pick(rng, TEXT_POOL) },
        { op: 'truthy', var: v },
        { op: 'answered', var: v },
        { op: 'not', child: { op: 'answered', var: v } },
      ] as const);
  }
}

function randomCondition(rng: () => number, variables: DecisionVariable[], depth: number): Condition {
  if (depth <= 0 || rng() < 0.55) return randomLeaf(rng, pick(rng, variables));
  const kind = rng();
  if (kind < 0.4) {
    return {
      op: 'and',
      children: [randomCondition(rng, variables, depth - 1), randomCondition(rng, variables, depth - 1)],
    };
  }
  if (kind < 0.8) {
    return {
      op: 'or',
      children: [randomCondition(rng, variables, depth - 1), randomCondition(rng, variables, depth - 1)],
    };
  }
  return { op: 'not', child: randomCondition(rng, variables, depth - 1) };
}

function randomBundle(rng: () => number): ServiceBundle {
  const types = ['boolean', 'boolean', 'enum', 'number', 'text', 'date'] as const;
  const variableCount = int(rng, 3, 6);
  const variables: DecisionVariable[] = [];
  for (let i = 0; i < variableCount; i++) {
    const type = pick(rng, types);
    variables.push(
      makeVariable({
        code: `test_v${i}`,
        type,
        options:
          type === 'enum'
            ? [
                { value: 'opt_a', label: text('A') },
                { value: 'opt_b', label: text('B') },
                { value: 'opt_c', label: text('C') },
              ].slice(0, int(rng, 2, 3))
            : [],
      }),
    );
  }

  const baseScenario = makeScenario();
  const scenarios = [baseScenario];
  if (rng() < 0.4) {
    scenarios.push(
      makeScenario({
        code: 'test_branch',
        selector: randomCondition(rng, variables, 2),
        priority: -1,
      }),
    );
  }

  const requirements = Array.from({ length: int(rng, 2, 5) }, (_, i) =>
    makeRequirement({
      code: `test_req${i}`,
      appliesWhen: randomCondition(rng, variables, 2),
      isMandatory: rng() < 0.7,
    }),
  );

  const rules = Array.from({ length: int(rng, 0, 3) }, (_, i) => {
    const blocking = rng() < 0.5;
    return makeRule({
      code: `test_rule${i}`,
      condition: randomCondition(rng, variables, 2),
      severity: blocking ? 'blocking' : 'advisory',
      outcome: blocking ? 'ineligible' : 'conditional',
    });
  });

  const steps = Array.from({ length: int(rng, 0, 2) }, (_, i) =>
    makeStep({ code: `test_step${i}`, stepOrder: i + 1, appliesWhen: randomCondition(rng, variables, 2) }),
  );

  const exceptions = Array.from({ length: int(rng, 0, 2) }, (_, i) =>
    makeException({ code: `test_exc${i}`, trigger: randomCondition(rng, variables, 2) }),
  );

  return makeBundle({ variables, scenarios, requirements, rules, steps, exceptions });
}

/* ── Random values, including out-of-probe ones ───────────────────────── */

function randomRawValue(rng: () => number, variable: DecisionVariable): AnswerValue {
  switch (variable.type) {
    case 'boolean':
      return rng() < 0.5;
    case 'enum':
      return pick(rng, variable.options).value as AnswerValue;
    case 'number':
      return Math.round((rng() * 1100 - 50) * 2) / 2; // includes halves
    case 'date':
      return pick(rng, DATE_POOL);
    case 'text':
      return pick(rng, TEXT_POOL);
  }
}

/* ── The property ─────────────────────────────────────────────────────── */

const SEED = 20260904;
const BUNDLES = 220;
const STATES_PER_BUNDLE = 8;
const MIN_TOTAL_STATES = 1000;
const MIN_COMPLETED_STATES = 300;

describe('completeness implies stability', () => {
  it(`holds across ≥${MIN_TOTAL_STATES} random states (seed ${SEED})`, () => {
    const rng = mulberry32(SEED);
    let totalStates = 0;
    let completedStates = 0;

    const assertStable = (bundle: ServiceBundle, answers: AnswerMap, label: string) => {
      const constants = probeConstantsFor(bundle);
      const baseline = outcomeFingerprint(decide(bundle, answers));
      for (const variable of bundle.variables) {
        if (Object.hasOwn(answers, variable.code)) continue;
        const probes: AnswerValue[] = [
          ...candidateValues(variable, constants),
          randomRawValue(rng, variable),
          randomRawValue(rng, variable),
          randomRawValue(rng, variable),
        ];
        for (const probe of probes) {
          const fp = outcomeFingerprint(decide(bundle, { ...answers, [variable.code]: probe }));
          if (fp !== baseline) {
            throw new Error(
              [
                `INSTABILITY at ${label}: planner declared the interview complete,`,
                `but answering ${variable.code} = ${JSON.stringify(probe)} changes the outcome.`,
                `seed=${SEED}`,
                `answers=${JSON.stringify(answers)}`,
                `bundle=${JSON.stringify(bundle)}`,
              ].join('\n'),
            );
          }
        }
      }
    };

    for (let b = 0; b < BUNDLES; b++) {
      const bundle = randomBundle(rng);
      const constants = probeConstantsFor(bundle);

      // Random partial answer states.
      for (let s = 0; s < STATES_PER_BUNDLE; s++) {
        const answers: AnswerMap = {};
        for (const variable of bundle.variables) {
          if (rng() < 0.5) {
            answers[variable.code] =
              rng() < 0.7
                ? (pick(rng, candidateValues(variable, constants)) as AnswerMap[string])
                : (randomRawValue(rng, variable) as AnswerMap[string]);
          }
        }
        totalStates++;
        const plan = planInterview({ bundle, answers, asked: Object.keys(answers) });
        if (plan.complete && !plan.truncated) {
          completedStates++;
          assertStable(bundle, answers, `bundle ${b} / random state ${s}`);
        }
      }

      // One full interview walk to a natural completion, so the property is
      // exercised on states the planner itself steers into, not only on
      // arbitrary maps.
      const answers: AnswerMap = {};
      const asked: string[] = [];
      for (let turn = 0; turn < 40; turn++) {
        const plan = planInterview({ bundle, answers, asked });
        if (!plan.next) {
          totalStates++;
          if (plan.complete && !plan.truncated) {
            completedStates++;
            assertStable(bundle, answers, `bundle ${b} / interview walk`);
          }
          break;
        }
        asked.push(plan.next.code);
        answers[plan.next.code] = randomRawValue(rng, plan.next) as AnswerMap[string];
      }
    }

    expect(totalStates).toBeGreaterThanOrEqual(MIN_TOTAL_STATES);
    // Guard against vacuity: a suite that never reaches completion proves
    // nothing. The interview walks alone guarantee a completion per bundle.
    expect(completedStates).toBeGreaterThanOrEqual(MIN_COMPLETED_STATES);
  });
});
