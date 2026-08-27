'use client';

/**
 * One interview question.
 *
 * Design decisions that matter for this audience:
 *
 *   * One question per screen. A form with twelve fields is how a government
 *     website already fails these citizens; the whole differentiator is that
 *     this asks few questions and explains each one.
 *   * "Why are we asking this?" is a real, always-present affordance, and its
 *     answer is computed from the rules the question actually gates — not
 *     generated prose. It is the difference between a system that asks and one
 *     that interrogates.
 *   * "I'm not sure" is a first-class button. Forcing an answer produces a
 *     confident wrong plan; a skip produces an honest "may apply" item.
 *   * Options are 44px-tall targets with generous spacing, because this is
 *     being tapped one-handed on a bus.
 */
import { useEffect, useRef, useState } from 'react';
import { textDirection, type Language } from '@/lib/schemas/core';
import { ui } from '@/lib/i18n/ui';
import { Icon } from '@/components/ui/Icon';

export interface QuestionView {
  variable: string;
  type: 'boolean' | 'enum' | 'number' | 'text' | 'date';
  text: string;
  help: string | null;
  why: string;
  options: Array<{ value: string | number | boolean; label: string }>;
}

interface Props {
  question: QuestionView;
  language: Language;
  progress: number;
  askedCount: number;
  busy?: boolean;
  onAnswer: (value: string | number | boolean | null) => void;
  onSkip: () => void;
  className?: string;
}

export function InterviewCard({
  question,
  language,
  progress,
  askedCount,
  busy = false,
  onAnswer,
  onSkip,
  className = '',
}: Props) {
  const [showWhy, setShowWhy] = useState(false);
  const [freeValue, setFreeValue] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dir = textDirection(language);

  // Move focus to the new question so keyboard and screen-reader users are not
  // stranded at the bottom of the previous one.
  useEffect(() => {
    setFreeValue('');
    setShowWhy(false);
    headingRef.current?.focus();
  }, [question.variable]);

  const booleanOptions: Array<{ value: boolean; label: string }> = [
    { value: true, label: ui('yes', language) },
    { value: false, label: ui('no', language) },
  ];

  const submitFree = () => {
    const trimmed = freeValue.trim();
    if (!trimmed) return;
    onAnswer(question.type === 'number' ? Number(trimmed) : trimmed);
  };

  return (
    <section
      className={`card p-5 sm:p-6 ${className}`}
      aria-labelledby="question-heading"
      dir={dir}
      lang={language === 'ur' ? 'ur' : 'en'}
    >
      {/* Progress is honest about being an estimate — it is derived from how
          many useful questions remain, which shrinks as answers arrive. */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
          {ui('questionProgress', language)} {askedCount + 1}
        </span>
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Interview progress"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.max(6, Math.round(progress * 100))}%` }}
          />
        </div>
      </div>

      <h2
        id="question-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-xl font-semibold text-ink outline-none sm:text-2xl"
      >
        {question.text}
      </h2>

      {question.help ? (
        <p className="mt-2 max-w-reading text-sm text-ink-muted">{question.help}</p>
      ) : null}

      <button
        type="button"
        onClick={() => setShowWhy((v) => !v)}
        aria-expanded={showWhy}
        className="btn-ghost mt-3 min-h-[2.25rem] px-2.5 py-1.5 text-xs"
      >
        <Icon name="question" size={14} />
        {ui('whyAsking', language)}
      </button>

      {showWhy ? (
        <p className="mt-2 max-w-reading rounded-field bg-info-soft p-3 text-sm text-info-ink animate-fade-up">
          {question.why}
        </p>
      ) : null}

      <div className="mt-5">
        {question.type === 'boolean' ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {booleanOptions.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                disabled={busy}
                onClick={() => onAnswer(option.value)}
                className="btn-secondary justify-start text-base hover:border-accent hover:bg-accent-soft"
              >
                <Icon name={option.value ? 'check' : 'cross'} size={16} className="text-ink-subtle" />
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        {question.type === 'enum' ? (
          <div className="grid gap-2.5">
            {question.options.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                disabled={busy}
                onClick={() => onAnswer(option.value)}
                className="btn-secondary justify-between text-start text-base hover:border-accent hover:bg-accent-soft"
              >
                <span>{option.label}</span>
                <Icon name={dir === 'rtl' ? 'arrow-left' : 'arrow-right'} size={16} className="text-ink-subtle" />
              </button>
            ))}
          </div>
        ) : null}

        {question.type === 'number' || question.type === 'text' || question.type === 'date' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitFree();
            }}
            className="flex flex-col gap-2.5 sm:flex-row"
          >
            {/* A visible label, not a placeholder standing in for one. */}
            <label htmlFor="answer-input" className="sr-only">
              {question.text}
            </label>
            <input
              id="answer-input"
              type={question.type === 'number' ? 'number' : question.type === 'date' ? 'date' : 'text'}
              inputMode={question.type === 'number' ? 'numeric' : 'text'}
              value={freeValue}
              onChange={(e) => setFreeValue(e.target.value)}
              disabled={busy}
              autoComplete="off"
              className="field flex-1"
            />
            <button type="submit" disabled={busy || !freeValue.trim()} className="btn-primary">
              {ui('continue', language)}
              <Icon name={dir === 'rtl' ? 'arrow-left' : 'arrow-right'} size={16} />
            </button>
          </form>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onSkip}
        disabled={busy}
        className="btn-ghost mt-4 px-2.5 text-sm"
      >
        {ui('skipQuestion', language)}
      </button>
    </section>
  );
}
