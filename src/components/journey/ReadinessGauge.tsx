'use client';

/**
 * "Am I Ready?"
 *
 * The single most consequential number in the product: a citizen reads this and
 * decides whether to travel to an office. So the design is built around not
 * being misread.
 *
 *   * Four states, not a percentage alone. "78%" invites "close enough";
 *     "Not ready yet — 2 documents missing" does not.
 *   * `undetermined` is a first-class state with its own treatment, because
 *     "we don't know" must never look like a soft version of "ready".
 *   * The next action is the largest text after the verdict. What to do next is
 *     more useful than a score.
 *
 * The ring is decorative and marked as such; every value it encodes is also
 * present as text.
 */
import type { Language, ReadinessState } from '@/lib/schemas/core';
import type { ReadinessReport } from '@/lib/schemas/domain';
import { ui } from '@/lib/i18n/ui';
import { Icon, type IconName } from '@/components/ui/Icon';

interface Props {
  readiness: ReadinessReport;
  language: Language;
  /** Overrides `readiness.summary` when the composer produced a translation. */
  summaryText?: string;
  nextActionText?: string;
  className?: string;
}

interface Look {
  icon: IconName;
  ring: string;
  chip: string;
  labelKey: 'ready' | 'nearlyReady' | 'notReady' | 'undetermined';
}

const LOOKS: Record<ReadinessState, Look> = {
  ready: {
    icon: 'check',
    ring: 'text-verified',
    chip: 'bg-verified-soft text-verified-ink ring-1 ring-verified/25',
    labelKey: 'ready',
  },
  nearly_ready: {
    icon: 'clock',
    ring: 'text-unverified',
    chip: 'bg-unverified-soft text-unverified-ink ring-1 ring-unverified/30',
    labelKey: 'nearlyReady',
  },
  not_ready: {
    icon: 'alert',
    ring: 'text-danger',
    chip: 'bg-danger-soft text-danger-ink ring-1 ring-danger/30',
    labelKey: 'notReady',
  },
  undetermined: {
    icon: 'question',
    ring: 'text-info',
    chip: 'bg-info-soft text-info-ink ring-1 ring-info/30',
    labelKey: 'undetermined',
  },
};

export function ReadinessGauge({
  readiness,
  language,
  summaryText,
  nextActionText,
  className = '',
}: Props) {
  const look = LOOKS[readiness.state];
  const percent = Math.round(readiness.completion * 100);

  // An undetermined verdict shows no progress arc: drawing 80% next to "we
  // don't know" reads as "nearly ready", which is exactly the wrong inference.
  const showArc = readiness.state !== 'undetermined';
  const circumference = 2 * Math.PI * 42;
  const dash = showArc ? (percent / 100) * circumference : 0;

  const outstanding = readiness.missing.length + readiness.unknown.length;

  return (
    <section
      className={`card p-5 ${className}`}
      aria-labelledby="readiness-heading"
      // Recomputed live as the citizen ticks boxes, so announce changes.
      aria-live="polite"
    >
      <h2 id="readiness-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">
        {ui('amIReady', language)}
      </h2>

      <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="relative h-28 w-28 shrink-0">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden focusable="false">
            <circle cx="50" cy="50" r="42" fill="none" strokeWidth="8" className="stroke-surface-sunken" />
            {showArc ? (
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference}`}
                className={`${look.ring} transition-[stroke-dasharray] duration-500`}
                stroke="currentColor"
              />
            ) : null}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <Icon name={look.icon} size={22} className={look.ring} />
            {showArc ? (
              <span className="mt-0.5 text-lg font-semibold tabular-nums">{percent}%</span>
            ) : (
              <span className="mt-0.5 text-lg font-semibold">—</span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 text-center sm:text-start">
          <span className={`badge ${look.chip}`}>
            <Icon name={look.icon} size={13} />
            {ui(look.labelKey, language)}
          </span>

          <p className="mt-2.5 text-base text-ink">
            {summaryText ?? readiness.summary.en}
          </p>

          {outstanding > 0 ? (
            <p className="mt-1 text-sm text-ink-muted">
              {readiness.missing.length > 0 ? (
                <span>
                  {readiness.missing.length} {ui('stillNeeded', language).toLowerCase()}
                </span>
              ) : null}
              {readiness.missing.length > 0 && readiness.unknown.length > 0 ? ' · ' : null}
              {readiness.unknown.length > 0 ? (
                <span>{readiness.unknown.length} unconfirmed</span>
              ) : null}
            </p>
          ) : null}

          <div className="mt-4 rounded-field bg-accent-soft p-3 text-start">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-ink">
              {ui('nextAction', language)}
            </p>
            <p className="mt-1 text-base font-medium text-accent-ink">
              {nextActionText ?? readiness.nextAction}
            </p>
          </div>
        </div>
      </div>

      {readiness.blockingRules.length > 0 ? (
        <div className="mt-4 space-y-2">
          {readiness.blockingRules.map((rule) => (
            <div
              key={rule.code}
              className="rounded-field bg-danger-soft p-3 text-sm text-danger-ink ring-1 ring-danger/25"
            >
              <p className="flex items-start gap-2 font-medium">
                <Icon name="alert" size={15} className="mt-0.5" />
                {rule.failureMessage ?? rule.statement.en}
              </p>
              {rule.remedy ? <p className="ms-6 mt-1 opacity-90">{rule.remedy}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
