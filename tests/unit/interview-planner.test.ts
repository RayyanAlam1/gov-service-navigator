/**
 * The interview planner's safety property, tested at the planner.
 *
 * The product claim: a question is skipped only when NO possible answer could
 * change what the citizen is told, and the interview declares itself complete
 * only when nothing it could still ask would change the plan.
 *
 * The seeded services never exercised three rule shapes that break that claim,
 * which is why the 51-scenario eval suite stayed green while the planner was
 * wrong. Each test below is one of those shapes, built from an explicitly
 * synthetic bundle (no government facts — see tests/fixtures/synthetic-bundle).
 *
 * History: before the baseline-fingerprint fix, `scoreCandidate` compared the
 * outcomes of hypothetical answers only against EACH OTHER. A variable whose
 * every answer produced the same outcome — but a different outcome from the
 * unanswered baseline — scored zero gain, was never asked, and the citizen was
 * shown the baseline plan: an outcome no answer they could give would produce.
 */
import { describe, expect, it } from 'vitest';

import { evaluate } from '@/lib/schemas/conditions';
import { decide, outcomeFingerprint } from '@/lib/engine/rules';
import { candidateValues, planInterview, probeConstantsFor } from '@/lib/engine/interview';
import { assessReadiness, buildChecklist } from '@/lib/engine/readiness';
import { assembleActionPlan } from '@/lib/engine/plan';
import type { AnswerMap } from '@/lib/schemas/core';
import {
  makeBundle,
  makeRequirement,
  makeRule,
  makeStep,
  makeVariable,
  text,
} from '../fixtures/synthetic-bundle';

/** Run the interview to completion, answering every question with `pick`. */
function runInterview(
  bundle: ReturnType<typeof makeBundle>,
  pick: (code: string) => unknown,
  maxTurns = 25,
): { answers: AnswerMap; askedCodes: string[] } {
  const answers: AnswerMap = {};
  const asked: string[] = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const plan = planInterview({ bundle, answers, asked });
    if (!plan.next) return { answers, askedCodes: asked };
    asked.push(plan.next.code);
    answers[plan.next.code] = pick(plan.next.code) as AnswerMap[string];
  }
  throw new Error('interview did not terminate');
}

describe('a question is asked when its answers all disagree with the unanswered baseline', () => {
  /**
   * Shape 1 — an enum fully covered by an `in`.
   *
   * `in: ['card', 'paper']` over a two-option enum is natural rule authoring:
   * "this document is needed whichever channel you chose". Every concrete
   * answer satisfies it; only "not yet asked" leaves it uncertain. Skipping
   * the question leaves the requirement hedged as "may apply" forever, when
   * in truth it applies no matter what the citizen says.
   */
  it('asks an enum question whose every option settles a may-apply requirement', () => {
    const bundle = makeBundle({
      variables: [
        makeVariable({
          code: 'test_channel',
          type: 'enum',
          options: [
            { value: 'card', label: text('Card') },
            { value: 'paper', label: text('Paper') },
          ],
        }),
      ],
      requirements: [
        makeRequirement({
          code: 'req_covered',
          appliesWhen: { op: 'in', var: 'test_channel', value: ['card', 'paper'] },
        }),
      ],
    });

    const plan = planInterview({ bundle, answers: {}, asked: [] });
    expect(plan.next?.code).toBe('test_channel');

    // And answering it settles the requirement definitively.
    const { answers } = runInterview(bundle, () => 'card');
    const state = decide(bundle, answers);
    const req = state.requirements.find((r) => r.item.code === 'req_covered');
    expect(req?.applicability).toBe(true);
  });

  /**
   * Shape 2 — `not(answered(x))`.
   *
   * A default step that applies only while a variable is unanswered: at the
   * baseline it is definitely present; after ANY answer it is definitely
   * gone. All probes agree with each other and disagree with the baseline.
   */
  it('asks a question that removes a default-only step', () => {
    const bundle = makeBundle({
      variables: [makeVariable({ code: 'test_note', type: 'text' })],
      steps: [
        makeStep({
          code: 'step_default_path',
          appliesWhen: { op: 'not', child: { op: 'answered', var: 'test_note' } },
        }),
      ],
    });

    const plan = planInterview({ bundle, answers: {}, asked: [] });
    expect(plan.next?.code).toBe('test_note');
  });

  /**
   * Shape 3 — a positive `answered(x)` gate.
   *
   * This one hides a layer earlier than the fingerprint bug: while x is
   * unanswered the condition is definitively FALSE (not unknown), so the row
   * was dropped entirely and x never even reached `openVariables`. The
   * planner cannot ask a question it never sees. `answered` is the one
   * operator in the grammar whose verdict can flip from a definite value
   * when knowledge is added, so open-variable collection must treat it
   * specially.
   */
  it('asks a question whose only effect is behind an answered() gate', () => {
    const bundle = makeBundle({
      variables: [makeVariable({ code: 'test_ref', type: 'text' })],
      requirements: [
        makeRequirement({
          code: 'req_when_known',
          appliesWhen: { op: 'answered', var: 'test_ref' },
        }),
      ],
    });

    const plan = planInterview({ bundle, answers: {}, asked: [] });
    expect(plan.next?.code).toBe('test_ref');
  });

  /**
   * Shape 4 — a numeric threshold outside the old hardcoded probe range.
   *
   * The probe list used to be a fixed array topping out at 100, with a
   * comment asserting it straddled "every threshold this domain uses". A
   * threshold of 400 made every probe agree, so the gain computed to zero.
   * Probes are now derived from the condition trees themselves, so a
   * threshold cannot exist that the probe set does not straddle.
   */
  it('asks a numeric question whose threshold exceeds any fixed probe list', () => {
    const bundle = makeBundle({
      variables: [makeVariable({ code: 'test_days', type: 'number' })],
      requirements: [
        makeRequirement({
          code: 'req_long_gap',
          appliesWhen: { op: 'gt', var: 'test_days', value: 400 },
        }),
      ],
    });

    const plan = planInterview({ bundle, answers: {}, asked: [] });
    expect(plan.next?.code).toBe('test_days');

    // The derived probes must straddle the threshold: at least one value on
    // each side, so both branches of the rule are reachable in simulation.
    const constants = probeConstantsFor(bundle);
    const probes = candidateValues(bundle.variables[0]!, constants);
    const cond = { op: 'gt', var: 'test_days', value: 400 } as const;
    const verdicts = new Set(probes.map((p) => evaluate(cond, { test_days: p })));
    expect(verdicts.has(true)).toBe(true);
    expect(verdicts.has(false)).toBe(true);
  });
});

describe('the planner still refuses genuinely useless questions', () => {
  it('never asks a variable no condition references', () => {
    const bundle = makeBundle({
      variables: [
        makeVariable({ code: 'test_used', type: 'boolean' }),
        makeVariable({ code: 'test_noise', type: 'boolean' }),
      ],
      requirements: [
        makeRequirement({
          code: 'req_used',
          appliesWhen: { op: 'truthy', var: 'test_used' },
        }),
      ],
    });

    const { askedCodes } = runInterview(bundle, () => true);
    expect(askedCodes).toContain('test_used');
    expect(askedCodes).not.toContain('test_noise');
  });

  it('completes only when no remaining answer could change the outcome', () => {
    const bundle = makeBundle({
      variables: [
        makeVariable({
          code: 'test_channel',
          type: 'enum',
          options: [
            { value: 'card', label: text('Card') },
            { value: 'paper', label: text('Paper') },
          ],
        }),
      ],
      requirements: [
        makeRequirement({
          code: 'req_covered',
          appliesWhen: { op: 'in', var: 'test_channel', value: ['card', 'paper'] },
        }),
      ],
      rules: [
        makeRule({
          code: 'rule_settled',
          condition: { op: 'in', var: 'test_channel', value: ['card', 'paper'] },
          outcome: 'conditional',
          severity: 'advisory',
        }),
      ],
    });

    const { answers } = runInterview(bundle, () => 'paper');
    const finalPlan = planInterview({ bundle, answers, asked: Object.keys(answers) });
    expect(finalPlan.complete).toBe(true);

    // Completion must be stable: no unanswered variable, probed with any
    // value it could take, may change the outcome fingerprint.
    const constants = probeConstantsFor(bundle);
    const baseline = outcomeFingerprint(decide(bundle, answers));
    for (const variable of bundle.variables) {
      if (Object.hasOwn(answers, variable.code)) continue;
      for (const probe of candidateValues(variable, constants)) {
        const fp = outcomeFingerprint(decide(bundle, { ...answers, [variable.code]: probe }));
        expect(fp).toBe(baseline);
      }
    }
  });
});

describe('a truncated interview is never mistaken for a finished one', () => {
  /** Three useful boolean questions; a budget of one forces truncation. */
  const truncatableBundle = () =>
    makeBundle({
      variables: [
        makeVariable({ code: 'test_a', type: 'boolean' }),
        makeVariable({ code: 'test_b', type: 'boolean' }),
        makeVariable({ code: 'test_c', type: 'boolean' }),
      ],
      requirements: [
        makeRequirement({ code: 'req_a', appliesWhen: { op: 'truthy', var: 'test_a' } }),
        makeRequirement({ code: 'req_b', appliesWhen: { op: 'truthy', var: 'test_b' } }),
        makeRequirement({ code: 'req_c', appliesWhen: { op: 'truthy', var: 'test_c' } }),
      ],
    });

  it('reports truncated: true, distinct from genuine completion', () => {
    const bundle = truncatableBundle();

    const truncatedPlan = planInterview({
      bundle,
      answers: { test_a: true },
      asked: ['test_a'],
      maxQuestions: 1,
    });
    expect(truncatedPlan.complete).toBe(true);
    expect(truncatedPlan.truncated).toBe(true);
    expect(truncatedPlan.completionReason).toBe('question_budget');

    const finishedPlan = planInterview({
      bundle,
      answers: { test_a: true, test_b: false, test_c: false },
      asked: ['test_a', 'test_b', 'test_c'],
      maxQuestions: 1,
    });
    expect(finishedPlan.complete).toBe(true);
    expect(finishedPlan.truncated).toBe(false);
  });

  it('keeps readiness at undetermined when the interview was truncated', () => {
    const bundle = truncatableBundle();
    const answers: AnswerMap = { test_a: false };
    const state = decide(bundle, answers);
    const checklist = buildChecklist({ bundle, state, answers, language: 'en' });

    const truncated = assessReadiness({
      bundle,
      state,
      checklist,
      interviewComplete: true,
      interviewTruncated: true,
    });
    expect(truncated.state).toBe('undetermined');
  });

  it('leads the plan caveats with an explicit truncation notice', () => {
    const bundle = truncatableBundle();
    const answers: AnswerMap = { test_a: false };
    const state = decide(bundle, answers);
    const checklist = buildChecklist({ bundle, state, answers, language: 'en' });

    const plan = assembleActionPlan({
      bundle,
      state,
      checklist,
      offices: [],
      answers,
      sufficiency: null,
      language: 'en',
      interviewTruncated: true,
    });
    expect(plan.caveats[0]).toMatch(/paused the questions/i);

    const untruncated = assembleActionPlan({
      bundle,
      state,
      checklist,
      offices: [],
      answers,
      sufficiency: null,
      language: 'en',
      interviewTruncated: false,
    });
    expect(untruncated.caveats.join(' ')).not.toMatch(/paused the questions/i);
  });
});
