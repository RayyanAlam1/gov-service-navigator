/**
 * Core vocabulary shared by the database, the API and the UI.
 *
 * Every one of these is defined exactly once, as a zod schema, with the
 * TypeScript type derived from it. Nothing in this codebase declares a
 * duplicate `type Language = 'en' | 'ur' | ...` — that is how two validators
 * of the same shape drift apart and start disagreeing about whether a payload
 * is valid.
 */
import { z } from 'zod';

/* ── Language ─────────────────────────────────────────────────────────────
 * roman_ur is a first-class language, not a dialect of English. It is how a
 * very large share of Pakistani citizens actually type, and the whole
 * retrieval and phrasing path treats it as its own thing.
 */
export const LanguageSchema = z.enum(['en', 'ur', 'roman_ur']);
export type Language = z.infer<typeof LanguageSchema>;

export const LANGUAGE_LABELS: Record<Language, { native: string; english: string; dir: 'ltr' | 'rtl' }> = {
  en: { native: 'English', english: 'English', dir: 'ltr' },
  ur: { native: 'اردو', english: 'Urdu', dir: 'rtl' },
  roman_ur: { native: 'Roman Urdu', english: 'Roman Urdu', dir: 'ltr' },
};

export function textDirection(language: Language): 'ltr' | 'rtl' {
  return LANGUAGE_LABELS[language].dir;
}

/* ── Provenance ───────────────────────────────────────────────────────── */

export const VerificationStatusSchema = z.enum(['verified', 'unverified', 'synthetic', 'deprecated']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * Trust tiers, in the order the UI ranks them. `synthetic` exists so demo
 * content can be structurally complete without ever masquerading as an
 * official requirement.
 */
export const TRUST_RANK: Record<VerificationStatus, number> = {
  verified: 3,
  unverified: 2,
  synthetic: 1,
  deprecated: 0,
};

export const ServiceChannelSchema = z.enum(['online', 'in_person', 'either', 'postal']);
export type ServiceChannel = z.infer<typeof ServiceChannelSchema>;

export const ReadinessStateSchema = z.enum(['ready', 'nearly_ready', 'not_ready', 'undetermined']);
export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

export const SessionStatusSchema = z.enum(['intake', 'interviewing', 'resolved', 'planned', 'abandoned', 'expired']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const VariableTypeSchema = z.enum(['boolean', 'enum', 'number', 'text', 'date']);
export type VariableType = z.infer<typeof VariableTypeSchema>;

export const DocumentMatchStatusSchema = z.enum([
  'match',
  'mismatch',
  'unreadable',
  'wrong_document',
  'expired',
  'inconclusive',
]);
export type DocumentMatchStatus = z.infer<typeof DocumentMatchStatusSchema>;

export const AnswerOriginSchema = z.enum(['user', 'inferred', 'document', 'default']);
export type AnswerOrigin = z.infer<typeof AnswerOriginSchema>;

/* ── Answer values ────────────────────────────────────────────────────────
 * The interview's value domain. Deliberately narrow: anything the citizen
 * tells us is one of these, so the rules engine never has to reason about an
 * arbitrary object.
 */
export const AnswerValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

export const AnswerMapSchema = z.record(z.string(), AnswerValueSchema);
export type AnswerMap = z.infer<typeof AnswerMapSchema>;

/* ── The ten-stage citizen journey ────────────────────────────────────────
 * Straight out of the product spec. Every agent trace is tagged with the
 * stage it belongs to, which is what lets the UI show a citizen (and a judge)
 * where in the journey a given decision was made.
 */
export const JourneyStageSchema = z.enum([
  'user_goal',
  'language_intent',
  'situation_interview',
  'service_resolution',
  'official_retrieval',
  'eligibility_requirements',
  'personalized_plan',
  'readiness_check',
  'office_application',
  'follow_up',
]);
export type JourneyStage = z.infer<typeof JourneyStageSchema>;

export const JOURNEY_STAGES: ReadonlyArray<{ id: JourneyStage; order: number; label: string; blurb: string }> = [
  { id: 'user_goal', order: 1, label: 'Your goal', blurb: 'What you want to get done' },
  { id: 'language_intent', order: 2, label: 'Language & intent', blurb: 'Understanding how you asked' },
  { id: 'situation_interview', order: 3, label: 'Your situation', blurb: 'Only the questions that matter' },
  { id: 'service_resolution', order: 4, label: 'Service match', blurb: 'Which service and which case' },
  { id: 'official_retrieval', order: 5, label: 'Official sources', blurb: 'Retrieved from published documents' },
  { id: 'eligibility_requirements', order: 6, label: 'Eligibility & documents', blurb: 'What the rules require' },
  { id: 'personalized_plan', order: 7, label: 'Your action plan', blurb: 'Step by step, for your case' },
  { id: 'readiness_check', order: 8, label: 'Am I ready?', blurb: 'What you still need' },
  { id: 'office_application', order: 9, label: 'Where to go', blurb: 'Office or official online route' },
  { id: 'follow_up', order: 10, label: 'Follow-up', blurb: 'Save, track, re-check' },
];

/* ── Localized text ───────────────────────────────────────────────────────
 * Every citizen-facing string carries all three languages where we have them.
 * `en` is required because it is the pivot the rules and evaluation harness
 * work in; the others fall back to it rather than rendering empty.
 */
export const LocalizedTextSchema = z.object({
  en: z.string(),
  ur: z.string().nullable().optional(),
  roman_ur: z.string().nullable().optional(),
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export function pickLocalized(text: LocalizedText, language: Language): string {
  if (language === 'ur') return text.ur?.trim() || text.en;
  if (language === 'roman_ur') return text.roman_ur?.trim() || text.en;
  return text.en;
}

/** Build a LocalizedText from three nullable database columns. */
export function localized(en: string, ur?: string | null, romanUr?: string | null): LocalizedText {
  return { en, ur: ur ?? null, roman_ur: romanUr ?? null };
}

/* ── Provenance envelope ──────────────────────────────────────────────────
 * The single most important type in the system. Anything citizen-facing that
 * asserts a government fact must be wrapped in one of these, and the UI
 * refuses to render a bare fact without it.
 */
export const SourceRefSchema = z.object({
  id: z.number().int().nullable(),
  code: z.string(),
  title: z.string(),
  publisher: z.string(),
  url: z.string().nullable(),
  lastVerified: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  verificationStatus: VerificationStatusSchema,
  /** True when last_verified is older than SOURCE_STALE_AFTER_DAYS. */
  isStale: z.boolean(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ProvenanceSchema = z.object({
  /** 'database' = a deterministic row. 'retrieval' = a retrieved chunk. */
  origin: z.enum(['database', 'retrieval', 'derived']),
  sources: z.array(SourceRefSchema),
  verificationStatus: VerificationStatusSchema,
  /** Set when a claim could not be traced; the UI renders the caveat. */
  caveat: z.string().nullable().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Weakest-link trust: a claim is only as trustworthy as its least-verified source. */
export function weakestStatus(statuses: readonly VerificationStatus[]): VerificationStatus {
  if (statuses.length === 0) return 'synthetic';
  return statuses.reduce((worst, s) => (TRUST_RANK[s] < TRUST_RANK[worst] ? s : worst), 'verified' as VerificationStatus);
}

/* ── Money ────────────────────────────────────────────────────────────────
 * amountMinor is nullable throughout, and that is load-bearing. A NULL fee
 * renders as "not verified — confirm at the office", which is safe. An
 * invented number is not.
 */
export const MoneySchema = z.object({
  amountMinor: z.number().int().nullable(),
  currency: z.string().default('PKR'),
});
export type Money = z.infer<typeof MoneySchema>;

export function formatMoney(money: Money | null | undefined, language: Language = 'en'): string {
  if (!money || money.amountMinor === null) {
    return language === 'ur' ? 'تصدیق شدہ نہیں' : 'not verified';
  }
  const major = money.amountMinor / 100;
  const formatted = new Intl.NumberFormat(language === 'ur' ? 'ur-PK' : 'en-PK', {
    maximumFractionDigits: major % 1 === 0 ? 0 : 2,
  }).format(major);
  return `${money.currency} ${formatted}`;
}
