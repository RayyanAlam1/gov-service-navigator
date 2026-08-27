'use client';

/**
 * Document check dialog.
 *
 * The privacy promise is stated on screen before the citizen chooses a file,
 * not buried in a footer afterwards. People about to upload a picture of their
 * national ID deserve to know what happens to it at the moment they decide,
 * and the promise is real: the bytes are processed in memory and discarded, and
 * only the structured verdict is stored.
 *
 * Focus is trapped while open and restored on close, and Escape dismisses —
 * a modal that strands keyboard users is worse than no modal.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiClientError, type DocumentCheckResponse } from '@/lib/api/client';
import { ui } from '@/lib/i18n/ui';
import { textDirection, type Language } from '@/lib/schemas/core';
import { Icon, type IconName } from '@/components/ui/Icon';

interface Props {
  requirementCode: string;
  requirementTitle: string;
  language: Language;
  onClose: () => void;
  onChecked: () => void;
}

const VERDICT: Record<
  DocumentCheckResponse['matchStatus'],
  { icon: IconName; tone: string; key: 'matchOk' | 'matchExpired' | 'matchWrong' | 'matchUnreadable' | 'matchInconclusive' }
> = {
  match: { icon: 'check', tone: 'bg-verified-soft text-verified-ink', key: 'matchOk' },
  expired: { icon: 'clock', tone: 'bg-danger-soft text-danger-ink', key: 'matchExpired' },
  wrong_document: { icon: 'cross', tone: 'bg-danger-soft text-danger-ink', key: 'matchWrong' },
  mismatch: { icon: 'alert', tone: 'bg-unverified-soft text-unverified-ink', key: 'matchWrong' },
  unreadable: { icon: 'question', tone: 'bg-info-soft text-info-ink', key: 'matchUnreadable' },
  inconclusive: { icon: 'question', tone: 'bg-info-soft text-info-ink', key: 'matchInconclusive' },
};

export function DocumentCheckDialog({
  requirementCode,
  requirementTitle,
  language,
  onClose,
  onChecked,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DocumentCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const dir = textDirection(language);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Trap focus inside the dialog.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.checkDocument(requirementCode, file);
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : ui('errorTitle', language));
    } finally {
      setBusy(false);
    }
  };

  const verdict = result ? VERDICT[result.matchStatus] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-dialog-title"
        dir={dir}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-card bg-surface p-5 shadow-raised sm:rounded-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="doc-dialog-title" className="text-lg font-semibold text-ink">
              {ui('checkDocument', language)}
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">{requirementTitle}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="btn-ghost min-h-touch min-w-touch p-2"
            aria-label="Close"
          >
            <Icon name="cross" size={18} />
          </button>
        </div>

        {/* Stated before the file picker, not after. */}
        <p className="mt-4 flex items-start gap-2 rounded-field bg-info-soft p-3 text-sm text-info-ink">
          <Icon name="shield" size={15} className="mt-0.5" />
          <span>{ui('uploadHelp', language)}</span>
        </p>

        {!result ? (
          <div className="mt-4">
            <label
              htmlFor="doc-file"
              className="flex min-h-[7rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border-strong p-5 text-center transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <Icon name="upload" size={22} className="text-ink-subtle" />
              <span className="text-sm font-medium text-ink">
                {file ? file.name : 'Choose a file'}
              </span>
              <span className="text-xs text-ink-subtle">
                Demo documents are in <code className="font-mono">data/samples/</code>
              </span>
              <input
                id="doc-file"
                type="file"
                accept=".txt,.json,.md,text/plain,application/json,image/*,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
            </label>

            {error ? (
              <p role="alert" className="mt-3 rounded-field bg-danger-soft p-3 text-sm text-danger-ink">
                {error}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={upload} disabled={!file || busy} className="btn-primary">
                {busy ? (
                  <>
                    <Icon name="refresh" size={16} className="animate-spin" />
                    {ui('loading', language)}
                  </>
                ) : (
                  <>
                    <Icon name="search" size={16} />
                    {ui('checkDocument', language)}
                  </>
                )}
              </button>
              <button type="button" onClick={onClose} className="btn-secondary">
                {ui('back', language)}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            {verdict ? (
              <p className={`flex items-start gap-2 rounded-field p-3 text-sm font-medium ${verdict.tone}`}>
                <Icon name={verdict.icon} size={16} className="mt-0.5" />
                <span>{ui(verdict.key, language)}</span>
              </p>
            ) : null}

            {result.issues.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {result.issues.map((issue) => (
                  <li key={issue} className="flex items-start gap-2 text-sm text-ink-muted">
                    <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                    {issue}
                  </li>
                ))}
              </ul>
            ) : null}

            {result.fields.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  Extracted fields
                </p>
                <dl className="mt-2 divide-y divide-border rounded-field border border-border">
                  {result.fields.map((field) => (
                    <div key={field.name} className="flex items-baseline justify-between gap-3 p-2.5">
                      <dt className="text-sm capitalize text-ink-muted">{field.name.replace(/_/g, ' ')}</dt>
                      <dd className="text-sm font-medium text-ink">
                        <span className="font-mono">{field.value}</span>
                        {field.redacted ? (
                          <span className="ms-2 badge bg-surface-sunken text-ink-subtle">masked</span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-subtle">
              <Icon name="shield" size={12} />
              {ui('nothingStored', language)} — {result.note}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={onChecked} className="btn-primary">
                {ui('continue', language)}
              </button>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setFile(null);
                }}
                className="btn-secondary"
              >
                {ui('retry', language)}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
