'use client';

/**
 * The ten-stage journey.
 *
 * Straight from the product spec, and shown for a reason beyond decoration: a
 * citizen who has just described a distressing situation ("my ID is gone")
 * needs to see that there is a bounded process with an end, not an open-ended
 * chat that might go anywhere. Making the shape of the process visible is
 * itself the reassurance.
 *
 * Renders as a compact horizontal rail on small screens and a labelled vertical
 * list from `md` up. State is conveyed by icon and text, never by colour alone.
 */
import { JOURNEY_STAGES, type JourneyStage, type Language } from '@/lib/schemas/core';
import { Icon } from '@/components/ui/Icon';

export type StageState = 'done' | 'active' | 'upcoming' | 'skipped';

interface Props {
  current: JourneyStage;
  /** Stages already completed. Order is not assumed. */
  completed?: readonly JourneyStage[];
  language: Language;
  className?: string;
}

const STAGE_LABELS: Record<JourneyStage, Record<Language, string>> = {
  user_goal: { en: 'Your goal', ur: 'آپ کا مقصد', roman_ur: 'Aap ka maqsad' },
  language_intent: { en: 'Language & intent', ur: 'زبان اور مقصد', roman_ur: 'Zaban aur maqsad' },
  situation_interview: { en: 'Your situation', ur: 'آپ کی صورتحال', roman_ur: 'Aap ki situation' },
  service_resolution: { en: 'Service match', ur: 'سروس کی شناخت', roman_ur: 'Service ki shanakht' },
  official_retrieval: { en: 'Official sources', ur: 'سرکاری ذرائع', roman_ur: 'Sarkari zaraye' },
  eligibility_requirements: { en: 'Eligibility & documents', ur: 'اہلیت و دستاویزات', roman_ur: 'Ehliyat aur documents' },
  personalized_plan: { en: 'Your action plan', ur: 'آپ کا لائحہ عمل', roman_ur: 'Aap ka action plan' },
  readiness_check: { en: 'Am I ready?', ur: 'کیا میں تیار ہوں؟', roman_ur: 'Kya main tayyar hoon?' },
  office_application: { en: 'Where to go', ur: 'کہاں جانا ہے', roman_ur: 'Kahan jana hai' },
  follow_up: { en: 'Follow-up', ur: 'بعد کی کارروائی', roman_ur: 'Baad ki karrawai' },
};

const STATE_LABEL: Record<StageState, Record<Language, string>> = {
  done: { en: 'completed', ur: 'مکمل', roman_ur: 'mukammal' },
  active: { en: 'in progress', ur: 'جاری', roman_ur: 'jari' },
  upcoming: { en: 'not started', ur: 'ابھی نہیں', roman_ur: 'abhi nahi' },
  skipped: { en: 'skipped', ur: 'چھوڑ دیا', roman_ur: 'chhora diya' },
};

export function JourneyStepper({ current, completed = [], language, className = '' }: Props) {
  const currentOrder = JOURNEY_STAGES.find((s) => s.id === current)?.order ?? 1;
  const completedSet = new Set(completed);

  const stateOf = (stage: JourneyStage, order: number): StageState => {
    if (stage === current) return 'active';
    if (completedSet.has(stage) || order < currentOrder) return 'done';
    return 'upcoming';
  };

  return (
    <nav className={className} aria-label="Progress through your application">
      <ol className="flex gap-1 overflow-x-auto pb-2 md:flex-col md:gap-0 md:overflow-visible md:pb-0">
        {JOURNEY_STAGES.map((stage, index) => {
          const state = stateOf(stage.id, stage.order);
          const label = STAGE_LABELS[stage.id][language];
          const last = index === JOURNEY_STAGES.length - 1;

          return (
            <li
              key={stage.id}
              className="flex shrink-0 items-center gap-2 md:shrink md:items-start md:gap-3"
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <div className="flex flex-col items-center self-stretch">
                <span
                  className={[
                    'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                    state === 'done'
                      ? 'bg-verified text-white'
                      : state === 'active'
                        ? 'bg-accent text-white ring-4 ring-accent/20'
                        : 'bg-surface-sunken text-ink-subtle ring-1 ring-border',
                  ].join(' ')}
                >
                  {state === 'done' ? <Icon name="check" size={14} /> : stage.order}
                </span>
                {/* Connector, vertical layout only. */}
                {!last ? (
                  <span
                    aria-hidden
                    className={[
                      'hidden w-px flex-1 md:block',
                      state === 'done' ? 'bg-verified/40' : 'bg-border',
                    ].join(' ')}
                    style={{ minHeight: '1.25rem' }}
                  />
                ) : null}
              </div>

              <div className="min-w-0 md:pb-4">
                <p
                  className={[
                    'whitespace-nowrap text-xs font-medium md:whitespace-normal md:text-sm',
                    state === 'active' ? 'text-ink' : state === 'done' ? 'text-ink-muted' : 'text-ink-subtle',
                  ].join(' ')}
                >
                  {label}
                </p>
                {/* The state is available to assistive tech as words, not just colour. */}
                <span className="sr-only">{STATE_LABEL[state][language]}</span>
                {state === 'active' ? (
                  <p className="hidden text-xs text-ink-subtle md:block">{stage.blurb}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
