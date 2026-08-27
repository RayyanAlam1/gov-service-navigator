'use client';

/**
 * Language switch.
 *
 * The critical behaviour is what it does NOT do: it changes one server column
 * and re-renders. It does not remount a provider, re-key the session, or reset
 * component state. A citizen who switches to Urdu three questions into the
 * interview keeps every answer.
 *
 * That failure is worth naming because it is so easy to introduce: keying the
 * app on `language` (`<App key={lang}>`) looks tidy and quietly discards the
 * work of anyone who switches mid-flow — which, for this audience, is a lot of
 * people, since they often start typing in Roman Urdu and then realise they can
 * read the plan properly in Urdu.
 */
import { LANGUAGE_LABELS, type Language } from '@/lib/schemas/core';
import { ui } from '@/lib/i18n/ui';
import { Icon } from './Icon';

const ORDER: Language[] = ['en', 'ur', 'roman_ur'];

interface Props {
  value: Language;
  onChange: (language: Language) => void;
  disabled?: boolean;
  className?: string;
}

export function LanguageSwitch({ value, onChange, disabled = false, className = '' }: Props) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full border border-border bg-surface p-1 ${className}`}
      role="group"
      aria-label={ui('language', value)}
    >
      <Icon name="language" size={15} className="ms-1.5 text-ink-subtle" />
      {ORDER.map((language) => {
        const active = language === value;
        return (
          <button
            key={language}
            type="button"
            onClick={() => !active && onChange(language)}
            disabled={disabled}
            // aria-pressed rather than a radio group: this is a toggle set, and
            // screen readers announce the state without needing a fieldset.
            aria-pressed={active}
            lang={language === 'ur' ? 'ur' : 'en'}
            className={[
              'min-h-[2rem] rounded-full px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-white'
                : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
              disabled ? 'cursor-not-allowed opacity-60' : '',
            ].join(' ')}
          >
            {LANGUAGE_LABELS[language].native}
          </button>
        );
      })}
    </div>
  );
}
