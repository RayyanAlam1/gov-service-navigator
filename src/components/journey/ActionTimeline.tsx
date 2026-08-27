'use client';

/**
 * The action timeline.
 *
 * The product spec is explicit that the procedure is presented as a visual
 * workflow rather than a long chatbot response, and the reason is practical:
 * a citizen standing in a queue needs to find "which step am I on" in two
 * seconds, and prose does not support that.
 *
 * Each step carries its channel (online / in person) and its source. Where an
 * official online route exists it is a real link, because the alternative —
 * implying this app can submit a government application — is a claim the
 * output verifier treats as a hard violation for good reason.
 */
import { pickLocalized, type Language, type ServiceChannel } from '@/lib/schemas/core';
import type { PlanStep } from '@/lib/schemas/domain';
import { ui } from '@/lib/i18n/ui';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SourceBadge } from '@/components/ui/SourceBadge';

interface Props {
  steps: readonly PlanStep[];
  language: Language;
  text?: Record<string, string>;
  className?: string;
}

const CHANNEL: Record<ServiceChannel, { icon: IconName; label: Record<Language, string> }> = {
  online: {
    icon: 'external',
    label: { en: 'Online', ur: 'آن لائن', roman_ur: 'Online' },
  },
  in_person: {
    icon: 'location',
    label: { en: 'In person', ur: 'ذاتی طور پر', roman_ur: 'Zaati tor par' },
  },
  either: {
    icon: 'refresh',
    label: { en: 'Online or in person', ur: 'آن لائن یا ذاتی طور پر', roman_ur: 'Online ya zaati tor par' },
  },
  postal: {
    icon: 'document',
    label: { en: 'By post', ur: 'ڈاک کے ذریعے', roman_ur: 'Dak ke zariye' },
  },
};

export function ActionTimeline({ steps, language, text = {}, className = '' }: Props) {
  if (steps.length === 0) {
    return (
      <section className={className}>
        <h2 className="text-lg font-semibold text-ink">{ui('steps', language)}</h2>
        <p className="mt-3 rounded-card border border-dashed border-border p-6 text-center text-sm text-ink-subtle">
          No steps have been determined yet.
        </p>
      </section>
    );
  }

  return (
    <section className={className} aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="text-lg font-semibold text-ink">
        {ui('steps', language)}
      </h2>

      <ol className="mt-4 space-y-0">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const channel = CHANNEL[step.channel];
          const title = text[`step.${step.code}.title`] ?? pickLocalized(step.title, language);
          const instruction =
            text[`step.${step.code}.instruction`] ?? pickLocalized(step.instruction, language);

          return (
            <li key={step.code} className="flex gap-3 sm:gap-4">
              {/* Rail */}
              <div className="flex flex-col items-center">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
                  {step.order}
                </span>
                {!last ? <span aria-hidden className="w-px flex-1 bg-border" /> : null}
              </div>

              <div className={`min-w-0 flex-1 ${last ? 'pb-0' : 'pb-6'}`}>
                <div className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-base font-semibold text-ink">{title}</h3>
                    <span className="badge bg-surface-sunken text-ink-muted">
                      <Icon name={channel.icon} size={12} />
                      {channel.label[language]}
                    </span>
                  </div>

                  <p className="mt-2 max-w-reading text-sm text-ink-muted">{instruction}</p>

                  {step.estimatedDuration ? (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-subtle">
                      <Icon name="clock" size={12} />
                      {step.estimatedDuration}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {step.actionUrl ? (
                      <a
                        href={step.actionUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="btn-primary min-h-[2.25rem] px-3 py-1.5 text-xs"
                      >
                        {ui('officialRoute', language)}
                        <Icon name="external" size={13} />
                      </a>
                    ) : null}
                    <SourceBadge
                      source={step.source}
                      status={step.verificationStatus}
                      language={language}
                    />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
