'use client';

/**
 * The personalized document checklist.
 *
 * Two things distinguish this from a generic requirements list, and both are
 * the point of the product:
 *
 *   1. Every item says WHY it is on this citizen's list ("Required because your
 *      current address differs from your CNIC address"). A list without reasons
 *      is a list people argue with at the counter.
 *   2. Every item carries its source. A requirement with no provenance is not
 *      renderable — it shows the loudest badge state, not a quiet one.
 *
 * Ticking a box is a server round-trip, because possession feeds the rules
 * engine and can legitimately change the rest of the list — a substitute
 * document can remove another item entirely.
 */
import { useState } from 'react';
import { pickLocalized, type Language } from '@/lib/schemas/core';
import type { ChecklistItem } from '@/lib/schemas/domain';
import { ui } from '@/lib/i18n/ui';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SourceBadge } from '@/components/ui/SourceBadge';

interface Props {
  items: readonly ChecklistItem[];
  language: Language;
  /** Translated titles keyed `checklist.<code>.title`, from the composer. */
  text?: Record<string, string>;
  onToggle: (requirementCode: string, held: boolean) => void;
  onCheckDocument?: (requirementCode: string) => void;
  busy?: boolean;
  className?: string;
}

const STATUS_LOOK: Record<
  ChecklistItem['status'],
  { icon: IconName; chip: string; label: Record<Language, string> }
> = {
  have: {
    icon: 'check',
    chip: 'bg-verified-soft text-verified-ink',
    label: { en: 'You have this', ur: 'یہ آپ کے پاس ہے', roman_ur: 'Yeh aap ke paas hai' },
  },
  substituted: {
    icon: 'check',
    chip: 'bg-verified-soft text-verified-ink',
    label: { en: 'Covered by an alternative', ur: 'متبادل سے پورا', roman_ur: 'Mutabadil se poora' },
  },
  missing: {
    icon: 'alert',
    chip: 'bg-danger-soft text-danger-ink',
    label: { en: 'Still needed', ur: 'ابھی درکار', roman_ur: 'Abhi darkar' },
  },
  unknown: {
    icon: 'question',
    chip: 'bg-info-soft text-info-ink',
    label: { en: 'Not confirmed', ur: 'تصدیق نہیں ہوئی', roman_ur: 'Tasdeeq nahi hui' },
  },
  not_applicable: {
    icon: 'cross',
    chip: 'bg-surface-sunken text-ink-subtle',
    label: { en: 'Not needed for you', ur: 'آپ کے لیے ضروری نہیں', roman_ur: 'Aap ke liye zaroori nahi' },
  },
};

export function Checklist({
  items,
  language,
  text = {},
  onToggle,
  onCheckDocument,
  busy = false,
  className = '',
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const mandatory = items.filter((i) => i.isMandatory);
  const optional = items.filter((i) => !i.isMandatory);

  const renderItem = (item: ChecklistItem) => {
    const look = STATUS_LOOK[item.status];
    const title = text[`checklist.${item.requirementCode}.title`] ?? pickLocalized(item.title, language);
    const held = item.status === 'have' || item.status === 'substituted';
    const isOpen = expanded === item.requirementCode;

    return (
      <li key={item.requirementCode} className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <label className="flex min-h-touch min-w-touch cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={held}
              disabled={busy}
              onChange={(e) => onToggle(item.requirementCode, e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded border-border-strong text-accent focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            />
            <span className="sr-only">
              {ui('iHaveThis', language)}: {title}
            </span>
          </label>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className={`text-base font-medium ${held ? 'text-ink-muted line-through decoration-1' : 'text-ink'}`}>
                {title}
              </p>
              {!item.isMandatory ? (
                <span className="badge bg-surface-sunken text-ink-subtle">{ui('optional', language)}</span>
              ) : null}
            </div>

            <span className={`badge mt-1.5 ${look.chip}`}>
              <Icon name={look.icon} size={12} />
              {look.label[language]}
            </span>

            {/* The reason this item is on THIS citizen's list. */}
            <p className="mt-2 text-sm text-ink-muted">
              {text[`checklist.${item.requirementCode}.reason`] ?? item.reason}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
              {item.mustBeOriginal ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="document" size={12} />
                  {ui('originalRequired', language)}
                </span>
              ) : null}
              {item.copiesRequired !== null ? (
                <span>
                  {item.copiesRequired}{' '}
                  {item.copiesRequired === 1 && language === 'en'
                    ? 'copy'
                    : ui('copies', language)}
                </span>
              ) : null}
              {item.satisfiedBy ? <span>via {item.satisfiedBy}</span> : null}
            </div>

            {item.status === 'missing' && item.obtainFrom ? (
              <p className="mt-2 rounded-field bg-surface-sunken p-2.5 text-sm text-ink-muted">
                <span className="font-medium text-ink">{ui('getItFrom', language)}: </span>
                {item.obtainFrom}
                {item.obtainServiceCode ? (
                  <span className="ms-1 text-accent">
                    (we cover {item.obtainServiceCode} too)
                  </span>
                ) : null}
              </p>
            ) : null}

            {item.documentCheck ? (
              <p
                className={`mt-2 rounded-field p-2.5 text-sm ${
                  item.documentCheck.matchStatus === 'match'
                    ? 'bg-verified-soft text-verified-ink'
                    : 'bg-unverified-soft text-unverified-ink'
                }`}
              >
                {item.documentCheck.issues[0] ??
                  (item.documentCheck.matchStatus === 'match'
                    ? ui('matchOk', language)
                    : ui('matchInconclusive', language))}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SourceBadge source={item.source} status={item.verificationStatus} language={language} />

              {onCheckDocument ? (
                <button
                  type="button"
                  onClick={() => onCheckDocument(item.requirementCode)}
                  className="btn-ghost min-h-[2rem] px-2.5 py-1 text-xs"
                >
                  <Icon name="upload" size={13} />
                  {ui('checkDocument', language)}
                </button>
              ) : null}

              {item.description ? (
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : item.requirementCode)}
                  aria-expanded={isOpen}
                  className="btn-ghost min-h-[2rem] px-2.5 py-1 text-xs"
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                  {isOpen ? 'Less' : 'More'}
                </button>
              ) : null}
            </div>

            {isOpen && item.description ? (
              <p className="mt-2 max-w-reading text-sm text-ink-muted animate-fade-up">{item.description}</p>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  return (
    <section className={className} aria-labelledby="checklist-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="checklist-heading" className="text-lg font-semibold text-ink">
          {ui('documents', language)}
        </h2>
        <p className="text-sm text-ink-muted">{ui('readinessHelp', language)}</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 rounded-card border border-dashed border-border p-6 text-center text-sm text-ink-subtle">
          No documents have been determined yet.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-3">{mandatory.map(renderItem)}</ul>
          {optional.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-medium text-ink-muted">
                {ui('optional', language)}
              </h3>
              <ul className="mt-2 space-y-3">{optional.map(renderItem)}</ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
