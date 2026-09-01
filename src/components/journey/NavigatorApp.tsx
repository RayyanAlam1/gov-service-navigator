'use client';

/**
 * The application shell and flow controller.
 *
 * Deliberately one stateful component rather than a router-driven wizard. The
 * journey is short, the state is small, and keeping it in one place is what
 * guarantees the property that matters most here: **switching language never
 * loses anything.** `language` is a single field in this state object. It is
 * not a route segment, not a context key, and nothing is keyed on it — so a
 * citizen who switches to Urdu three questions in keeps every answer, their
 * resolved service, and their position in the flow.
 *
 * The phases map onto the ten-stage journey the product spec describes, and the
 * stepper shows which one the citizen is in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiClientError,
  getSessionToken,
  setSessionToken,
  type InterviewPlanResponse,
  type InterviewQuestionResponse,
} from '@/lib/api/client';
import { ui } from '@/lib/i18n/ui';
import {
  pickLocalized,
  textDirection,
  type JourneyStage,
  type Language,
} from '@/lib/schemas/core';
import type { ChecklistItem, ReadinessReport } from '@/lib/schemas/domain';
import { Icon } from '@/components/ui/Icon';
import { LanguageSwitch } from '@/components/ui/LanguageSwitch';
import { SourceBadge } from '@/components/ui/SourceBadge';
import { ActionTimeline } from './ActionTimeline';
import { Checklist } from './Checklist';
import { DocumentCheckDialog } from './DocumentCheckDialog';
import { InterviewCard } from './InterviewCard';
import { JourneyStepper } from './JourneyStepper';
import { ReadinessGauge } from './ReadinessGauge';
import { TracePanel, type TraceStepView, type TraceSummaryView } from './TracePanel';

type Phase = 'intake' | 'disambiguate' | 'interview' | 'plan' | 'refused';

interface DisambiguationCandidate {
  code: string;
  name: { en: string; ur?: string | null; roman_ur?: string | null };
  summary: { en: string; ur?: string | null; roman_ur?: string | null };
  confidence: number;
  matchedOn: string[];
}

const EXAMPLES: Array<{ language: Language; text: string; label: string }> = [
  {
    language: 'roman_ur',
    text: 'mera CNIC gum hogya hai, Karachi mein hun. ab kya karna hai?',
    label: 'Roman Urdu · lost CNIC',
  },
  {
    language: 'ur',
    text: 'میرا پاسپورٹ ختم ہو گیا ہے، مجھے تجدید کروانی ہے',
    label: 'اردو · passport renewal',
  },
  {
    language: 'en',
    text: 'I need a domicile certificate and I recently moved to Lahore',
    label: 'English · domicile',
  },
];

export function NavigatorApp() {
  const [phase, setPhase] = useState<Phase>('intake');
  const [language, setLanguage] = useState<Language>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DisambiguationCandidate[]>([]);
  const [service, setService] = useState<InterviewPlanResponse['plan'] | null>(null);
  const [serviceMeta, setServiceMeta] = useState<{
    code: string;
    name: { en: string; ur?: string | null; roman_ur?: string | null };
    department: string | null;
    onlineApplicationUrl: string | null;
  } | null>(null);
  const [assumptions, setAssumptions] = useState<
    Array<{ variable: string; value: unknown; evidence: string; label: string }>
  >([]);

  const [question, setQuestion] = useState<InterviewQuestionResponse | null>(null);
  const [plan, setPlan] = useState<InterviewPlanResponse | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [text, setText] = useState<Record<string, string>>({});

  const [trace, setTrace] = useState<{ steps: TraceStepView[]; summary: TraceSummaryView | null }>({
    steps: [],
    summary: null,
  });
  const [documentTarget, setDocumentTarget] = useState<string | null>(null);

  const dir = textDirection(language);
  const liveRegion = useRef<HTMLDivElement>(null);

  /* ── Shell direction ───────────────────────────────────────────────── */

  useEffect(() => {
    // Set on <html> so the whole document flips, including scrollbars and any
    // portalled dialog.
    document.documentElement.lang = language === 'ur' ? 'ur' : 'en';
    document.documentElement.dir = dir;
  }, [language, dir]);

  const stage: JourneyStage = useMemo(() => {
    if (phase === 'intake' || phase === 'refused') return 'user_goal';
    if (phase === 'disambiguate') return 'service_resolution';
    if (phase === 'interview') return 'situation_interview';
    return readiness ? 'readiness_check' : 'personalized_plan';
  }, [phase, readiness]);

  const completedStages: JourneyStage[] = useMemo(() => {
    const done: JourneyStage[] = [];
    if (phase !== 'intake' && phase !== 'refused') done.push('user_goal', 'language_intent');
    if (phase === 'interview' || phase === 'plan') done.push('service_resolution');
    if (phase === 'plan') {
      done.push('situation_interview', 'official_retrieval', 'eligibility_requirements', 'personalized_plan');
    }
    return done;
  }, [phase]);

  /* ── Error handling ────────────────────────────────────────────────── */

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiClientError) {
        if (err.isSessionExpired) {
          setSessionToken(null);
          setError(ui('sessionExpired', language));
          setPhase('intake');
          return;
        }
        setError(err.message);
        return;
      }
      setError(ui('errorTitle', language));
    },
    [language],
  );

  const refreshTrace = useCallback(async () => {
    try {
      const result = await api.trace();
      setTrace({ steps: result.steps, summary: result.summary });
    } catch {
      // The trace panel is an explainability affordance, not part of the
      // answer. Failing to load it must not surface as an error.
    }
  }, []);

  /* ── Flow ──────────────────────────────────────────────────────────── */

  const applyTurn = useCallback(
    (result: InterviewQuestionResponse | InterviewPlanResponse) => {
      if (result.kind === 'question') {
        setQuestion(result);
        setPhase('interview');
        return;
      }
      setPlan(result);
      setChecklist(result.plan.checklist);
      setReadiness(result.readiness);
      setText(result.text);
      setQuestion(null);
      setPhase('plan');
    },
    [],
  );

  const submitIntake = useCallback(
    async (queryText: string, explicitLanguage?: Language) => {
      const trimmed = queryText.trim();
      if (!trimmed) return;

      setBusy(true);
      setError(null);
      setRefusal(null);

      try {
        const result = await api.intake(trimmed, explicitLanguage);
        setSessionToken(result.sessionToken);
        setLanguage(result.language);

        if (result.kind === 'refused') {
          setRefusal(result.refusal ? result.refusal[result.language] : ui('errorTitle', result.language));
          setPhase('refused');
          return;
        }

        if (result.kind === 'disambiguate') {
          setCandidates(result.candidates);
          setPhase('disambiguate');
          return;
        }

        setServiceMeta({
          code: result.service.code,
          name: result.service.name,
          department: result.service.department,
          onlineApplicationUrl: result.service.onlineApplicationUrl,
        });
        setAssumptions(result.assumptions);

        const turn = await api.interview({});
        applyTurn(turn);
      } catch (err) {
        handleError(err);
      } finally {
        setBusy(false);
        void refreshTrace();
      }
    },
    [applyTurn, handleError, refreshTrace],
  );

  const chooseService = useCallback(
    async (serviceCode: string) => {
      setBusy(true);
      setError(null);
      try {
        await api.patchSession({ serviceCode });
        const turn = await api.interview({});
        applyTurn(turn);
      } catch (err) {
        handleError(err);
      } finally {
        setBusy(false);
        void refreshTrace();
      }
    },
    [applyTurn, handleError, refreshTrace],
  );

  const answerQuestion = useCallback(
    async (value: string | number | boolean | null) => {
      if (!question) return;
      setBusy(true);
      setError(null);
      try {
        const turn = await api.interview({
          answer: { variable: question.question.variable, value },
        });
        applyTurn(turn);
      } catch (err) {
        handleError(err);
      } finally {
        setBusy(false);
        void refreshTrace();
      }
    },
    [applyTurn, handleError, question, refreshTrace],
  );

  const skipQuestion = useCallback(async () => {
    if (!question) return;
    setBusy(true);
    setError(null);
    try {
      const turn = await api.interview({ skip: question.question.variable });
      applyTurn(turn);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
      void refreshTrace();
    }
  }, [applyTurn, handleError, question, refreshTrace]);

  /**
   * Ticking a checklist box.
   *
   * Optimistic locally, authoritative from the server: possession feeds the
   * rules engine, so one tick can legitimately remove another item (a
   * substitute document) or change the readiness verdict. The server's
   * checklist always wins.
   */
  const toggleHolding = useCallback(
    async (requirementCode: string, held: boolean) => {
      setChecklist((current) =>
        current.map((item) =>
          item.requirementCode === requirementCode
            ? { ...item, status: held ? 'have' : 'missing' }
            : item,
        ),
      );

      setBusy(true);
      try {
        const result = await api.readiness({ [requirementCode]: held });
        setChecklist(result.checklist);
        setReadiness(result.readiness);
        setText((prev) => ({ ...prev, ...result.text }));
      } catch (err) {
        handleError(err);
      } finally {
        setBusy(false);
        void refreshTrace();
      }
    },
    [handleError, refreshTrace],
  );

  /**
   * Language switch.
   *
   * One PATCH, one re-render. No remount, no reset, no lost answers — the
   * server echoes how many answers it still holds so the guarantee is visible
   * rather than assumed.
   */
  const switchLanguage = useCallback(
    async (next: Language) => {
      setLanguage(next);
      if (!getSessionToken()) return;

      try {
        await api.patchSession({ language: next });
        // Re-render the current view in the new language. The plan is
        // regenerated from the same stored answers, not re-derived from input.
        if (phase === 'plan') {
          const turn = await api.interview({ finish: true });
          applyTurn(turn);
        } else if (phase === 'interview') {
          const turn = await api.interview({});
          applyTurn(turn);
        }
      } catch (err) {
        handleError(err);
      }
    },
    [applyTurn, handleError, phase],
  );

  const restart = useCallback(() => {
    setSessionToken(null);
    setPhase('intake');
    setDraft('');
    setQuestion(null);
    setPlan(null);
    setChecklist([]);
    setReadiness(null);
    setText({});
    setCandidates([]);
    setAssumptions([]);
    setServiceMeta(null);
    setService(null);
    setRefusal(null);
    setError(null);
    setTrace({ steps: [], summary: null });
  }, []);

  /* ── Render ────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-dvh" dir={dir}>
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={restart}
            className="flex items-center gap-2.5 text-start"
            aria-label={ui('startOver', language)}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Icon name="shield" size={18} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold leading-tight text-ink">
                {ui('appName', language)}
              </span>
              <span className="hidden text-xs text-ink-subtle sm:block">Pakistan · MVP</span>
            </span>
          </button>

          <div className="flex items-center gap-2">
            <a href="/architecture" className="btn-ghost hidden px-3 text-xs sm:inline-flex">
              <Icon name="cpu" size={14} />
              Architecture
            </a>
            <LanguageSwitch value={language} onChange={switchLanguage} disabled={busy} />
          </div>
        </div>
      </header>

      <div
        ref={liveRegion}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {busy ? ui('loading', language) : ''}
      </div>

      <main id="main" className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6">
        {error ? (
          <div
            role="alert"
            className="mb-5 flex flex-wrap items-center gap-3 rounded-card bg-danger-soft p-4 text-sm text-danger-ink ring-1 ring-danger/25"
          >
            <Icon name="alert" size={16} />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="btn-ghost min-h-[2rem] px-2 text-xs">
              {ui('retry', language)}
            </button>
          </div>
        ) : null}

        {/*
          `grid-cols-1` is load-bearing, not redundant. Tailwind emits
          `repeat(1, minmax(0, 1fr))`, whereas a bare `grid` leaves the single
          track sized to its content — and the journey stepper's ten-item flex
          row has a ~1290px min-content width. Without this the whole page
          scrolled sideways on a phone, which is the one layout failure this
          audience cannot work around.
        */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-6">
            {phase === 'intake' || phase === 'refused' ? (
              <IntakeView
                language={language}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                refusal={refusal}
                onSubmit={submitIntake}
              />
            ) : null}

            {phase === 'disambiguate' ? (
              <DisambiguateView
                language={language}
                candidates={candidates}
                busy={busy}
                onChoose={chooseService}
              />
            ) : null}

            {phase === 'interview' && question ? (
              <>
                {assumptions.length > 0 ? (
                  <AssumptionsBar assumptions={assumptions} language={language} />
                ) : null}
                <InterviewCard
                  question={question.question}
                  language={language}
                  progress={question.progress}
                  askedCount={question.askedCount}
                  busy={busy}
                  onAnswer={answerQuestion}
                  onSkip={skipQuestion}
                />
              </>
            ) : null}

            {phase === 'plan' && plan && readiness ? (
              <PlanView
                plan={plan}
                readiness={readiness}
                checklist={checklist}
                text={text}
                language={language}
                busy={busy}
                serviceMeta={serviceMeta}
                onToggle={toggleHolding}
                onCheckDocument={setDocumentTarget}
              />
            ) : null}

            {trace.steps.length > 0 ? (
              <TracePanel steps={trace.steps} summary={trace.summary} language={language} />
            ) : null}
          </div>

          <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
            <JourneyStepper current={stage} completed={completedStages} language={language} />
          </aside>
        </div>

        <footer className="mt-12 border-t border-border pt-6">
          <p className="max-w-reading text-xs leading-relaxed text-ink-subtle">
            {ui('disclaimer', language)}
          </p>
        </footer>
      </main>

      {documentTarget ? (
        <DocumentCheckDialog
          requirementCode={documentTarget}
          requirementTitle={
            checklist.find((i) => i.requirementCode === documentTarget)?.title.en ?? documentTarget
          }
          language={language}
          onClose={() => setDocumentTarget(null)}
          onChecked={async () => {
            setDocumentTarget(null);
            setBusy(true);
            try {
              const result = await api.readiness({});
              setChecklist(result.checklist);
              setReadiness(result.readiness);
            } catch (err) {
              handleError(err);
            } finally {
              setBusy(false);
              void refreshTrace();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/* ── Sub-views ────────────────────────────────────────────────────────── */

function IntakeView({
  language,
  draft,
  setDraft,
  busy,
  refusal,
  onSubmit,
}: {
  language: Language;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  refusal: string | null;
  onSubmit: (text: string, language?: Language) => void;
}) {
  return (
    <section className="card p-5 sm:p-8">
      <h1 className="text-2xl font-semibold text-ink sm:text-3xl">{ui('intakePrompt', language)}</h1>
      <p className="mt-2 max-w-reading text-base text-ink-muted">{ui('intakeHelp', language)}</p>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(draft);
        }}
      >
        <label htmlFor="intake" className="sr-only">
          {ui('intakePrompt', language)}
        </label>
        <textarea
          id="intake"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ui('intakePlaceholder', language)}
          rows={4}
          maxLength={1200}
          disabled={busy}
          className="field resize-y"
        />

        {refusal ? (
          <p
            role="alert"
            className="mt-3 rounded-field bg-unverified-soft p-3 text-sm text-unverified-ink"
          >
            {refusal}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy || draft.trim().length === 0} className="btn-primary">
            {busy ? (
              <>
                <Icon name="refresh" size={16} className="animate-spin" />
                {ui('thinking', language)}
              </>
            ) : (
              <>
                {ui('start', language)}
                <Icon name="arrow-right" size={16} />
              </>
            )}
          </button>
          <span className="text-xs tabular-nums text-ink-subtle">{draft.length}/1200</span>
        </div>
      </form>

      <div className="mt-8 border-t border-border pt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
          {ui('tryExample', language)}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {EXAMPLES.map((example) => (
            <button
              key={example.text}
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(example.text);
                onSubmit(example.text, example.language);
              }}
              dir={example.language === 'ur' ? 'rtl' : 'ltr'}
              lang={example.language === 'ur' ? 'ur' : 'en'}
              className="rounded-field border border-border bg-surface-sunken p-3 text-start text-sm text-ink-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
            >
              <span className="block text-[11px] uppercase tracking-wide opacity-70" dir="ltr">
                {example.label}
              </span>
              <span className="mt-1 block">{example.text}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function DisambiguateView({
  language,
  candidates,
  busy,
  onChoose,
}: {
  language: Language;
  candidates: DisambiguationCandidate[];
  busy: boolean;
  onChoose: (code: string) => void;
}) {
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="text-xl font-semibold text-ink">{ui('whichService', language)}</h2>
      <p className="mt-1.5 max-w-reading text-sm text-ink-muted">
        We were not confident enough to pick one for you. Choosing wrong would send you to the wrong
        department, so we would rather ask.
      </p>

      <div className="mt-5 grid gap-3">
        {candidates.length === 0 ? (
          <p className="rounded-field border border-dashed border-border p-5 text-center text-sm text-ink-subtle">
            No matching service was found. Try describing the document you need by name.
          </p>
        ) : (
          candidates.map((candidate) => (
            <button
              key={candidate.code}
              type="button"
              disabled={busy}
              onClick={() => onChoose(candidate.code)}
              className="rounded-card border border-border bg-surface p-4 text-start transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">
                    {pickLocalized(
                      { en: candidate.name.en, ur: candidate.name.ur, roman_ur: candidate.name.roman_ur },
                      language,
                    )}
                  </p>
                  <p className="mt-1 text-sm text-ink-muted">
                    {pickLocalized(
                      {
                        en: candidate.summary.en,
                        ur: candidate.summary.ur,
                        roman_ur: candidate.summary.roman_ur,
                      },
                      language,
                    )}
                  </p>
                  {candidate.matchedOn.length > 0 ? (
                    <p className="mt-2 text-xs text-ink-subtle">
                      matched on: {candidate.matchedOn.slice(0, 3).join(', ')}
                    </p>
                  ) : null}
                </div>
                <span className="badge shrink-0 bg-surface-sunken text-ink-muted tabular-nums">
                  {Math.round(candidate.confidence * 100)}%
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function AssumptionsBar({
  assumptions,
  language,
}: {
  assumptions: Array<{ variable: string; value: unknown; evidence: string; label: string }>;
  language: Language;
}) {
  return (
    <div className="rounded-card border border-info/25 bg-info-soft p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-info-ink">
        {ui('weAssumed', language)}
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {assumptions.map((assumption) => (
          <li key={assumption.variable} className="badge bg-surface text-info-ink ring-1 ring-info/25">
            <Icon name="sparkle" size={12} />
            <span>
              {assumption.label.replace(/\?$/, '')}: <strong>{String(assumption.value)}</strong>
            </span>
            <span className="opacity-70">“{assumption.evidence}”</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-info-ink/80">
        These were read from what you wrote. Answer a question differently at any point to correct
        them.
      </p>
    </div>
  );
}

function PlanView({
  plan,
  readiness,
  checklist,
  text,
  language,
  busy,
  serviceMeta,
  onToggle,
  onCheckDocument,
}: {
  plan: InterviewPlanResponse;
  readiness: ReadinessReport;
  checklist: ChecklistItem[];
  text: Record<string, string>;
  language: Language;
  busy: boolean;
  serviceMeta: {
    code: string;
    name: { en: string; ur?: string | null; roman_ur?: string | null };
    department: string | null;
    onlineApplicationUrl: string | null;
  } | null;
  onToggle: (code: string, held: boolean) => void;
  onCheckDocument: (code: string) => void;
}) {
  const headline = text.headline ?? plan.plan.headline.en;

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
          {plan.plan.department}
          {plan.plan.scenarioName ? ` · ${pickLocalized(plan.plan.scenarioName, language)}` : ''}
        </p>
        <h1 className="mt-1.5 text-2xl font-semibold text-ink sm:text-3xl">{headline}</h1>

        {plan.plan.onlineApplicationUrl ? (
          <a
            href={plan.plan.onlineApplicationUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="btn-primary mt-4"
          >
            {ui('officialRoute', language)}
            <Icon name="external" size={16} />
          </a>
        ) : null}

        {plan.plan.caveats.length > 0 ? (
          <details className="group mt-4 overflow-hidden rounded-field border border-unverified/25 bg-unverified-soft">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-unverified-ink [&::-webkit-details-marker]:hidden">
              <Icon name="alert" size={15} className="shrink-0" />
              <span>
                {(plan.plan.caveats.length === 1
                  ? ui('caveatsOne', language)
                  : ui('caveatsMany', language)
                ).replace('{count}', String(plan.plan.caveats.length))}
              </span>
              <Icon
                name="chevron-down"
                size={16}
                className="ms-auto shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <ul className="space-y-1.5 border-t border-unverified/20 px-3.5 pb-3 pt-2.5">
              {plan.plan.caveats.map((caveat, index) => (
                <li key={caveat} className="flex items-start gap-2 text-sm text-unverified-ink/90">
                  <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-unverified" />
                  <span>{text[`caveat.${index}`] ?? caveat}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {plan.grounding.violations.length === 0 ? (
          <p className="mt-4 inline-flex items-center gap-2 text-xs text-verified-ink">
            <Icon name="shield" size={13} />
            Every figure and link below traces to a recorded source.
          </p>
        ) : (
          <p className="mt-4 inline-flex items-center gap-2 text-xs text-danger-ink">
            <Icon name="alert" size={13} />
            {plan.grounding.violations.length} unverifiable claim(s) were removed from this answer.
          </p>
        )}
      </section>

      <ReadinessGauge
        readiness={readiness}
        language={language}
        summaryText={text['readiness.summary']}
        nextActionText={text['readiness.nextAction']}
      />

      {/*
        Exception routing. These are the cases a generic procedure gets wrong —
        a lost record, an address that no longer matches, a missing parental
        document — so they are surfaced above the checklist rather than as a
        footnote, and each carries its own source.
      */}
      {plan.plan.exceptions.length > 0 ? (
        <section className="card p-5" aria-labelledby="exceptions-heading">
          <h2 id="exceptions-heading" className="text-lg font-semibold text-ink">
            Your situation needs special handling
          </h2>
          <ul className="mt-3 space-y-3">
            {plan.plan.exceptions.map((exception) => (
              <li
                key={exception.code}
                className="rounded-field border border-unverified/30 bg-unverified-soft p-4"
              >
                <p className="flex items-start gap-2 text-base font-medium text-unverified-ink">
                  <Icon name="alert" size={16} className="mt-0.5" />
                  {text[`exception.${exception.code}.name`] ?? pickLocalized(exception.name, language)}
                </p>
                <p className="ms-6 mt-1.5 max-w-reading text-sm text-unverified-ink/90">
                  {text[`exception.${exception.code}.guidance`] ??
                    pickLocalized(exception.guidance, language)}
                </p>
                {exception.escalateToOffice ? (
                  <p className="ms-6 mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-unverified-ink">
                    <Icon name="location" size={12} />
                    Raise this at the counter — it is handled case by case.
                  </p>
                ) : null}
                <div className="ms-6 mt-2.5">
                  <SourceBadge
                    source={exception.source}
                    status={exception.source?.verificationStatus ?? 'unverified'}
                    language={language}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Checklist
        items={checklist}
        language={language}
        text={text}
        busy={busy}
        onToggle={onToggle}
        onCheckDocument={onCheckDocument}
      />

      <ActionTimeline steps={plan.plan.steps} language={language} text={text} />

      {plan.plan.fees.length > 0 || plan.plan.processingTimes.length > 0 ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {plan.plan.fees.length > 0 ? (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-ink">{ui('fees', language)}</h3>
              <ul className="mt-3 space-y-3">
                {plan.plan.fees.map((fee) => (
                  <li key={fee.code}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-ink-muted">{pickLocalized(fee.label, language)}</span>
                      <span className="text-sm font-medium text-ink">
                        {fee.amount.amountMinor === null ? (
                          <span className="text-unverified-ink">{ui('notVerified', language)}</span>
                        ) : (
                          `${fee.amount.currency} ${(fee.amount.amountMinor / 100).toLocaleString()}`
                        )}
                      </span>
                    </div>
                    {fee.amount.amountMinor === null ? (
                      <p className="mt-1 text-xs text-ink-subtle">{ui('confirmAtOffice', language)}</p>
                    ) : null}
                    <SourceBadge
                      source={fee.source}
                      status={fee.verificationStatus}
                      language={language}
                      className="mt-2"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.plan.processingTimes.length > 0 ? (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-ink">{ui('processingTime', language)}</h3>
              <ul className="mt-3 space-y-3">
                {plan.plan.processingTimes.map((time) => (
                  <li key={time.code}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-ink-muted">{time.label}</span>
                      <span className="text-sm font-medium text-ink">
                        {time.minDays === null && time.maxDays === null ? (
                          <span className="text-unverified-ink">{ui('notVerified', language)}</span>
                        ) : (
                          `${time.minDays ?? '?'}–${time.maxDays ?? '?'} days`
                        )}
                      </span>
                    </div>
                    <SourceBadge
                      source={time.source}
                      status={time.verificationStatus}
                      language={language}
                      className="mt-2"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {plan.plan.offices.length > 0 ? (
        <section className="card p-5">
          <h3 className="text-sm font-semibold text-ink">{ui('whereToGo', language)}</h3>
          <ul className="mt-3 space-y-3">
            {plan.plan.offices.map((office) => (
              <li key={office.code} className="rounded-field border border-border p-3">
                <p className="text-sm font-medium text-ink">{pickLocalized(office.name, language)}</p>
                <p className="mt-0.5 text-sm text-ink-muted">
                  {office.address ?? `${office.city}, ${office.province}`}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {office.appointmentUrl ? (
                    <a
                      href={office.appointmentUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="btn-secondary min-h-[2rem] px-2.5 py-1 text-xs"
                    >
                      <Icon name="location" size={13} />
                      Official locator
                    </a>
                  ) : null}
                  <SourceBadge
                    source={office.source}
                    status={office.verificationStatus}
                    language={language}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.sources.length > 0 ? (
        <section className="card p-5">
          <h3 className="text-sm font-semibold text-ink">{ui('sources', language)}</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {plan.sources.map((source) => (
              <SourceBadge
                key={source.code}
                source={source}
                status={source.verificationStatus}
                language={language}
                variant="panel"
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
