/**
 * Session persistence.
 *
 * Isolation rules, enforced here rather than trusted:
 *
 *   * `public_token` is the only identifier that leaves the server. It is 32
 *     random bytes from a CSPRNG, base64url-encoded. The BIGSERIAL `id` is
 *     never returned by an API route, so session ids cannot be enumerated.
 *   * Every read is scoped by token. There is no function in this file that
 *     fetches a session by numeric id from user input.
 *   * `language` is a display property. `setLanguage` touches one column and
 *     nothing else — switching to Urdu mid-interview must not drop an answer,
 *     which is the single most common way this kind of app loses a citizen.
 */
import { randomBytes } from 'node:crypto';
import { getConfig } from '@/lib/config/env';
import { sql, sqlOne, getDb } from './client';
import { asJson, asJsonValue, asNumber, asString } from './rows';
import type {
  AnswerMap,
  AnswerOrigin,
  AnswerValue,
  Language,
  ReadinessState,
  SessionStatus,
} from '@/lib/schemas/core';

export interface SessionRecord {
  id: number;
  token: string;
  status: SessionStatus;
  detectedLanguage: Language;
  preferredLanguage: Language;
  originalQuery: string | null;
  normalizedQuery: string | null;
  serviceId: number | null;
  scenarioId: number | null;
  serviceConfidence: number | null;
  locationCity: string | null;
  locationProvince: string | null;
  readiness: ReadinessState;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface StoredAnswer {
  variableCode: string;
  value: AnswerValue;
  origin: AnswerOrigin;
  confidence: number;
  askedAt: string | null;
  answeredAt: string;
}

type Row = Record<string, unknown>;

function toSession(row: Row): SessionRecord {
  return {
    id: asNumber(row.id),
    token: asString(row.public_token),
    status: asString(row.status, 'intake') as SessionStatus,
    detectedLanguage: asString(row.detected_language, 'en') as Language,
    preferredLanguage: asString(row.preferred_language, 'en') as Language,
    originalQuery: row.original_query === null ? null : asString(row.original_query),
    normalizedQuery: row.normalized_query === null ? null : asString(row.normalized_query),
    serviceId: row.service_id === null || row.service_id === undefined ? null : asNumber(row.service_id),
    scenarioId: row.scenario_id === null || row.scenario_id === undefined ? null : asNumber(row.scenario_id),
    serviceConfidence:
      row.service_confidence === null || row.service_confidence === undefined
        ? null
        : asNumber(row.service_confidence),
    locationCity: row.location_city === null ? null : asString(row.location_city),
    locationProvince: row.location_province === null ? null : asString(row.location_province),
    readiness: asString(row.readiness, 'undetermined') as ReadinessState,
    turnCount: asNumber(row.turn_count),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

/**
 * Unguessable session identifier.
 *
 * base64url so it is URL- and cookie-safe without escaping. 32 bytes is 256
 * bits of entropy; there is no rate at which these can be guessed.
 */
export function generateSessionToken(): string {
  return randomBytes(getConfig().SESSION_ID_BYTES).toString('base64url');
}

export async function createSession(input: {
  language: Language;
  originalQuery: string | null;
  normalizedQuery: string | null;
  clientFingerprint: string | null;
}): Promise<SessionRecord> {
  const cfg = getConfig();
  const token = generateSessionToken();

  const row = await sqlOne<Row>(
    `INSERT INTO sessions
       (public_token, status, detected_language, preferred_language,
        original_query, normalized_query, client_fingerprint, expires_at)
     VALUES ($1, 'intake', $2, $2, $3, $4, $5, NOW() + INTERVAL '${cfg.SESSION_TTL_HOURS} hours')
     RETURNING *`,
    [token, input.language, input.originalQuery, input.normalizedQuery, input.clientFingerprint],
  );

  if (!row) throw new Error('failed to create session');
  return toSession(row);
}

/**
 * Fetch by public token, refusing expired sessions.
 *
 * Returning null rather than an expired record means no caller can accidentally
 * keep working with a session past its TTL.
 */
export async function getSessionByToken(token: string): Promise<SessionRecord | null> {
  if (!token || token.length < 16) return null;
  const row = await sqlOne<Row>(
    `SELECT * FROM sessions WHERE public_token = $1 AND expires_at > NOW() LIMIT 1`,
    [token],
  );
  return row ? toSession(row) : null;
}

export async function updateSession(
  token: string,
  patch: Partial<{
    status: SessionStatus;
    detectedLanguage: Language;
    preferredLanguage: Language;
    serviceId: number | null;
    scenarioId: number | null;
    serviceConfidence: number | null;
    locationCity: string | null;
    locationProvince: string | null;
    readiness: ReadinessState;
    originalQuery: string | null;
    normalizedQuery: string | null;
  }>,
): Promise<SessionRecord | null> {
  const columns: Record<string, unknown> = {};
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.detectedLanguage !== undefined) columns.detected_language = patch.detectedLanguage;
  if (patch.preferredLanguage !== undefined) columns.preferred_language = patch.preferredLanguage;
  if (patch.serviceId !== undefined) columns.service_id = patch.serviceId;
  if (patch.scenarioId !== undefined) columns.scenario_id = patch.scenarioId;
  if (patch.serviceConfidence !== undefined) columns.service_confidence = patch.serviceConfidence;
  if (patch.locationCity !== undefined) columns.location_city = patch.locationCity;
  if (patch.locationProvince !== undefined) columns.location_province = patch.locationProvince;
  if (patch.readiness !== undefined) columns.readiness = patch.readiness;
  if (patch.originalQuery !== undefined) columns.original_query = patch.originalQuery;
  if (patch.normalizedQuery !== undefined) columns.normalized_query = patch.normalizedQuery;

  const entries = Object.entries(columns);
  if (entries.length === 0) return getSessionByToken(token);

  const assignments = entries.map(([col], i) => `${col} = $${i + 2}`).join(', ');
  const row = await sqlOne<Row>(
    `UPDATE sessions SET ${assignments} WHERE public_token = $1 AND expires_at > NOW() RETURNING *`,
    [token, ...entries.map(([, value]) => value)],
  );
  return row ? toSession(row) : null;
}

/**
 * Change the display language.
 *
 * Deliberately its own function that touches exactly one column. A citizen who
 * switches to Urdu halfway through keeps every answer, the resolved service and
 * the interview position — losing those is how this class of app abandons the
 * people it was built for.
 */
export async function setLanguage(token: string, language: Language): Promise<SessionRecord | null> {
  const row = await sqlOne<Row>(
    `UPDATE sessions SET preferred_language = $2 WHERE public_token = $1 AND expires_at > NOW() RETURNING *`,
    [token, language],
  );
  return row ? toSession(row) : null;
}

export async function incrementTurn(token: string): Promise<void> {
  await sql('UPDATE sessions SET turn_count = turn_count + 1 WHERE public_token = $1', [token]);
}

/* ── Answers ──────────────────────────────────────────────────────────── */

export async function getAnswers(sessionId: number): Promise<StoredAnswer[]> {
  const rows = await sql<Row>(
    `SELECT variable_code, value, origin, confidence, asked_at, answered_at
       FROM session_answers WHERE session_id = $1 ORDER BY answered_at`,
    [sessionId],
  );
  return rows.map((r) => ({
    variableCode: asString(r.variable_code),
    value: asJsonValue(r.value),
    origin: asString(r.origin, 'user') as AnswerOrigin,
    confidence: asNumber(r.confidence),
    askedAt: r.asked_at ? new Date(String(r.asked_at)).toISOString() : null,
    answeredAt: new Date(String(r.answered_at)).toISOString(),
  }));
}

/** Flatten stored answers into the map the rules engine consumes. */
export function toAnswerMap(answers: readonly StoredAnswer[]): AnswerMap {
  const map: AnswerMap = {};
  for (const answer of answers) map[answer.variableCode] = answer.value;
  return map;
}

/**
 * Record an answer.
 *
 * A citizen-stated answer always overwrites an inferred one. The reverse is
 * refused: a later extraction pass must never quietly overwrite something the
 * citizen explicitly told us, which is why the conflict clause checks origin.
 */
export async function saveAnswer(input: {
  sessionId: number;
  variableCode: string;
  value: AnswerValue;
  origin: AnswerOrigin;
  confidence?: number;
}): Promise<void> {
  await sql(
    `INSERT INTO session_answers (session_id, variable_code, value, origin, confidence, answered_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
     ON CONFLICT (session_id, variable_code) DO UPDATE
       SET value = EXCLUDED.value,
           origin = EXCLUDED.origin,
           confidence = EXCLUDED.confidence,
           answered_at = NOW()
     WHERE session_answers.origin <> 'user' OR EXCLUDED.origin = 'user'`,
    [
      input.sessionId,
      input.variableCode,
      JSON.stringify(input.value),
      input.origin,
      input.confidence ?? 1,
    ],
  );
}

export async function saveAnswers(
  sessionId: number,
  answers: ReadonlyArray<{ variableCode: string; value: AnswerValue; origin: AnswerOrigin; confidence?: number }>,
): Promise<void> {
  if (answers.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const answer of answers) {
      await tx.query(
        `INSERT INTO session_answers (session_id, variable_code, value, origin, confidence, answered_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
         ON CONFLICT (session_id, variable_code) DO UPDATE
           SET value = EXCLUDED.value, origin = EXCLUDED.origin,
               confidence = EXCLUDED.confidence, answered_at = NOW()
         WHERE session_answers.origin <> 'user' OR EXCLUDED.origin = 'user'`,
        [sessionId, answer.variableCode, JSON.stringify(answer.value), answer.origin, answer.confidence ?? 1],
      );
    }
  });
}

export async function clearAnswer(sessionId: number, variableCode: string): Promise<void> {
  await sql('DELETE FROM session_answers WHERE session_id = $1 AND variable_code = $2', [
    sessionId,
    variableCode,
  ]);
}

/** Variable codes already put to the citizen, so the planner does not repeat one they skipped. */
export async function getAskedVariables(sessionId: number): Promise<string[]> {
  const rows = await sql<Row>(
    `SELECT DISTINCT variable_code FROM session_answers WHERE session_id = $1
      UNION
     SELECT DISTINCT (output_summary->>'variable') AS variable_code
       FROM agent_traces
      WHERE session_id = $1 AND agent = 'question_phrasing'
        AND output_summary->>'variable' IS NOT NULL`,
    [sessionId],
  );
  return rows.map((r) => asString(r.variable_code)).filter((v) => v.length > 0);
}

/* ── Plans ────────────────────────────────────────────────────────────── */

export async function savePlan(input: {
  sessionId: number;
  plan: unknown;
  readiness: unknown;
  evidence: unknown;
  groundingReport: unknown;
  language: Language;
}): Promise<number> {
  const row = await sqlOne<Row>(
    `INSERT INTO session_plans (session_id, version, plan, readiness, evidence, grounding_report, language)
     VALUES ($1,
             COALESCE((SELECT MAX(version) FROM session_plans WHERE session_id = $1), 0) + 1,
             $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)
     RETURNING version`,
    [
      input.sessionId,
      JSON.stringify(input.plan),
      JSON.stringify(input.readiness),
      JSON.stringify(input.evidence),
      JSON.stringify(input.groundingReport),
      input.language,
    ],
  );
  return asNumber(row?.version ?? 1);
}

export async function getLatestPlan(sessionId: number): Promise<{
  version: number;
  plan: unknown;
  readiness: unknown;
  evidence: unknown;
  groundingReport: unknown;
  language: Language;
  createdAt: string;
} | null> {
  const row = await sqlOne<Row>(
    `SELECT version, plan, readiness, evidence, grounding_report, language, created_at
       FROM session_plans WHERE session_id = $1 ORDER BY version DESC LIMIT 1`,
    [sessionId],
  );
  if (!row) return null;
  return {
    version: asNumber(row.version),
    plan: asJson(row.plan, null),
    readiness: asJson(row.readiness, null),
    evidence: asJson(row.evidence, []),
    groundingReport: asJson(row.grounding_report, {}),
    language: asString(row.language, 'en') as Language,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/* ── Housekeeping ─────────────────────────────────────────────────────── */

/**
 * Delete expired sessions and everything hanging off them.
 *
 * Cascades handle answers, plans, document checks and traces. This is the only
 * retention mechanism the system needs, because nothing sensitive is stored
 * outside a session in the first place.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await sql<Row>('DELETE FROM sessions WHERE expires_at < NOW() RETURNING id');
  return rows.length;
}
