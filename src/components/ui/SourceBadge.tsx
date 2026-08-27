'use client';

/**
 * The trust signal.
 *
 * Every citizen-facing fact in this product renders one of these. It is the
 * single most important component in the interface, because the product's only
 * real asset is that a citizen can tell the difference between "this is
 * confirmed against an official source" and "this is structurally right but
 * nobody has checked it".
 *
 * Three deliberate choices:
 *
 *   1. Colour is never the only signal. Each state has its own icon and its own
 *      words, so it survives colour blindness, a monochrome screen, and a
 *      screenshot printed in black and white.
 *   2. The default is expanded, not a tooltip. A trust caveat behind a hover is
 *      a caveat that mobile users never see — and mobile is most of this
 *      audience.
 *   3. A missing source is a *louder* state than an unverified one, not a
 *      quieter one. Absence of provenance is the worst case, so it must not
 *      degrade into a neutral grey chip nobody notices.
 */
import { useId, useState } from 'react';
import type { Language, SourceRef, VerificationStatus } from '@/lib/schemas/core';
import { ui } from '@/lib/i18n/ui';
import { Icon, type IconName } from './Icon';

interface Props {
  source: SourceRef | null;
  status: VerificationStatus;
  language: Language;
  /** `chip` for inline use next to a fact; `panel` for a full attribution block. */
  variant?: 'chip' | 'panel';
  className?: string;
}

interface Appearance {
  icon: IconName;
  classes: string;
  labelKey: 'verified' | 'unverified' | 'synthetic' | 'sourceUnknown';
}

function appearanceFor(status: VerificationStatus, hasSource: boolean): Appearance {
  if (!hasSource) {
    return {
      icon: 'alert',
      classes: 'bg-danger-soft text-danger-ink ring-1 ring-danger/30',
      labelKey: 'sourceUnknown',
    };
  }
  switch (status) {
    case 'verified':
      return {
        icon: 'shield',
        classes: 'bg-verified-soft text-verified-ink ring-1 ring-verified/25',
        labelKey: 'verified',
      };
    case 'synthetic':
      return {
        icon: 'info',
        classes: 'bg-synthetic-soft text-synthetic-ink ring-1 ring-synthetic/30',
        labelKey: 'synthetic',
      };
    case 'deprecated':
    case 'unverified':
    default:
      return {
        icon: 'alert',
        classes: 'bg-unverified-soft text-unverified-ink ring-1 ring-unverified/30',
        labelKey: 'unverified',
      };
  }
}

function formatDate(iso: string | null, language: Language): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language === 'ur' ? 'ur-PK' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function SourceBadge({ source, status, language, variant = 'chip', className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const hasSource = source !== null;
  const { icon, classes, labelKey } = appearanceFor(status, hasSource);
  const label = ui(labelKey, language);
  const verifiedOn = formatDate(source?.lastVerified ?? null, language);

  if (variant === 'panel') {
    return (
      <div className={`rounded-field p-3 text-sm ${classes} ${className}`}>
        <div className="flex items-start gap-2">
          <Icon name={icon} size={16} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{label}</p>
            {source ? (
              <>
                <p className="mt-1 break-words opacity-90">{source.title}</p>
                <p className="mt-0.5 text-xs opacity-75">{source.publisher}</p>
                <p className="mt-1 text-xs opacity-75">
                  {verifiedOn
                    ? `${ui('lastVerified', language)}: ${verifiedOn}`
                    : ui('couldNotVerify', language)}
                </p>
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-2 inline-flex min-h-touch items-center gap-1.5 text-xs font-medium underline underline-offset-2"
                  >
                    {new URL(source.url).hostname.replace(/^www\./, '')}
                    <Icon name="external" size={13} />
                  </a>
                ) : null}
              </>
            ) : (
              <p className="mt-1 opacity-90">{ui('couldNotVerify', language)}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`badge min-h-[1.75rem] cursor-pointer px-2.5 transition-shadow hover:shadow-sm ${classes}`}
      >
        <Icon name={icon} size={13} />
        <span>{label}</span>
        {source?.isStale && status === 'verified' ? (
          <span className="opacity-80">· {ui('stale', language)}</span>
        ) : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="opacity-70" />
      </button>

      {open ? (
        <span
          id={panelId}
          className="block max-w-reading rounded-field border border-border bg-surface-sunken p-2.5 text-xs text-ink-muted animate-fade-up"
        >
          {source ? (
            <>
              <span className="block font-medium text-ink">{source.title}</span>
              <span className="mt-0.5 block">{source.publisher}</span>
              <span className="mt-1 block">
                {verifiedOn
                  ? `${ui('lastVerified', language)}: ${verifiedOn}`
                  : ui('couldNotVerify', language)}
              </span>
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="mt-1.5 inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2"
                >
                  {new URL(source.url).hostname.replace(/^www\./, '')}
                  <Icon name="external" size={12} />
                </a>
              ) : null}
            </>
          ) : (
            <span>{ui('couldNotVerify', language)}</span>
          )}
        </span>
      ) : null}
    </span>
  );
}
