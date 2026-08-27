/**
 * Knowledge-base queries.
 *
 * Every citizen-facing fact enters the application through this file. The
 * queries all LEFT JOIN `sources` and alias the provenance columns, because a
 * requirement without a source is not renderable — the UI has no trust badge
 * to show and the output verifier has nothing to trace a claim to.
 *
 * `loadServiceBundle` deliberately fetches the whole service in one round of
 * queries rather than lazily. The interview planner evaluates every rule
 * against several hypothetical answer sets to work out which question is worth
 * asking, and doing that against the database would turn one question into
 * dozens of queries and make the interview visibly slow.
 */
import { sql } from './client';
import { SOURCE_JOIN_COLUMNS, asNumber, asString, toDecisionVariable, toEligibilityRule, toExceptionRoute, toFee, toOffice, toProcedureStep, toProcessingTime, toRequirement, toScenario, toService } from './rows';
import type {
  DecisionVariable,
  Office,
  Service,
  ServiceBundle,
} from '@/lib/schemas/domain';
import type { Language } from '@/lib/schemas/core';

type Row = Record<string, unknown>;

const SERVICE_COLUMNS = `
  sv.id, sv.code, sv.department_id, sv.name_en, sv.name_ur, sv.name_roman_ur,
  sv.summary_en, sv.summary_ur, sv.summary_roman_ur, sv.category,
  sv.official_url, sv.online_application_url, sv.display_order, sv.is_active,
  sv.verification_status,
  d.name_en AS department_name,
  ${SOURCE_JOIN_COLUMNS}
`;

const SERVICE_FROM = `
  FROM services sv
  JOIN departments d ON d.id = sv.department_id
  LEFT JOIN sources s ON s.id = sv.source_id
`;

export async function listServices(): Promise<Service[]> {
  const rows = await sql<Row>(
    `SELECT ${SERVICE_COLUMNS} ${SERVICE_FROM}
      WHERE sv.is_active = TRUE
      ORDER BY sv.display_order, sv.id`,
  );
  return rows.map(toService);
}

export async function getServiceByCode(code: string): Promise<Service | null> {
  const rows = await sql<Row>(
    `SELECT ${SERVICE_COLUMNS} ${SERVICE_FROM} WHERE sv.code = $1 LIMIT 1`,
    [code],
  );
  const row = rows[0];
  return row ? toService(row) : null;
}

export async function getServiceById(id: number): Promise<Service | null> {
  const rows = await sql<Row>(`SELECT ${SERVICE_COLUMNS} ${SERVICE_FROM} WHERE sv.id = $1 LIMIT 1`, [id]);
  const row = rows[0];
  return row ? toService(row) : null;
}

/* ── Aliases ──────────────────────────────────────────────────────────── */

export interface ServiceAlias {
  serviceId: number;
  serviceCode: string;
  scenarioId: number | null;
  scenarioCode: string | null;
  alias: string;
  language: Language;
  weight: number;
}

/**
 * The deterministic multilingual matching surface.
 *
 * Loaded whole and matched in memory: the table is small (hundreds of rows),
 * the match is fuzzy token overlap rather than SQL equality, and doing it here
 * keeps the resolver testable without a database.
 */
export async function listServiceAliases(): Promise<ServiceAlias[]> {
  const rows = await sql<Row>(
    `SELECT a.service_id, sv.code AS service_code, a.scenario_id,
            sc.code AS scenario_code, a.alias, a.language, a.weight
       FROM service_aliases a
       JOIN services sv ON sv.id = a.service_id
       LEFT JOIN service_scenarios sc ON sc.id = a.scenario_id
      WHERE sv.is_active = TRUE`,
  );
  return rows.map((r) => ({
    serviceId: asNumber(r.service_id),
    serviceCode: asString(r.service_code),
    scenarioId: r.scenario_id === null || r.scenario_id === undefined ? null : asNumber(r.scenario_id),
    scenarioCode: r.scenario_code === null || r.scenario_code === undefined ? null : asString(r.scenario_code),
    alias: asString(r.alias),
    language: (asString(r.language, 'en') as Language) ?? 'en',
    weight: asNumber(r.weight) || 1,
  }));
}

/* ── Bundle ───────────────────────────────────────────────────────────── */

/**
 * Everything the engine needs about one service.
 *
 * Variables are fetched with `service_id IS NULL OR service_id = $1` so global
 * variables (city, province, applicant age) are shared across services instead
 * of duplicated per service and drifting apart.
 */
export async function loadServiceBundle(serviceId: number): Promise<ServiceBundle | null> {
  const service = await getServiceById(serviceId);
  if (!service) return null;

  const [scenarios, variables, rules, requirements, steps, fees, times, exceptions] = await Promise.all([
    sql<Row>(
      `SELECT sc.*, ${SOURCE_JOIN_COLUMNS}
         FROM service_scenarios sc LEFT JOIN sources s ON s.id = sc.source_id
        WHERE sc.service_id = $1 ORDER BY sc.priority, sc.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT * FROM decision_variables
        WHERE service_id IS NULL OR service_id = $1
        ORDER BY ask_priority, id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT r.*, ${SOURCE_JOIN_COLUMNS}
         FROM eligibility_rules r LEFT JOIN sources s ON s.id = r.source_id
        WHERE r.service_id = $1
          AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
          AND (r.effective_from IS NULL OR r.effective_from <= CURRENT_DATE)
          AND r.verification_status <> 'deprecated'
        ORDER BY r.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT r.*, ${SOURCE_JOIN_COLUMNS}
         FROM requirements r LEFT JOIN sources s ON s.id = r.source_id
        WHERE r.service_id = $1 AND r.verification_status <> 'deprecated'
        ORDER BY r.display_order, r.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT p.*, ${SOURCE_JOIN_COLUMNS}
         FROM procedure_steps p LEFT JOIN sources s ON s.id = p.source_id
        WHERE p.service_id = $1 AND p.verification_status <> 'deprecated'
        ORDER BY p.step_order, p.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT f.*, ${SOURCE_JOIN_COLUMNS}
         FROM fees f LEFT JOIN sources s ON s.id = f.source_id
        WHERE f.service_id = $1 AND f.verification_status <> 'deprecated'
        ORDER BY f.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT t.*, ${SOURCE_JOIN_COLUMNS}
         FROM processing_times t LEFT JOIN sources s ON s.id = t.source_id
        WHERE t.service_id = $1 AND t.verification_status <> 'deprecated'
        ORDER BY t.id`,
      [serviceId],
    ),
    sql<Row>(
      `SELECT e.*, ${SOURCE_JOIN_COLUMNS}
         FROM exception_routes e LEFT JOIN sources s ON s.id = e.source_id
        WHERE e.service_id = $1 AND e.verification_status <> 'deprecated'
        ORDER BY e.id`,
      [serviceId],
    ),
  ]);

  return {
    service,
    scenarios: scenarios.map(toScenario),
    variables: variables.map(toDecisionVariable),
    rules: rules.map(toEligibilityRule),
    requirements: requirements.map(toRequirement),
    steps: steps.map(toProcedureStep),
    fees: fees.map(toFee),
    processingTimes: times.map(toProcessingTime),
    exceptions: exceptions.map(toExceptionRoute),
  };
}

export async function loadServiceBundleByCode(code: string): Promise<ServiceBundle | null> {
  const service = await getServiceByCode(code);
  return service ? loadServiceBundle(service.id) : null;
}

/* ── Offices ──────────────────────────────────────────────────────────── */

export interface OfficeQuery {
  serviceId: number;
  city?: string | null;
  province?: string | null;
  limit?: number;
}

/**
 * Find offices for a service, nearest-by-administrative-match.
 *
 * Ranking is by locality specificity rather than distance, because we do not
 * ask citizens for coordinates and a city name is what they actually give us.
 * An exact city match beats a province match beats anything else.
 */
export async function findOffices({ serviceId, city, province, limit = 5 }: OfficeQuery): Promise<Office[]> {
  const rows = await sql<Row>(
    `SELECT o.*, ${SOURCE_JOIN_COLUMNS},
            CASE
              WHEN $2::text IS NOT NULL AND lower(o.city) = lower($2::text) THEN 0
              WHEN $3::text IS NOT NULL AND lower(o.province) = lower($3::text) THEN 1
              ELSE 2
            END AS locality_rank
       FROM offices o
       JOIN office_services os ON os.office_id = o.id
       LEFT JOIN sources s ON s.id = o.source_id
      WHERE os.service_id = $1
      ORDER BY locality_rank, o.name_en
      LIMIT $4`,
    [serviceId, city ?? null, province ?? null, limit],
  );
  return rows.map(toOffice);
}

/* ── Variables ────────────────────────────────────────────────────────── */

export async function getDecisionVariable(code: string): Promise<DecisionVariable | null> {
  const rows = await sql<Row>('SELECT * FROM decision_variables WHERE code = $1 LIMIT 1', [code]);
  const row = rows[0];
  return row ? toDecisionVariable(row) : null;
}

/* ── Provenance audit ─────────────────────────────────────────────────── */

export interface ProvenanceSummary {
  table: string;
  verificationStatus: string;
  count: number;
  withoutSource: number;
}

/**
 * Powers the /architecture page and the doctor script.
 *
 * Being able to show a judge the exact split of verified / unverified /
 * synthetic content, live, is worth more than claiming the data is good.
 */
export async function provenanceSummary(): Promise<ProvenanceSummary[]> {
  const rows = await sql<Row>(`
    SELECT 'requirements' AS table_name, verification_status,
           count(*)::int AS n, count(*) FILTER (WHERE source_id IS NULL)::int AS orphan
      FROM requirements GROUP BY 1,2
    UNION ALL
    SELECT 'procedure_steps', verification_status,
           count(*)::int, count(*) FILTER (WHERE source_id IS NULL)::int
      FROM procedure_steps GROUP BY 1,2
    UNION ALL
    SELECT 'eligibility_rules', verification_status,
           count(*)::int, count(*) FILTER (WHERE source_id IS NULL)::int
      FROM eligibility_rules GROUP BY 1,2
    UNION ALL
    SELECT 'fees', verification_status,
           count(*)::int, count(*) FILTER (WHERE source_id IS NULL)::int
      FROM fees GROUP BY 1,2
    UNION ALL
    SELECT 'offices', verification_status,
           count(*)::int, count(*) FILTER (WHERE source_id IS NULL)::int
      FROM offices GROUP BY 1,2
    ORDER BY 1, 2
  `);

  return rows.map((r) => ({
    table: asString(r.table_name),
    verificationStatus: asString(r.verification_status),
    count: asNumber(r.n),
    withoutSource: asNumber(r.orphan),
  }));
}
