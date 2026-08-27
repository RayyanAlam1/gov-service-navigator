/**
 * Browser-side API client.
 *
 * Thin on purpose. Its job is to attach the session token, surface a typed
 * error rather than an unhandled rejection, and give every call a timeout — a
 * request that hangs forever on a slow mobile connection presents to the
 * citizen as a frozen app with no way out.
 *
 * The session token lives in sessionStorage, not a cookie: it is scoped to the
 * tab, it disappears when the tab closes, and it is never sent to any origin
 * other than this one.
 */
import type { Language } from '@/lib/schemas/core';

const TOKEN_KEY = 'gsn.session';
const DEFAULT_TIMEOUT_MS = 45_000;

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  get isSessionExpired(): boolean {
    return this.status === 410 || this.code === 'session_expired';
  }
}

export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing can throw on storage access; the app still works, the
    // session just does not survive a reload.
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** multipart uploads pass a FormData body and no content-type. */
  formData?: FormData;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers['x-session-token'] = token;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  try {
    const response = await fetch(path, {
      method: options.method ?? (options.body !== undefined || options.formData ? 'POST' : 'GET'),
      headers,
      ...(options.formData
        ? { body: options.formData }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      signal: controller.signal,
      cache: 'no-store',
    });

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const errorBody = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new ApiClientError(
        response.status,
        errorBody?.error?.code ?? 'unknown',
        errorBody?.error?.message ?? `Request failed with status ${response.status}.`,
        errorBody?.error?.details,
        requestId,
      );
    }

    return payload as T;
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiClientError(
        408,
        'timeout',
        'That took too long. Check your connection and try again.',
      );
    }
    throw new ApiClientError(0, 'network', 'Could not reach the service. Check your connection.');
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Endpoints ────────────────────────────────────────────────────────── */

export const api = {
  intake: (query: string, language?: Language) =>
    request<IntakeResponse>('/api/intake', { body: { query, ...(language ? { language } : {}) } }),

  interview: (body: {
    answer?: { variable: string; value: string | number | boolean | null };
    skip?: string;
    finish?: boolean;
  }) => request<InterviewResponse>('/api/interview', { body }),

  readiness: (holdings: Record<string, boolean>) =>
    request<ReadinessResponse>('/api/readiness', { body: { holdings } }),

  session: () => request<SessionResponse>('/api/session'),

  patchSession: (body: { language?: Language; serviceCode?: string }) =>
    request<{ session: { language: Language }; answersRetained: number }>('/api/session', {
      method: 'PATCH',
      body,
    }),

  trace: () => request<TraceResponse>('/api/trace'),

  offices: (service: string, city?: string) =>
    request<OfficesResponse>(
      `/api/offices?service=${encodeURIComponent(service)}${city ? `&city=${encodeURIComponent(city)}` : ''}`,
    ),

  checkDocument: (requirement: string, file: File) => {
    const form = new FormData();
    form.append('requirement', requirement);
    form.append('file', file);
    return request<DocumentCheckResponse>('/api/documents', { formData: form, timeoutMs: 60_000 });
  },

  health: () => request<HealthResponse>('/api/health?deep=1'),
};

/* ── Response shapes ──────────────────────────────────────────────────────
 * Declared structurally rather than imported from the route modules, so the
 * client bundle never pulls a server module (and its database driver) in.
 */

export type IntakeResponse =
  | {
      kind: 'refused';
      sessionToken: string;
      language: Language;
      refusal: { en: string; ur: string; roman_ur: string } | null;
      findings: Array<{ rule: string; severity: string }>;
      turnId: string;
    }
  | {
      kind: 'disambiguate';
      sessionToken: string;
      language: Language;
      candidates: Array<{
        code: string;
        name: { en: string; ur?: string | null; roman_ur?: string | null };
        summary: { en: string; ur?: string | null; roman_ur?: string | null };
        confidence: number;
        matchedOn: string[];
      }>;
      reasoning: string[];
      turnId: string;
    }
  | {
      kind: 'session';
      sessionToken: string;
      language: Language;
      service: {
        code: string;
        name: { en: string; ur?: string | null; roman_ur?: string | null };
        summary: { en: string; ur?: string | null; roman_ur?: string | null };
        department: string | null;
        officialUrl: string | null;
        onlineApplicationUrl: string | null;
        verificationStatus: string;
      };
      confidence: number;
      reasoning: string[];
      assumptions: Array<{ variable: string; value: unknown; evidence: string; label: string }>;
      turnId: string;
    };

export interface InterviewQuestionResponse {
  kind: 'question';
  question: {
    variable: string;
    type: 'boolean' | 'enum' | 'number' | 'text' | 'date';
    text: string;
    help: string | null;
    why: string;
    options: Array<{ value: string | number | boolean; label: string }>;
  };
  progress: number;
  askedCount: number;
  language: Language;
  debug: {
    skippedAsUseless: unknown;
    openVariables: unknown;
    selectionRationale: string | null;
    alreadyAsked: string[];
  };
  turnId: string;
}

export interface InterviewPlanResponse {
  kind: 'plan';
  version: number;
  language: Language;
  plan: import('@/lib/schemas/domain').ActionPlan;
  readiness: import('@/lib/schemas/domain').ReadinessReport;
  text: Record<string, string>;
  sources: import('@/lib/schemas/core').SourceRef[];
  evidence: Array<{
    chunkId: number;
    documentTitle: string;
    headingPath: string | null;
    excerpt: string;
    score: number;
    similarity: number | null;
    retrievedBy: string[];
    source: import('@/lib/schemas/core').SourceRef;
  }>;
  grounding: {
    violations: Array<{ kind: string; text: string; reason: string }>;
    deterministicShare: number;
    sourcesUsed: number;
    strict: boolean;
    sufficiency: { sufficient: boolean; coverage: number; uncovered: string[]; caveats: string[] } | null;
  };
  turnId: string;
}

export type InterviewResponse = InterviewQuestionResponse | InterviewPlanResponse;

export interface ReadinessResponse {
  readiness: import('@/lib/schemas/domain').ReadinessReport;
  checklist: import('@/lib/schemas/domain').ChecklistItem[];
  text: Record<string, string>;
  caveats: string[];
  grounding: { violations: unknown[]; deterministicShare: number };
  holdings: Record<string, unknown>;
  warnings?: string[];
  turnId: string;
}

export interface SessionResponse {
  session: {
    token: string;
    status: string;
    language: Language;
    detectedLanguage: Language;
    readiness: string;
    originalQuery: string | null;
    createdAt: string;
    expiresAt: string;
  };
  service: {
    code: string;
    name: { en: string; ur?: string | null; roman_ur?: string | null };
    summary: { en: string; ur?: string | null; roman_ur?: string | null };
    department: string | null;
    officialUrl: string | null;
    onlineApplicationUrl: string | null;
  } | null;
  answers: Array<{ variable: string; value: unknown; origin: string }>;
  holdings: Record<string, unknown>;
  latestPlan: unknown;
}

export interface TraceResponse {
  steps: import('@/components/journey/TracePanel').TraceStepView[];
  guardrailEvents: Array<{
    turnId: string | null;
    direction: string;
    rule: string;
    severity: string;
    action: string;
    at: string;
  }>;
  summary: import('@/components/journey/TracePanel').TraceSummaryView & { turns: number };
}

export interface OfficesResponse {
  offices: Array<{
    code: string;
    name: { en: string; ur?: string | null; roman_ur?: string | null };
    officeType: string;
    address: string | null;
    city: string;
    district: string | null;
    province: string;
    phone: string | null;
    hours: string | null;
    appointmentUrl: string | null;
    verificationStatus: string;
    source: import('@/lib/schemas/core').SourceRef | null;
  }>;
  notice?: string;
}

export interface DocumentCheckResponse {
  checkId: number | null;
  requirement: { code: string; documentType: string; title: { en: string } };
  matchStatus: 'match' | 'mismatch' | 'unreadable' | 'wrong_document' | 'expired' | 'inconclusive';
  confidence: number;
  detectedType: string | null;
  fields: Array<{ name: string; value: string; confidence: number; redacted: boolean }>;
  issues: string[];
  ocrProvider: string;
  retained: boolean;
  note: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  environment: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  capabilities: import('@/lib/config/env').CapabilityReport;
  knowledgeBase?: Record<string, number>;
  provenance?: Array<{ table: string; verificationStatus: string; count: number; withoutSource: number }>;
}
