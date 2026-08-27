'use client';

/**
 * "How this answer was produced."
 *
 * The product has to be able to *show* — not assert — where AI is used and
 * where deterministic logic is used. This panel is that proof, rendered from
 * the live trace of the turn the citizen just completed.
 *
 * The headline number is the share of steps that ran with no model involved.
 * On a normal turn it is high, and the steps that decide facts — scenario
 * selection, eligibility, the checklist, readiness — are all on the
 * deterministic side. That is the architecture claim, checkable in one glance.
 *
 * Traces are sanitised at write time, so nothing here can leak an identifier.
 */
import { useState } from 'react';
import type { Language } from '@/lib/schemas/core';
import { ui } from '@/lib/i18n/ui';
import { Icon } from '@/components/ui/Icon';

export interface TraceStepView {
  turnId: string;
  stepIndex: number;
  agent: string;
  stage: string;
  deterministic: boolean;
  status: string;
  provider: string | null;
  model: string | null;
  input: unknown;
  output: unknown;
  notes: string | null;
  latencyMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
}

export interface TraceSummaryView {
  totalSteps: number;
  deterministicSteps: number;
  modelSteps: number;
  deterministicShare: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
}

interface Props {
  steps: readonly TraceStepView[];
  summary: TraceSummaryView | null;
  language: Language;
  className?: string;
}

const AGENT_LABELS: Record<string, string> = {
  input_guardrail: 'Input guardrail',
  language: 'Language detection',
  intent: 'Intent extraction',
  service_resolver: 'Service resolver',
  interview_planner: 'Interview planner',
  question_phrasing: 'Question phrasing',
  retrieval: 'Official-source retrieval',
  rules_engine: 'Rules engine',
  plan_composer: 'Plan composer',
  output_verifier: 'Output verifier',
  readiness: 'Readiness engine',
  document_check: 'Document check',
};

const STATUS_CHIP: Record<string, string> = {
  ok: 'bg-verified-soft text-verified-ink',
  cache_hit: 'bg-info-soft text-info-ink',
  degraded: 'bg-unverified-soft text-unverified-ink',
  blocked: 'bg-danger-soft text-danger-ink',
  error: 'bg-danger-soft text-danger-ink',
};

export function TracePanel({ steps, summary, language, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  if (steps.length === 0) return null;

  const share = summary ? Math.round(summary.deterministicShare * 100) : null;

  return (
    <section className={`card overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-start transition-colors hover:bg-surface-sunken"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Icon name="cpu" size={18} className="text-ink-subtle" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{ui('howProduced', language)}</span>
            <span className="block truncate text-xs text-ink-subtle">
              {summary
                ? `${summary.totalSteps} steps · ${share}% fixed logic · ${summary.totalLatencyMs}ms`
                : `${steps.length} steps`}
            </span>
          </span>
        </span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} className="text-ink-subtle" />
      </button>

      {open ? (
        <div className="border-t border-border p-4 animate-fade-up">
          <p className="max-w-reading text-sm text-ink-muted">{ui('traceHelp', language)}</p>

          {summary ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Fixed logic" value={`${summary.deterministicSteps}`} tone="verified" />
              <Stat label="AI steps" value={`${summary.modelSteps}`} tone="info" />
              <Stat label="Latency" value={`${summary.totalLatencyMs}ms`} tone="neutral" />
              <Stat
                label="Tokens"
                value={`${summary.totalPromptTokens + summary.totalOutputTokens}`}
                tone="neutral"
              />
            </div>
          ) : null}

          <ol className="mt-4 space-y-2">
            {steps.map((step) => {
              const key = `${step.turnId}-${step.stepIndex}`;
              const isOpen = expandedStep === step.stepIndex;
              return (
                <li key={key} className="rounded-field border border-border bg-surface-sunken">
                  <button
                    type="button"
                    onClick={() => setExpandedStep(isOpen ? null : step.stepIndex)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-3 p-3 text-start"
                  >
                    <span
                      className={`badge shrink-0 ${
                        step.deterministic
                          ? 'bg-verified-soft text-verified-ink'
                          : 'bg-info-soft text-info-ink'
                      }`}
                    >
                      <Icon name={step.deterministic ? 'cpu' : 'sparkle'} size={12} />
                      {step.deterministic ? ui('deterministic', language) : ui('aiAssisted', language)}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">
                        {AGENT_LABELS[step.agent] ?? step.agent}
                      </span>
                      {step.notes ? (
                        <span className="mt-0.5 block text-xs text-ink-muted">{step.notes}</span>
                      ) : null}
                    </span>

                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`badge ${STATUS_CHIP[step.status] ?? 'bg-surface text-ink-subtle'}`}>
                        {step.status}
                      </span>
                      <span className="text-xs tabular-nums text-ink-subtle">{step.latencyMs}ms</span>
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="border-t border-border px-3 py-3 text-xs animate-fade-up">
                      {step.model ? (
                        <p className="mb-2 text-ink-muted">
                          <span className="font-medium text-ink">Model:</span> {step.provider}/{step.model}
                        </p>
                      ) : (
                        <p className="mb-2 text-ink-muted">No model was consulted for this step.</p>
                      )}
                      <TraceJson label="Input" value={step.input} />
                      <TraceJson label="Output" value={step.output} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'verified' | 'info' | 'neutral' }) {
  const toneClass =
    tone === 'verified'
      ? 'text-verified-ink bg-verified-soft'
      : tone === 'info'
        ? 'text-info-ink bg-info-soft'
        : 'text-ink bg-surface-sunken';
  return (
    <div className={`rounded-field p-3 ${toneClass}`}>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs opacity-80">{label}</p>
    </div>
  );
}

function TraceJson({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value, null, 2);
  if (!text || text === '{}') return null;

  return (
    <div className="mb-2">
      <p className="mb-1 font-medium text-ink">{label}</p>
      {/* Wide JSON scrolls inside its own box; the page never scrolls sideways. */}
      <pre className="max-h-56 overflow-auto rounded bg-surface p-2 font-mono text-[11px] leading-relaxed text-ink-muted">
        {text}
      </pre>
    </div>
  );
}
