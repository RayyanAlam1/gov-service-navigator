#!/usr/bin/env tsx
/**
 * npm run eval               run the scenario suite and print a report
 * npm run eval -- --html     also write eval/report/index.html
 * npm run eval -- --json     also write eval/report/latest.json
 * npm run eval -- --id x,y   run only these scenario ids
 * npm run eval -- --cold     bypass the LLM cache (measures live latency)
 *
 * Targets (docs/EVALUATION.md):
 *
 *   service identification    >= 90%
 *   scenario identification   >= 90%
 *   required-document F1      >= 90%
 *   readiness classification  >= 90%
 *   source grounding          100%   (absolute)
 *   unsupported claims        0      (absolute)
 *
 * The last two are absolute for a reason: a 99% grounding rate means one
 * citizen in a hundred is sent to the wrong office with confidence. This
 * script exits non-zero when either absolute target is missed, so CI fails on
 * a hallucination rather than reporting a good average.
 *
 * Runs the real pipeline — the same orchestrator the web app calls — against a
 * real database seeded from db/seed/. It does not mock the engine, because a
 * harness that tests a mock measures the mock.
 */
import './_env';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describeCapabilities, getConfig } from '@/lib/config/env';
import { closeDb, sql } from '@/lib/db/client';
import { loadServiceBundleByCode } from '@/lib/db/knowledge';
import { createSession, saveAnswers, updateSession } from '@/lib/db/sessions';
import { advanceSession, applyInferredAnswers, runIntake } from '@/lib/engine/orchestrator';
import { runSeed } from '../db/seed/run';
import { SCENARIOS, type EvalScenario } from '../eval/scenarios';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const valueOf = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const writeHtml = flag('html');
const writeJson = flag('json');
const cold = flag('cold');
const only = valueOf('id')?.split(',').map((s) => s.trim()).filter(Boolean);
const skipSeed = flag('no-seed');

interface Failure {
  field: string;
  expected: string;
  actual: string;
}

interface ScenarioResult {
  scenario: EvalScenario;
  passed: boolean;
  failures: Failure[];
  questionsAsked: number;
  latencyMs: number;
  outcome: string;
  serviceCode: string | null;
  scenarioCode: string | null;
  eligibility: string | null;
  readiness: string | null;
  documents: string[];
  exceptions: string[];
  blockingRules: string[];
  unsupportedClaims: Array<{ kind: string; text: string; reason: string }>;
  /** True when every citizen-facing element in the plan carried a source. */
  fullyGrounded: boolean;
  error: string | null;
}

/* ── Runner ───────────────────────────────────────────────────────────── */

async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  const started = Date.now();
  const base: ScenarioResult = {
    scenario,
    passed: false,
    failures: [],
    questionsAsked: 0,
    latencyMs: 0,
    outcome: 'error',
    serviceCode: null,
    scenarioCode: null,
    eligibility: null,
    readiness: null,
    documents: [],
    exceptions: [],
    blockingRules: [],
    unsupportedClaims: [],
    fullyGrounded: false,
    error: null,
  };

  try {
    const session = await createSession({
      language: scenario.language,
      originalQuery: scenario.query,
      normalizedQuery: null,
      clientFingerprint: `eval-${randomUUID()}`,
    });

    const intake = await runIntake({ session, query: scenario.query });

    if (!intake.guardrail.ok) {
      return finish({ ...base, outcome: 'refused' }, scenario, started);
    }

    if (!intake.resolution?.resolved) {
      return finish({ ...base, outcome: 'disambiguate' }, scenario, started);
    }

    const serviceCode = intake.resolution.resolved.serviceCode;
    const bundle = await loadServiceBundleByCode(serviceCode);
    if (!bundle) throw new Error(`bundle missing for ${serviceCode}`);

    await updateSession(session.token, { serviceId: bundle.service.id, status: 'interviewing' });
    await applyInferredAnswers(session.id, bundle, intake.inferredAnswers);

    // Walk the interview, answering from the script. An unscripted question is
    // skipped, which is what a real citizen who does not know would do.
    let questionsAsked = 0;
    let turn = await advanceSession({
      session,
      serviceId: bundle.service.id,
      language: intake.language,
    });

    while (turn.outcome.kind === 'question' && questionsAsked < 12) {
      const variable = turn.outcome.question.variableCode;
      questionsAsked += 1;

      if (Object.hasOwn(scenario.answers, variable)) {
        await saveAnswers(session.id, [
          { variableCode: variable, value: scenario.answers[variable] ?? null, origin: 'user' },
        ]);
      } else {
        await saveAnswers(session.id, [{ variableCode: variable, value: null, origin: 'user' }]);
      }

      turn = await advanceSession({
        session,
        serviceId: bundle.service.id,
        language: intake.language,
      });
    }

    // Any possession answers the scenario declares that were never asked
    // (possession is collected by ticking, not by interview) go in now.
    const possession = Object.entries(scenario.answers).filter(([k]) => k.startsWith('has_'));
    if (possession.length > 0) {
      await saveAnswers(
        session.id,
        possession.map(([variableCode, value]) => ({ variableCode, value, origin: 'user' as const })),
      );
      turn = await advanceSession({
        session,
        serviceId: bundle.service.id,
        language: intake.language,
        forcePlan: true,
      });
    }

    if (turn.outcome.kind !== 'plan') {
      return finish({ ...base, outcome: turn.outcome.kind, serviceCode, questionsAsked }, scenario, started);
    }

    const { plan, readiness, grounding } = turn.outcome;
    const decision = turn.decision;

    // Grounding: every citizen-facing element must carry a source.
    const fullyGrounded =
      plan.steps.every((s) => s.source !== null) &&
      plan.checklist.every((c) => c.source !== null) &&
      plan.fees.every((f) => f.source !== null);

    return finish(
      {
        ...base,
        outcome: 'plan',
        serviceCode,
        scenarioCode: turn.scenarioCode,
        eligibility: decision?.eligibility.outcome ?? null,
        readiness: readiness.state,
        documents: plan.checklist.map((c) => c.requirementCode),
        exceptions: plan.exceptions.map((e) => e.code),
        blockingRules: readiness.blockingRules.map((r) => r.code),
        unsupportedClaims: grounding.violations,
        fullyGrounded,
        questionsAsked,
      },
      scenario,
      started,
    );
  } catch (err) {
    return finish(
      { ...base, error: err instanceof Error ? err.message : String(err) },
      scenario,
      started,
    );
  }
}

/* ── Assertions ───────────────────────────────────────────────────────── */

function finish(result: ScenarioResult, scenario: EvalScenario, started: number): ScenarioResult {
  const failures: Failure[] = [];
  const expect = scenario.expect;

  const check = (field: string, expected: unknown, actual: unknown, ok: boolean) => {
    if (!ok) failures.push({ field, expected: String(expected), actual: String(actual) });
  };

  if (result.error) {
    failures.push({ field: 'error', expected: 'no error', actual: result.error });
  }

  if (expect.outcome) {
    check('outcome', expect.outcome, result.outcome, result.outcome === expect.outcome);
  }
  if (expect.serviceCode && result.outcome === 'plan') {
    check('service', expect.serviceCode, result.serviceCode, result.serviceCode === expect.serviceCode);
  }
  if (expect.scenarioCode && result.outcome === 'plan') {
    check('scenario', expect.scenarioCode, result.scenarioCode, result.scenarioCode === expect.scenarioCode);
  }
  if (expect.eligibility && result.outcome === 'plan') {
    check('eligibility', expect.eligibility, result.eligibility, result.eligibility === expect.eligibility);
  }
  if (expect.readiness && result.outcome === 'plan') {
    check('readiness', expect.readiness, result.readiness, result.readiness === expect.readiness);
  }

  for (const code of expect.requiredDocuments ?? []) {
    check(`document:${code}`, 'present', result.documents.join(',') || 'none', result.documents.includes(code));
  }
  // Over-listing is a real failure: it sends the citizen to collect papers they
  // do not need, which is exactly the experience this product replaces.
  for (const code of expect.forbiddenDocuments ?? []) {
    check(`document:!${code}`, 'absent', result.documents.includes(code) ? 'present' : 'absent', !result.documents.includes(code));
  }
  for (const code of expect.exceptions ?? []) {
    check(`exception:${code}`, 'fired', result.exceptions.join(',') || 'none', result.exceptions.includes(code));
  }
  for (const code of expect.blockingRules ?? []) {
    check(`rule:${code}`, 'fired', result.blockingRules.join(',') || 'none', result.blockingRules.includes(code));
  }
  if (expect.maxQuestions !== undefined) {
    check(
      'questions',
      `<= ${expect.maxQuestions}`,
      result.questionsAsked,
      result.questionsAsked <= expect.maxQuestions,
    );
  }

  // Absolute targets, checked on every scenario that produced a plan.
  if (result.outcome === 'plan') {
    check('grounding', 'every element sourced', result.fullyGrounded ? 'yes' : 'no', result.fullyGrounded);
    check(
      'unsupportedClaims',
      '0',
      result.unsupportedClaims.length,
      result.unsupportedClaims.length === 0,
    );
  }

  return { ...result, failures, passed: failures.length === 0, latencyMs: Date.now() - started };
}

/* ── Metrics ──────────────────────────────────────────────────────────── */

interface Metrics {
  total: number;
  passed: number;
  serviceAccuracy: number | null;
  scenarioAccuracy: number | null;
  documentF1: number | null;
  readinessAccuracy: number | null;
  groundingRate: number;
  unsupportedClaims: number;
  avgQuestions: number;
  avgLatencyMs: number;
  guardrailAccuracy: number | null;
}

function computeMetrics(results: readonly ScenarioResult[]): Metrics {
  const rate = (num: number, den: number) => (den === 0 ? null : num / den);

  const withService = results.filter((r) => r.scenario.expect.serviceCode);
  const withScenario = results.filter((r) => r.scenario.expect.scenarioCode && r.outcome === 'plan');
  const withReadiness = results.filter((r) => r.scenario.expect.readiness && r.outcome === 'plan');
  const guardrails = results.filter((r) =>
    r.scenario.expect.outcome === 'refused' || r.scenario.expect.outcome === 'disambiguate',
  );
  const plans = results.filter((r) => r.outcome === 'plan');

  // Document accuracy as F1 over required/forbidden expectations, so both
  // under-listing (missed document) and over-listing (spurious document) count.
  let truePositives = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  for (const result of results) {
    for (const code of result.scenario.expect.requiredDocuments ?? []) {
      if (result.documents.includes(code)) truePositives += 1;
      else falseNegatives += 1;
    }
    for (const code of result.scenario.expect.forbiddenDocuments ?? []) {
      if (result.documents.includes(code)) falsePositives += 1;
    }
  }
  const precision = truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives);
  const documentF1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    serviceAccuracy: rate(
      withService.filter((r) => r.serviceCode === r.scenario.expect.serviceCode).length,
      withService.length,
    ),
    scenarioAccuracy: rate(
      withScenario.filter((r) => r.scenarioCode === r.scenario.expect.scenarioCode).length,
      withScenario.length,
    ),
    documentF1,
    readinessAccuracy: rate(
      withReadiness.filter((r) => r.readiness === r.scenario.expect.readiness).length,
      withReadiness.length,
    ),
    groundingRate: plans.length === 0 ? 1 : plans.filter((r) => r.fullyGrounded).length / plans.length,
    unsupportedClaims: results.reduce((sum, r) => sum + r.unsupportedClaims.length, 0),
    guardrailAccuracy: rate(
      guardrails.filter((r) => r.outcome === r.scenario.expect.outcome).length,
      guardrails.length,
    ),
    avgQuestions:
      plans.length === 0 ? 0 : plans.reduce((sum, r) => sum + r.questionsAsked, 0) / plans.length,
    avgLatencyMs:
      results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length,
  };
}

const TARGETS = {
  serviceAccuracy: 0.9,
  scenarioAccuracy: 0.9,
  documentF1: 0.9,
  readinessAccuracy: 0.9,
  guardrailAccuracy: 0.9,
  groundingRate: 1,
  unsupportedClaims: 0,
} as const;

/* ── Reporting ────────────────────────────────────────────────────────── */

const pct = (v: number | null) => (v === null ? '  n/a' : `${(v * 100).toFixed(1)}%`);

function printReport(results: readonly ScenarioResult[], metrics: Metrics): boolean {
  const caps = describeCapabilities();

  console.log('\n\x1b[1mGovernment Service AI Navigator — evaluation\x1b[0m');
  console.log(
    `  provider=${caps.llm.activeChain.join('→')}  embeddings=${caps.embeddings.provider}` +
      `  grounding=${caps.grounding.strict ? 'strict' : 'lenient'}${cold ? '  (cache bypassed)' : ''}`,
  );

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.log('\n\x1b[1mFailures\x1b[0m');
    for (const result of failed) {
      console.log(`\n  \x1b[31m✖\x1b[0m ${result.scenario.id} — ${result.scenario.description}`);
      console.log(`     "${result.scenario.query.slice(0, 70)}"`);
      for (const failure of result.failures) {
        console.log(`     · ${failure.field}: expected ${failure.expected}, got ${failure.actual}`);
      }
      for (const claim of result.unsupportedClaims) {
        console.log(`     · UNGROUNDED [${claim.kind}] "${claim.text}" — ${claim.reason}`);
      }
    }
  }

  console.log('\n\x1b[1mMetrics\x1b[0m');
  const row = (label: string, value: number | null, target: number, absolute = false) => {
    const ok = value === null ? true : absolute ? value >= target : value >= target;
    const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✖\x1b[0m';
    console.log(
      `  ${mark} ${label.padEnd(28)} ${pct(value).padStart(7)}   target ${pct(target)}${absolute ? '  (absolute)' : ''}`,
    );
    return ok;
  };

  let allOk = true;
  allOk = row('Service identification', metrics.serviceAccuracy, TARGETS.serviceAccuracy) && allOk;
  allOk = row('Scenario identification', metrics.scenarioAccuracy, TARGETS.scenarioAccuracy) && allOk;
  allOk = row('Required-document F1', metrics.documentF1, TARGETS.documentF1) && allOk;
  allOk = row('Readiness classification', metrics.readinessAccuracy, TARGETS.readinessAccuracy) && allOk;
  allOk = row('Guardrail handling', metrics.guardrailAccuracy, TARGETS.guardrailAccuracy) && allOk;
  allOk = row('Source grounding', metrics.groundingRate, TARGETS.groundingRate, true) && allOk;

  const claimsOk = metrics.unsupportedClaims === TARGETS.unsupportedClaims;
  console.log(
    `  ${claimsOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${'Unsupported claims'.padEnd(28)} ` +
      `${String(metrics.unsupportedClaims).padStart(7)}   target 0  (absolute)`,
  );
  allOk = claimsOk && allOk;

  console.log(
    `\n  scenarios ${metrics.passed}/${metrics.total} passed` +
      `  ·  avg ${metrics.avgQuestions.toFixed(1)} questions` +
      `  ·  avg ${Math.round(metrics.avgLatencyMs)}ms`,
  );

  return allOk;
}

function renderHtml(results: readonly ScenarioResult[], metrics: Metrics): string {
  const caps = describeCapabilities();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const metricRow = (label: string, value: number | null, target: number) => {
    const ok = value === null || value >= target;
    return `<tr class="${ok ? 'ok' : 'bad'}"><td>${label}</td><td class="num">${pct(value)}</td><td class="num">${pct(target)}</td><td>${ok ? '✓' : '✖'}</td></tr>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evaluation — Government Service AI Navigator</title>
<style>
  :root { color-scheme: light dark; --ok:#15803d; --bad:#b91c1c; --muted:#64748b; --line:#e2e8f0; }
  @media (prefers-color-scheme: dark) { :root { --line:#2b3c39; --muted:#94a3b8; } body { background:#0c1413; color:#e9f1ef; } td,th { border-color:#2b3c39 } }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem; max-width: 70rem; margin-inline: auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); font-size: .9rem; vertical-align: top; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok td:last-child { color: var(--ok); font-weight: 600; }
  .bad td:last-child { color: var(--bad); font-weight: 600; }
  .pass { color: var(--ok); } .fail { color: var(--bad); }
  .q { color: var(--muted); font-size: .82rem; }
  .fx { color: var(--bad); font-size: .82rem; margin: .15rem 0 0; }
</style></head><body>
<h1>Evaluation report</h1>
<p class="sub">${new Date().toISOString()} · provider ${esc(caps.llm.activeChain.join(' → '))} · embeddings ${esc(caps.embeddings.provider)} · ${metrics.passed}/${metrics.total} scenarios passed</p>

<table>
<thead><tr><th>Metric</th><th class="num">Result</th><th class="num">Target</th><th></th></tr></thead>
<tbody>
${metricRow('Service identification', metrics.serviceAccuracy, TARGETS.serviceAccuracy)}
${metricRow('Scenario identification', metrics.scenarioAccuracy, TARGETS.scenarioAccuracy)}
${metricRow('Required-document F1', metrics.documentF1, TARGETS.documentF1)}
${metricRow('Readiness classification', metrics.readinessAccuracy, TARGETS.readinessAccuracy)}
${metricRow('Guardrail handling', metrics.guardrailAccuracy, TARGETS.guardrailAccuracy)}
${metricRow('Source grounding', metrics.groundingRate, TARGETS.groundingRate)}
<tr class="${metrics.unsupportedClaims === 0 ? 'ok' : 'bad'}"><td>Unsupported claims</td><td class="num">${metrics.unsupportedClaims}</td><td class="num">0</td><td>${metrics.unsupportedClaims === 0 ? '✓' : '✖'}</td></tr>
</tbody></table>

<table>
<thead><tr><th></th><th>Scenario</th><th>Service</th><th>Branch</th><th>Readiness</th><th class="num">Q</th><th class="num">ms</th></tr></thead>
<tbody>
${results
  .map(
    (r) => `<tr>
  <td class="${r.passed ? 'pass' : 'fail'}">${r.passed ? '✓' : '✖'}</td>
  <td><strong>${esc(r.scenario.id)}</strong><br><span class="q">${esc(r.scenario.description)}</span>
  ${r.failures.map((f) => `<p class="fx">${esc(f.field)}: expected ${esc(f.expected)}, got ${esc(f.actual)}</p>`).join('')}</td>
  <td>${esc(r.serviceCode ?? r.outcome)}</td>
  <td>${esc(r.scenarioCode ?? '—')}</td>
  <td>${esc(r.readiness ?? '—')}</td>
  <td class="num">${r.questionsAsked}</td>
  <td class="num">${r.latencyMs}</td>
</tr>`,
  )
  .join('\n')}
</tbody></table>
</body></html>`;
}

/* ── Persistence ──────────────────────────────────────────────────────── */

async function persist(results: readonly ScenarioResult[], metrics: Metrics): Promise<void> {
  const caps = describeCapabilities();
  const runKey = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

  const [run] = await sql<{ id: number }>(
    `INSERT INTO eval_runs
       (run_key, provider, model, embedding_provider, scenario_count, passed_count,
        service_accuracy, scenario_accuracy, requirement_f1, readiness_accuracy,
        grounding_rate, unsupported_claims, avg_latency_ms, avg_questions_asked, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW())
     RETURNING id`,
    [
      runKey,
      caps.llm.activeChain.join('>'),
      caps.llm.configured,
      caps.embeddings.provider,
      metrics.total,
      metrics.passed,
      metrics.serviceAccuracy,
      metrics.scenarioAccuracy,
      metrics.documentF1,
      metrics.readinessAccuracy,
      metrics.groundingRate,
      metrics.unsupportedClaims,
      Math.round(metrics.avgLatencyMs),
      metrics.avgQuestions,
    ],
  );

  const runId = run?.id;
  if (runId === undefined) return;

  for (const result of results) {
    await sql(
      `INSERT INTO eval_results
         (run_id, scenario_id, passed, expected, actual, failures, questions_asked, latency_ms, unsupported_claims)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb)
       ON CONFLICT (run_id, scenario_id) DO NOTHING`,
      [
        runId,
        result.scenario.id,
        result.passed,
        JSON.stringify(result.scenario.expect),
        JSON.stringify({
          outcome: result.outcome,
          serviceCode: result.serviceCode,
          scenarioCode: result.scenarioCode,
          eligibility: result.eligibility,
          readiness: result.readiness,
          documents: result.documents,
          exceptions: result.exceptions,
        }),
        JSON.stringify(result.failures),
        result.questionsAsked,
        result.latencyMs,
        JSON.stringify(result.unsupportedClaims),
      ],
    );
  }
}

/* ── Main ─────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const cfg = getConfig();
  const selected = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

  if (selected.length === 0) {
    console.error(`No scenarios matched --id ${only?.join(',')}`);
    process.exitCode = 1;
    return;
  }

  if (!skipSeed) {
    console.log('▸ seeding evaluation database…');
    await runSeed({ fresh: true });
  }

  if (cold) process.env.LLM_CACHE_ENABLED = 'false';

  console.log(`▸ running ${selected.length} scenario(s) against ${cfg.DB_DRIVER}…\n`);

  const results: ScenarioResult[] = [];
  for (const [index, scenario] of selected.entries()) {
    const result = await runScenario(scenario);
    results.push(result);
    process.stdout.write(
      `  ${result.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✖\x1b[0m'} ` +
        `${String(index + 1).padStart(2)}/${selected.length} ${scenario.id}\n`,
    );
  }

  const metrics = computeMetrics(results);
  const allTargetsMet = printReport(results, metrics);

  const reportDir = path.resolve(process.cwd(), 'eval', 'report');
  if (writeHtml || writeJson) await mkdir(reportDir, { recursive: true });

  if (writeHtml) {
    const file = path.join(reportDir, 'index.html');
    await writeFile(file, renderHtml(results, metrics), 'utf8');
    console.log(`\n  report written to ${path.relative(process.cwd(), file)}`);
  }
  if (writeJson) {
    const file = path.join(reportDir, 'latest.json');
    await writeFile(
      file,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), metrics, results: results.map(toJson) },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`  data written to ${path.relative(process.cwd(), file)}`);
  }

  await persist(results, metrics).catch((err: unknown) => {
    console.warn('  ! could not persist eval run:', err instanceof Error ? err.message : err);
  });

  console.log('');
  process.exitCode = allTargetsMet ? 0 : 1;
}

function toJson(result: ScenarioResult) {
  return {
    id: result.scenario.id,
    description: result.scenario.description,
    query: result.scenario.query,
    language: result.scenario.language,
    passed: result.passed,
    failures: result.failures,
    outcome: result.outcome,
    serviceCode: result.serviceCode,
    scenarioCode: result.scenarioCode,
    eligibility: result.eligibility,
    readiness: result.readiness,
    documents: result.documents,
    exceptions: result.exceptions,
    blockingRules: result.blockingRules,
    unsupportedClaims: result.unsupportedClaims,
    questionsAsked: result.questionsAsked,
    latencyMs: result.latencyMs,
  };
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error('\n✖ evaluation failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
