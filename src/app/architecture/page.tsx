/**
 * /architecture — the demo's "show me how it works" page.
 *
 * Rendered on the server from live data, not from a static diagram. Every
 * number on this page is a query against the running system: how many facts
 * exist, how many are verified, how many chunks are indexed, which provider
 * will serve the next request.
 *
 * That is the point. The project's central claim — "AI never supplies a
 * government fact" — is the kind of thing anyone can put on a slide. This page
 * exists so it can be checked instead of believed.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { describeCapabilities, getConfig } from '@/lib/config/env';
import { provenanceSummary } from '@/lib/db/knowledge';
import { sql } from '@/lib/db/client';
import { Icon } from '@/components/ui/Icon';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Architecture',
  description: 'How the Government Service AI Navigator produces an answer, and where AI is used.',
};

interface Counts {
  services: number;
  scenarios: number;
  requirements: number;
  rules: number;
  steps: number;
  exceptions: number;
  offices: number;
  sources: number;
  documents: number;
  chunks: number;
  embedded: number;
}

interface EvalRow {
  run_key: string;
  scenario_count: number;
  passed_count: number;
  service_accuracy: number | null;
  scenario_accuracy: number | null;
  requirement_f1: number | null;
  readiness_accuracy: number | null;
  grounding_rate: number | null;
  unsupported_claims: number;
  avg_questions_asked: number | null;
  finished_at: string | null;
}

async function loadCounts(): Promise<Counts | null> {
  try {
    const [row] = await sql<Counts>(`
      SELECT
        (SELECT count(*) FROM services WHERE is_active)::int AS services,
        (SELECT count(*) FROM service_scenarios)::int        AS scenarios,
        (SELECT count(*) FROM requirements)::int             AS requirements,
        (SELECT count(*) FROM eligibility_rules)::int        AS rules,
        (SELECT count(*) FROM procedure_steps)::int          AS steps,
        (SELECT count(*) FROM exception_routes)::int         AS exceptions,
        (SELECT count(*) FROM offices)::int                  AS offices,
        (SELECT count(*) FROM sources)::int                  AS sources,
        (SELECT count(*) FROM documents)::int                AS documents,
        (SELECT count(*) FROM document_chunks)::int          AS chunks,
        (SELECT count(embedding) FROM document_chunks)::int  AS embedded
    `);
    return row ?? null;
  } catch {
    return null;
  }
}

async function loadLatestEval(): Promise<EvalRow | null> {
  try {
    const [row] = await sql<EvalRow>(
      `SELECT run_key, scenario_count, passed_count, service_accuracy, scenario_accuracy,
              requirement_f1, readiness_accuracy, grounding_rate, unsupported_claims,
              avg_questions_asked, finished_at
         FROM eval_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return row ?? null;
  } catch {
    return null;
  }
}

const LAYERS = [
  {
    id: 'deterministic',
    tone: 'verified' as const,
    icon: 'cpu' as const,
    title: 'Deterministic layer — PostgreSQL',
    role: 'Decides every fact',
    detail:
      'Services, scenarios, eligibility rules, required documents, procedure steps, fees and offices are rows. Conditions are stored as JSON expression trees and evaluated by code with three-valued logic, so "we do not know yet" is a distinct outcome from "no". Nothing here is summarised by a model.',
    owns: ['Which service', 'Which branch', 'Eligible or not', 'Which documents', 'Ready or not'],
  },
  {
    id: 'retrieval',
    tone: 'info' as const,
    icon: 'search' as const,
    title: 'Grounded retrieval — pgvector',
    role: 'Finds supporting text',
    detail:
      'Official prose is chunked, embedded and retrieved by hybrid search: Postgres full-text plus vector cosine, fused with reciprocal rank fusion. Every chunk carries its source title and last-verified date. Retrieval finds text; it does not decide truth, and "nothing documented" is a valid result that routes the citizen to the office.',
    owns: ['Supporting evidence', 'Source citations', 'Coverage assessment'],
  },
  {
    id: 'language',
    tone: 'synthetic' as const,
    icon: 'sparkle' as const,
    title: 'Language layer — LLM',
    role: 'Only phrases and translates',
    detail:
      'Four jobs: detect intent, translate, route context, and render already-decided content. It is never asked what documents a service needs — it is handed the list and asked to express it in Urdu. Every call has a required deterministic fallback, enforced by the type signature of the client.',
    owns: ['Intent extraction', 'Question phrasing', 'Translation', 'Query expansion'],
  },
] as const;

/**
 * Static class lookups.
 *
 * Tailwind generates utilities by scanning source text for complete class
 * names, so an interpolated `bg-${tone}-soft` produces no CSS at all and the
 * element renders unstyled. Every conditional class in this file is therefore
 * a full literal in a lookup table.
 */
const TONE_CLASSES = {
  verified: { chip: 'bg-verified-soft text-verified-ink', role: 'text-verified-ink' },
  info: { chip: 'bg-info-soft text-info-ink', role: 'text-info-ink' },
  synthetic: { chip: 'bg-synthetic-soft text-synthetic-ink', role: 'text-synthetic-ink' },
} as const;

const STATUS_CLASSES = {
  verified: 'bg-verified-soft text-verified-ink',
  unverified: 'bg-unverified-soft text-unverified-ink',
  synthetic: 'bg-synthetic-soft text-synthetic-ink',
} as const;

export default async function ArchitecturePage() {
  const cfg = getConfig();
  const caps = describeCapabilities();
  const [counts, provenance, latestEval] = await Promise.all([
    loadCounts(),
    provenanceSummary().catch(() => []),
    loadLatestEval(),
  ]);

  const byStatus = new Map<string, number>();
  for (const row of provenance) {
    byStatus.set(row.verificationStatus, (byStatus.get(row.verificationStatus) ?? 0) + row.count);
  }
  const totalFacts = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const orphans = provenance.reduce((sum, r) => sum + r.withoutSource, 0);

  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="btn-ghost px-2.5">
            <Icon name="arrow-left" size={16} />
            Back to the navigator
          </Link>
          <span className="text-xs text-ink-subtle">Live data · {cfg.APP_ENV}</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold text-ink">How this system produces an answer</h1>
        <p className="mt-3 max-w-reading text-base text-ink-muted">
          Three layers with a strict division of labour. The test for whether the line is drawn
          correctly: <strong className="text-ink">if the LLM provider went down and you swapped in a
          template renderer, would the answers still be factually correct?</strong> They would — you
          would lose fluency and translation, not truth.
        </p>

        {/* ── Layers ─────────────────────────────────────────────────── */}
        <section className="mt-10 space-y-4" aria-labelledby="layers-heading">
          <h2 id="layers-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            The three layers
          </h2>

          {LAYERS.map((layer, index) => (
            <article key={layer.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONE_CLASSES[layer.tone].chip}`}
                  >
                    <Icon name={layer.icon} size={18} />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-ink">
                      {index + 1}. {layer.title}
                    </h3>
                    <p className={`mt-0.5 text-sm font-medium ${TONE_CLASSES[layer.tone].role}`}>
                      {layer.role}
                    </p>
                  </div>
                </div>
              </div>

              <p className="mt-3 max-w-reading text-sm text-ink-muted">{layer.detail}</p>

              <ul className="mt-3 flex flex-wrap gap-1.5">
                {layer.owns.map((item) => (
                  <li key={item} className={`badge ${TONE_CLASSES[layer.tone].chip}`}>
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        {/* ── Knowledge base ─────────────────────────────────────────── */}
        <section className="mt-10" aria-labelledby="kb-heading">
          <h2 id="kb-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            What is actually in the database, right now
          </h2>

          {counts ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Services', counts.services],
                ['Scenarios', counts.scenarios],
                ['Requirements', counts.requirements],
                ['Eligibility rules', counts.rules],
                ['Procedure steps', counts.steps],
                ['Exception routes', counts.exceptions],
                ['Offices', counts.offices],
                ['Sources', counts.sources],
              ].map(([label, value]) => (
                <div key={String(label)} className="card p-4">
                  <p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
                  <p className="mt-0.5 text-xs text-ink-subtle">{label}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 card p-5 text-sm text-ink-subtle">
              The database is not reachable. Run <code className="font-mono">npm run doctor</code>.
            </p>
          )}

          {counts ? (
            <p className="mt-3 text-sm text-ink-muted">
              Retrieval corpus: <strong className="text-ink">{counts.documents}</strong> documents,{' '}
              <strong className="text-ink">{counts.chunks}</strong> chunks,{' '}
              <strong className="text-ink">{counts.embedded}</strong> embedded with{' '}
              <span className="font-mono text-xs">{caps.embeddings.model}</span> at{' '}
              {caps.embeddings.dim} dimensions.
            </p>
          ) : null}
        </section>

        {/* ── Provenance ─────────────────────────────────────────────── */}
        <section className="mt-10" aria-labelledby="prov-heading">
          <h2 id="prov-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            Provenance
          </h2>
          <p className="mt-2 max-w-reading text-sm text-ink-muted">
            Every citizen-facing fact carries a verification tier and a source. The seeded knowledge
            base is deliberately <strong className="text-ink">unverified</strong>: it is structurally
            complete and attributed to real official pages, but no one has yet confirmed each value
            against the live page. Fees are stored as <code className="font-mono">NULL</code> rather
            than as a plausible guess.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {(['verified', 'unverified', 'synthetic'] as const).map((status) => {
              const count = byStatus.get(status) ?? 0;
              const share = totalFacts === 0 ? 0 : Math.round((count / totalFacts) * 100);
              return (
                <div key={status} className={`rounded-field px-4 py-3 ${STATUS_CLASSES[status]}`}>
                  <p className="text-xl font-semibold tabular-nums">{count}</p>
                  <p className="text-xs capitalize opacity-85">
                    {status} · {share}%
                  </p>
                </div>
              );
            })}
          </div>

          <p
            className={`mt-3 inline-flex items-center gap-2 rounded-field px-3 py-2 text-sm ${
              orphans === 0 ? 'bg-verified-soft text-verified-ink' : 'bg-danger-soft text-danger-ink'
            }`}
          >
            <Icon name={orphans === 0 ? 'shield' : 'alert'} size={14} />
            {orphans === 0
              ? 'Every requirement, step, rule and fee has a source. Zero orphaned facts.'
              : `${orphans} citizen-facing fact(s) have no source. These must never render.`}
          </p>
        </section>

        {/* ── Capabilities ───────────────────────────────────────────── */}
        <section className="mt-10" aria-labelledby="caps-heading">
          <h2 id="caps-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            Runtime capabilities
          </h2>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="card p-4">
              <p className="text-sm font-medium text-ink">Language model</p>
              <p className="mt-1 font-mono text-xs text-ink-muted">
                {caps.llm.activeChain.join(' → ')}
              </p>
              {caps.llm.live ? (
                <p className="mt-2 text-sm text-verified-ink">
                  Live. Keys: dashscope {caps.llm.keys.dashscope}, groq {caps.llm.keys.groq}.
                </p>
              ) : (
                <p className="mt-2 text-sm text-unverified-ink">{caps.llm.reason}</p>
              )}
            </div>

            <div className="card p-4">
              <p className="text-sm font-medium text-ink">Embeddings</p>
              <p className="mt-1 font-mono text-xs text-ink-muted">
                {caps.embeddings.provider} / {caps.embeddings.model} @ {caps.embeddings.dim}d
              </p>
              <p
                className={`mt-2 text-sm ${caps.embeddings.degraded ? 'text-unverified-ink' : 'text-verified-ink'}`}
              >
                {caps.embeddings.degraded ? caps.embeddings.reason : 'Multilingual semantic retrieval active.'}
              </p>
            </div>

            <div className="card p-4">
              <p className="text-sm font-medium text-ink">Grounding</p>
              <p className="mt-2 text-sm text-ink-muted">
                Strict mode {caps.grounding.strict ? 'on' : 'off'}. Sources go stale after{' '}
                {caps.grounding.staleAfterDays} days. Evidence floor{' '}
                {caps.grounding.minSimilarity.toFixed(2)} cosine.
              </p>
            </div>

            <div className="card p-4">
              <p className="text-sm font-medium text-ink">Database</p>
              <p className="mt-2 text-sm text-ink-muted">
                {caps.database.driver}
                {caps.database.embedded
                  ? ' — embedded PostgreSQL, no external service required.'
                  : ' — PostgreSQL with pgvector.'}
              </p>
            </div>
          </div>
        </section>

        {/* ── Evaluation ─────────────────────────────────────────────── */}
        <section className="mt-10" aria-labelledby="eval-heading">
          <h2 id="eval-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
            Latest evaluation
          </h2>

          {latestEval ? (
            <>
              <p className="mt-2 text-sm text-ink-muted">
                {latestEval.passed_count}/{latestEval.scenario_count} scenarios passed
                {latestEval.finished_at
                  ? ` · ${new Date(latestEval.finished_at).toLocaleString('en-GB')}`
                  : ''}
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-subtle">
                      <th className="pb-2 pe-3 font-medium">Metric</th>
                      <th className="pb-2 pe-3 text-right font-medium">Result</th>
                      <th className="pb-2 text-right font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[
                      ['Service identification', pct(latestEval.service_accuracy), '90%'],
                      ['Scenario identification', pct(latestEval.scenario_accuracy), '90%'],
                      ['Required-document F1', pct(latestEval.requirement_f1), '90%'],
                      ['Readiness classification', pct(latestEval.readiness_accuracy), '90%'],
                      ['Source link integrity', pct(latestEval.grounding_rate), '100%'],
                      ['Unsupported claims', String(latestEval.unsupported_claims), '0'],
                      [
                        'Average questions asked',
                        latestEval.avg_questions_asked?.toFixed(1) ?? '—',
                        'as few as possible',
                      ],
                    ].map(([label, result, target]) => (
                      <tr key={label}>
                        <td className="py-2 pe-3 text-ink">{label}</td>
                        <td className="py-2 pe-3 text-right font-medium tabular-nums text-ink">{result}</td>
                        <td className="py-2 text-right tabular-nums text-ink-subtle">{target}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="mt-3 card p-5 text-sm text-ink-subtle">
              No evaluation run recorded yet. Run <code className="font-mono">npm run eval</code>.
            </p>
          )}
        </section>

        <footer className="mt-12 border-t border-border pt-6">
          <p className="max-w-reading text-xs leading-relaxed text-ink-subtle">
            Every figure on this page is queried from the running system at request time. Nothing
            here is a static claim. See <code className="font-mono">docs/ARCHITECTURE.md</code> and{' '}
            <code className="font-mono">docs/DATA_PROVENANCE.md</code>.
          </p>
        </footer>
      </main>
    </div>
  );
}
