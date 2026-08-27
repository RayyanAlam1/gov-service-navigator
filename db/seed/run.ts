/**
 * The seeder.
 *
 * Idempotent: every insert is an upsert keyed on the natural code, so running
 * it twice leaves the database in the same state. That matters because the seed
 * is how the knowledge base is *maintained*, not just initialised — editing a
 * requirement in db/seed/ and re-running is the intended workflow.
 *
 * The seeder enforces the provenance rule in code, not just in review: an
 * insert that would create a citizen-facing fact without a `source_id` throws
 * before it can reach the database.
 *
 * Exported as a function rather than living in the CLI so that integration
 * tests seed exactly what production seeds, instead of a hand-built fixture
 * that drifts away from the real knowledge base.
 */
import { createHash } from 'node:crypto';
import { getConfig } from '@/lib/config/env';
import { getDb, sql, toVectorLiteral, type SqlExecutor } from '@/lib/db/client';
import { runMigrations } from '@/lib/db/migrate';
import { getEmbeddingProvider } from '@/lib/embeddings';
import { chunkText } from '@/lib/rag/chunk';

import { SOURCES } from './sources';
import { DEPARTMENTS, OFFICES } from './offices';
import { VARIABLES } from './variables';
import { CNIC_SERVICE } from './cnic';
import { PASSPORT_SERVICE } from './passport';
import { DOMICILE_SERVICE } from './domicile';
import { CORPUS } from './corpus';
import type { Localized, SeedCondition, SeedService } from './types';

const SERVICES: SeedService[] = [CNIC_SERVICE, PASSPORT_SERVICE, DOMICILE_SERVICE];

export interface SeedOptions {
  /** Delete existing knowledge rows before inserting. Sessions are untouched. */
  fresh?: boolean;
  /** Skip embedding generation. Fast, but retrieval will have no vector arm. */
  skipEmbed?: boolean;
  /** Progress reporter. Defaults to silence so tests stay quiet. */
  log?: (message: string) => void;
}

export interface SeedSummary {
  sources: number;
  departments: number;
  services: number;
  variables: number;
  offices: number;
  documents: number;
  chunks: number;
  embedded: number;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

const loc = (l: Localized) => [l.en, l.ur ?? null, l.roman_ur ?? null] as const;
const cond = (c: SeedCondition | undefined) => JSON.stringify(c ?? { op: 'always' });

let sourceIds = new Map<string, number>();
let serviceIds = new Map<string, number>();
let scenarioIds = new Map<string, number>();
let departmentIds = new Map<string, number>();

/**
 * Resolve a source code to its id, refusing to proceed without one.
 *
 * This is the code-level enforcement of the architecture's central rule: a
 * requirement, step, rule or fee that cannot name its source must not exist,
 * because the UI would have no trust signal to render and the output verifier
 * would have nothing to trace a claim back to.
 */
function requireSource(code: string, context: string): number {
  const id = sourceIds.get(code);
  if (id === undefined) {
    throw new Error(
      `${context}: unknown source '${code}'. Every citizen-facing fact must reference a row in db/seed/sources.ts.`,
    );
  }
  return id;
}

function requireService(code: string): number {
  const id = serviceIds.get(code);
  if (id === undefined) throw new Error(`unknown service '${code}'`);
  return id;
}

function scenarioKey(serviceCode: string, scenarioCode: string): string {
  return `${serviceCode}:${scenarioCode}`;
}

function optionalScenario(serviceCode: string, scenarioCode: string | null | undefined): number | null {
  if (!scenarioCode) return null;
  const id = scenarioIds.get(scenarioKey(serviceCode, scenarioCode));
  if (id === undefined) {
    throw new Error(`unknown scenario '${scenarioCode}' for service '${serviceCode}'`);
  }
  return id;
}

/* ── steps ────────────────────────────────────────────────────────────── */

async function clearKnowledge(tx: SqlExecutor): Promise<void> {
  // Order matters: children before parents. Sessions are left alone — a reseed
  // should not destroy an in-flight demo.
  for (const table of [
    'document_chunks', 'documents', 'exception_routes', 'office_services', 'offices',
    'processing_times', 'fees', 'procedure_steps', 'requirements', 'eligibility_rules',
    'service_aliases', 'service_scenarios', 'decision_variables', 'services',
    'departments', 'sources',
  ]) {
    await tx.query(`DELETE FROM ${table}`);
  }
}

async function seedSources(tx: SqlExecutor): Promise<void> {
  for (const source of SOURCES) {
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO sources (code, title, publisher, url, doc_type, language,
                            retrieved_at, last_verified, verification_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6, NOW(), $7, $8, $9)
       ON CONFLICT (code) DO UPDATE SET
         title = EXCLUDED.title, publisher = EXCLUDED.publisher, url = EXCLUDED.url,
         doc_type = EXCLUDED.doc_type, language = EXCLUDED.language,
         last_verified = EXCLUDED.last_verified,
         verification_status = EXCLUDED.verification_status, notes = EXCLUDED.notes
       RETURNING id`,
      [
        source.code, source.title, source.publisher, source.url, source.docType,
        source.language, source.lastVerified, source.verification, source.notes,
      ],
    );
    const id = rows.rows[0]?.id;
    if (id !== undefined) sourceIds.set(source.code, id);
  }
}

async function seedDepartments(tx: SqlExecutor): Promise<void> {
  for (const dept of DEPARTMENTS) {
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO departments (code, name_en, name_ur, short_name, jurisdiction, province, website, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET
         name_en = EXCLUDED.name_en, name_ur = EXCLUDED.name_ur,
         short_name = EXCLUDED.short_name, jurisdiction = EXCLUDED.jurisdiction,
         website = EXCLUDED.website, source_id = EXCLUDED.source_id
       RETURNING id`,
      [
        dept.code, dept.nameEn, dept.nameUr ?? null, dept.shortName ?? null,
        dept.jurisdiction, dept.province ?? null, dept.website ?? null,
        dept.sourceCode ? requireSource(dept.sourceCode, `department ${dept.code}`) : null,
      ],
    );
    const id = rows.rows[0]?.id;
    if (id !== undefined) departmentIds.set(dept.code, id);
  }
}

async function seedVariables(tx: SqlExecutor): Promise<void> {
  for (const v of VARIABLES) {
    const [promptEn, promptUr, promptRoman] = loc(v.prompt);
    const [helpEn, helpUr, helpRoman] = v.help ? loc(v.help) : [null, null, null];

    const options = (v.options ?? []).map((o) => ({
      value: o.value,
      label_en: o.label.en,
      label_ur: o.label.ur ?? null,
      label_roman_ur: o.label.roman_ur ?? null,
    }));

    await tx.query(
      `INSERT INTO decision_variables
         (code, service_id, var_type, prompt_en, prompt_ur, prompt_roman_ur,
          help_en, help_ur, help_roman_ur, options, ask_priority, is_sensitive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       ON CONFLICT (code) DO UPDATE SET
         service_id = EXCLUDED.service_id, var_type = EXCLUDED.var_type,
         prompt_en = EXCLUDED.prompt_en, prompt_ur = EXCLUDED.prompt_ur,
         prompt_roman_ur = EXCLUDED.prompt_roman_ur, help_en = EXCLUDED.help_en,
         help_ur = EXCLUDED.help_ur, help_roman_ur = EXCLUDED.help_roman_ur,
         options = EXCLUDED.options, ask_priority = EXCLUDED.ask_priority,
         is_sensitive = EXCLUDED.is_sensitive`,
      [
        v.code, v.serviceCode ? requireService(v.serviceCode) : null, v.type,
        promptEn, promptUr, promptRoman, helpEn, helpUr, helpRoman,
        JSON.stringify(options), v.askPriority, v.isSensitive ?? false,
      ],
    );
  }
}

async function seedService(tx: SqlExecutor, service: SeedService): Promise<void> {
  const departmentId = departmentIds.get(service.departmentCode);
  if (departmentId === undefined) throw new Error(`unknown department '${service.departmentCode}'`);

  const [nameEn, nameUr, nameRoman] = loc(service.name);
  const [summaryEn, summaryUr, summaryRoman] = loc(service.summary);

  const inserted = await tx.query<{ id: number }>(
    `INSERT INTO services
       (code, department_id, name_en, name_ur, name_roman_ur,
        summary_en, summary_ur, summary_roman_ur, category,
        official_url, online_application_url, display_order, is_active,
        source_id, verification_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14)
     ON CONFLICT (code) DO UPDATE SET
       department_id = EXCLUDED.department_id, name_en = EXCLUDED.name_en,
       name_ur = EXCLUDED.name_ur, name_roman_ur = EXCLUDED.name_roman_ur,
       summary_en = EXCLUDED.summary_en, summary_ur = EXCLUDED.summary_ur,
       summary_roman_ur = EXCLUDED.summary_roman_ur, category = EXCLUDED.category,
       official_url = EXCLUDED.official_url,
       online_application_url = EXCLUDED.online_application_url,
       display_order = EXCLUDED.display_order, source_id = EXCLUDED.source_id,
       verification_status = EXCLUDED.verification_status
     RETURNING id`,
    [
      service.code, departmentId, nameEn, nameUr, nameRoman,
      summaryEn, summaryUr, summaryRoman, service.category,
      service.officialUrl, service.onlineApplicationUrl, service.displayOrder,
      requireSource(service.sourceCode, `service ${service.code}`), service.verification,
    ],
  );

  const serviceId = inserted.rows[0]?.id;
  if (serviceId === undefined) throw new Error(`failed to insert service '${service.code}'`);
  serviceIds.set(service.code, serviceId);

  // ── scenarios ──
  for (const scenario of service.scenarios) {
    const [sNameEn, sNameUr, sNameRoman] = loc(scenario.name);
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO service_scenarios
         (service_id, code, name_en, name_ur, name_roman_ur, description_en,
          selector, priority, is_exception_path, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
       ON CONFLICT (service_id, code) DO UPDATE SET
         name_en = EXCLUDED.name_en, name_ur = EXCLUDED.name_ur,
         name_roman_ur = EXCLUDED.name_roman_ur, description_en = EXCLUDED.description_en,
         selector = EXCLUDED.selector, priority = EXCLUDED.priority,
         is_exception_path = EXCLUDED.is_exception_path, source_id = EXCLUDED.source_id,
         verification_status = EXCLUDED.verification_status
       RETURNING id`,
      [
        serviceId, scenario.code, sNameEn, sNameUr, sNameRoman,
        scenario.descriptionEn ?? null, cond(scenario.selector), scenario.priority,
        scenario.isExceptionPath ?? false,
        requireSource(scenario.sourceCode, `scenario ${service.code}/${scenario.code}`),
        scenario.verification,
      ],
    );
    const id = rows.rows[0]?.id;
    if (id !== undefined) scenarioIds.set(scenarioKey(service.code, scenario.code), id);
  }

  // ── aliases ──
  await tx.query('DELETE FROM service_aliases WHERE service_id = $1', [serviceId]);
  for (const alias of service.aliases) {
    await tx.query(
      `INSERT INTO service_aliases (service_id, scenario_id, alias, language, weight)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        serviceId,
        optionalScenario(service.code, alias.scenario),
        alias.alias,
        alias.language,
        alias.weight ?? 1,
      ],
    );
  }

  // ── rules ──
  for (const rule of service.rules) {
    const [stEn, stUr, stRoman] = loc(rule.statement);
    await tx.query(
      `INSERT INTO eligibility_rules
         (service_id, scenario_id, code, statement_en, statement_ur, statement_roman_ur,
          condition, outcome, failure_message_en, remedy_en, severity, version,
          source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,1,$12,$13)
       ON CONFLICT (service_id, code, version) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, statement_en = EXCLUDED.statement_en,
         statement_ur = EXCLUDED.statement_ur, statement_roman_ur = EXCLUDED.statement_roman_ur,
         condition = EXCLUDED.condition, outcome = EXCLUDED.outcome,
         failure_message_en = EXCLUDED.failure_message_en, remedy_en = EXCLUDED.remedy_en,
         severity = EXCLUDED.severity, source_id = EXCLUDED.source_id,
         verification_status = EXCLUDED.verification_status`,
      [
        serviceId, optionalScenario(service.code, rule.scenario), rule.code,
        stEn, stUr, stRoman, cond(rule.condition), rule.outcome,
        rule.failureMessageEn ?? null, rule.remedyEn ?? null, rule.severity ?? 'blocking',
        requireSource(rule.sourceCode, `rule ${service.code}/${rule.code}`), rule.verification,
      ],
    );
  }

  // ── requirements ──
  for (const req of service.requirements) {
    const [tEn, tUr, tRoman] = loc(req.title);
    await tx.query(
      `INSERT INTO requirements
         (service_id, scenario_id, code, document_type, title_en, title_ur, title_roman_ur,
          description_en, is_mandatory, applies_when, copies_required, must_be_original,
          substitutes, obtain_from, obtain_service_code, display_order, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
       ON CONFLICT (service_id, code) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, document_type = EXCLUDED.document_type,
         title_en = EXCLUDED.title_en, title_ur = EXCLUDED.title_ur,
         title_roman_ur = EXCLUDED.title_roman_ur, description_en = EXCLUDED.description_en,
         is_mandatory = EXCLUDED.is_mandatory, applies_when = EXCLUDED.applies_when,
         copies_required = EXCLUDED.copies_required, must_be_original = EXCLUDED.must_be_original,
         substitutes = EXCLUDED.substitutes, obtain_from = EXCLUDED.obtain_from,
         obtain_service_code = EXCLUDED.obtain_service_code, display_order = EXCLUDED.display_order,
         source_id = EXCLUDED.source_id, verification_status = EXCLUDED.verification_status`,
      [
        serviceId, optionalScenario(service.code, req.scenario), req.code, req.documentType,
        tEn, tUr, tRoman, req.descriptionEn ?? null, req.isMandatory, cond(req.appliesWhen),
        req.copiesRequired ?? null, req.mustBeOriginal ?? false,
        JSON.stringify(req.substitutes ?? []), req.obtainFrom ?? null,
        req.obtainServiceCode ?? null, req.displayOrder,
        requireSource(req.sourceCode, `requirement ${service.code}/${req.code}`), req.verification,
      ],
    );
  }

  // ── steps ──
  for (const step of service.steps) {
    const [tEn, tUr, tRoman] = loc(step.title);
    const [iEn, iUr, iRoman] = loc(step.instruction);
    await tx.query(
      `INSERT INTO procedure_steps
         (service_id, scenario_id, code, step_order, title_en, title_ur, title_roman_ur,
          instruction_en, instruction_ur, instruction_roman_ur, channel, applies_when,
          action_url, estimated_duration, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
       ON CONFLICT (service_id, code) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, step_order = EXCLUDED.step_order,
         title_en = EXCLUDED.title_en, title_ur = EXCLUDED.title_ur,
         title_roman_ur = EXCLUDED.title_roman_ur, instruction_en = EXCLUDED.instruction_en,
         instruction_ur = EXCLUDED.instruction_ur, instruction_roman_ur = EXCLUDED.instruction_roman_ur,
         channel = EXCLUDED.channel, applies_when = EXCLUDED.applies_when,
         action_url = EXCLUDED.action_url, estimated_duration = EXCLUDED.estimated_duration,
         source_id = EXCLUDED.source_id, verification_status = EXCLUDED.verification_status`,
      [
        serviceId, optionalScenario(service.code, step.scenario), step.code, step.order,
        tEn, tUr, tRoman, iEn, iUr, iRoman, step.channel, cond(step.appliesWhen),
        step.actionUrl ?? null, step.estimatedDuration ?? null,
        requireSource(step.sourceCode, `step ${service.code}/${step.code}`), step.verification,
      ],
    );
  }

  // ── fees ──
  for (const fee of service.fees) {
    const [lEn, lUr] = loc(fee.label);
    await tx.query(
      `INSERT INTO fees
         (service_id, scenario_id, code, category, label_en, label_ur, amount_minor,
          currency, applies_when, note_en, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
       ON CONFLICT (service_id, code) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, category = EXCLUDED.category,
         label_en = EXCLUDED.label_en, label_ur = EXCLUDED.label_ur,
         amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
         applies_when = EXCLUDED.applies_when, note_en = EXCLUDED.note_en,
         source_id = EXCLUDED.source_id, verification_status = EXCLUDED.verification_status`,
      [
        serviceId, optionalScenario(service.code, fee.scenario), fee.code, fee.category,
        lEn, lUr, fee.amountMinor, fee.currency ?? 'PKR', cond(fee.appliesWhen),
        fee.noteEn ?? null,
        requireSource(fee.sourceCode, `fee ${service.code}/${fee.code}`), fee.verification,
      ],
    );
  }

  // ── processing times ──
  for (const time of service.processingTimes) {
    await tx.query(
      `INSERT INTO processing_times
         (service_id, scenario_id, code, category, label_en, min_days, max_days,
          applies_when, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (service_id, code) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, category = EXCLUDED.category,
         label_en = EXCLUDED.label_en, min_days = EXCLUDED.min_days,
         max_days = EXCLUDED.max_days, applies_when = EXCLUDED.applies_when,
         source_id = EXCLUDED.source_id, verification_status = EXCLUDED.verification_status`,
      [
        serviceId, optionalScenario(service.code, time.scenario), time.code, time.category,
        time.labelEn, time.minDays, time.maxDays, cond(time.appliesWhen),
        requireSource(time.sourceCode, `processing time ${service.code}/${time.code}`),
        time.verification,
      ],
    );
  }

  // ── exceptions ──
  for (const exception of service.exceptions) {
    const [nEn, nUr] = loc(exception.name);
    const [gEn, gUr] = loc(exception.guidance);
    await tx.query(
      `INSERT INTO exception_routes
         (service_id, code, name_en, name_ur, trigger_condition, guidance_en, guidance_ur,
          extra_requirement_codes, extra_step_codes, escalate_to_office, source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       ON CONFLICT (service_id, code) DO UPDATE SET
         name_en = EXCLUDED.name_en, name_ur = EXCLUDED.name_ur,
         trigger_condition = EXCLUDED.trigger_condition, guidance_en = EXCLUDED.guidance_en,
         guidance_ur = EXCLUDED.guidance_ur,
         extra_requirement_codes = EXCLUDED.extra_requirement_codes,
         extra_step_codes = EXCLUDED.extra_step_codes,
         escalate_to_office = EXCLUDED.escalate_to_office, source_id = EXCLUDED.source_id,
         verification_status = EXCLUDED.verification_status`,
      [
        serviceId, exception.code, nEn, nUr, cond(exception.trigger), gEn, gUr,
        JSON.stringify(exception.extraRequirementCodes ?? []),
        JSON.stringify(exception.extraStepCodes ?? []),
        exception.escalateToOffice ?? false,
        requireSource(exception.sourceCode, `exception ${service.code}/${exception.code}`),
        exception.verification,
      ],
    );
  }
}

async function seedOffices(tx: SqlExecutor): Promise<void> {
  for (const office of OFFICES) {
    const departmentId = departmentIds.get(office.departmentCode);
    if (departmentId === undefined) throw new Error(`unknown department '${office.departmentCode}'`);

    const [nEn, nUr] = loc(office.name);
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO offices
         (code, department_id, name_en, name_ur, office_type, address_en, city, district,
          province, latitude, longitude, phone, email, hours_en, appointment_url,
          source_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (code) DO UPDATE SET
         name_en = EXCLUDED.name_en, name_ur = EXCLUDED.name_ur,
         office_type = EXCLUDED.office_type, address_en = EXCLUDED.address_en,
         city = EXCLUDED.city, district = EXCLUDED.district, province = EXCLUDED.province,
         phone = EXCLUDED.phone, hours_en = EXCLUDED.hours_en,
         appointment_url = EXCLUDED.appointment_url, source_id = EXCLUDED.source_id,
         verification_status = EXCLUDED.verification_status
       RETURNING id`,
      [
        office.code, departmentId, nEn, nUr, office.officeType, office.addressEn,
        office.city, office.district ?? null, office.province,
        office.latitude ?? null, office.longitude ?? null, office.phone ?? null,
        office.email ?? null, office.hoursEn ?? null, office.appointmentUrl ?? null,
        requireSource(office.sourceCode, `office ${office.code}`), office.verification,
      ],
    );

    const officeId = rows.rows[0]?.id;
    if (officeId === undefined) continue;

    for (const serviceCode of office.serviceCodes) {
      await tx.query(
        `INSERT INTO office_services (office_id, service_id) VALUES ($1,$2)
         ON CONFLICT (office_id, service_id) DO NOTHING`,
        [officeId, requireService(serviceCode)],
      );
    }
  }
}

/* ── corpus ───────────────────────────────────────────────────────────── */

async function seedCorpus(skipEmbed: boolean): Promise<{ documents: number; chunks: number; embedded: number }> {
  const provider = getEmbeddingProvider();
  let documents = 0;
  let chunks = 0;
  let embedded = 0;

  for (const doc of CORPUS) {
    const sourceId = requireSource(doc.sourceCode, `document '${doc.title}'`);
    const serviceId = doc.serviceCode ? requireService(doc.serviceCode) : null;
    const hash = createHash('sha256').update(doc.body).digest('hex');
    const pieces = chunkText(doc.body);

    const inserted = await sql<{ id: number }>(
      `INSERT INTO documents (source_id, service_id, title, language, raw_text_hash, char_count, chunk_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (source_id, raw_text_hash) DO UPDATE SET
         title = EXCLUDED.title, chunk_count = EXCLUDED.chunk_count
       RETURNING id`,
      [sourceId, serviceId, doc.title, doc.language, hash, doc.body.length, pieces.length],
    );

    const documentId = inserted[0]?.id;
    if (documentId === undefined) continue;
    documents += 1;

    await sql('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);

    const vectors = skipEmbed
      ? pieces.map(() => null)
      : await provider.embedPassages(pieces.map((p) => p.content));

    for (const [index, piece] of pieces.entries()) {
      const vector = vectors[index] ?? null;
      await sql(
        `INSERT INTO document_chunks
           (document_id, source_id, service_id, scenario_code, chunk_index, heading_path,
            content, content_norm, language, token_estimate, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${vector ? '$11::vector' : 'NULL'},${vector ? '$12' : 'NULL'})`,
        vector
          ? [
              documentId, sourceId, serviceId, doc.scenarioCode ?? null, piece.index,
              piece.headingPath, piece.content, piece.contentNorm, doc.language,
              piece.tokenEstimate, toVectorLiteral(vector), provider.model,
            ]
          : [
              documentId, sourceId, serviceId, doc.scenarioCode ?? null, piece.index,
              piece.headingPath, piece.content, piece.contentNorm, doc.language,
              piece.tokenEstimate,
            ],
      );
      chunks += 1;
      if (vector) embedded += 1;
    }
  }

  return { documents, chunks, embedded };
}

/* ── entry point ──────────────────────────────────────────────────────── */

export async function runSeed(options: SeedOptions = {}): Promise<SeedSummary> {
  const { fresh = false, skipEmbed = false, log = () => undefined } = options;
  const cfg = getConfig();

  log(`▸ seeding  driver=${cfg.DB_DRIVER}  embeddings=${cfg.EMBEDDING_PROVIDER}@${cfg.EMBEDDING_DIM}d`);

  // Migrations are idempotent, so seeding a completely fresh database is one
  // command rather than two that must be run in the right order.
  await runMigrations();

  const db = await getDb();

  await db.transaction(async (tx) => {
    if (fresh) {
      log('  · --fresh: clearing knowledge tables');
      await clearKnowledge(tx);
      sourceIds = new Map();
      serviceIds = new Map();
      scenarioIds = new Map();
      departmentIds = new Map();
    }

    await seedSources(tx);
    log(`  ✓ ${SOURCES.length} sources`);

    await seedDepartments(tx);
    log(`  ✓ ${DEPARTMENTS.length} departments`);

    for (const service of SERVICES) {
      await seedService(tx, service);
      log(
        `  ✓ ${service.code}: ${service.scenarios.length} scenarios, ` +
          `${service.requirements.length} requirements, ${service.steps.length} steps, ` +
          `${service.rules.length} rules, ${service.exceptions.length} exceptions`,
      );
    }

    // Variables may be scoped to a service, so they come after services exist.
    await seedVariables(tx);
    log(`  ✓ ${VARIABLES.length} decision variables`);

    await seedOffices(tx);
    log(`  ✓ ${OFFICES.length} offices (synthetic — see db/seed/offices.ts)`);
  });

  const corpus = await seedCorpus(skipEmbed);
  log(
    `  ✓ corpus: ${corpus.documents} documents, ${corpus.chunks} chunks, ` +
      `${corpus.embedded} embedded${skipEmbed ? ' (--no-embed)' : ''}`,
  );

  await assertNoOrphanFacts();

  return {
    sources: SOURCES.length,
    departments: DEPARTMENTS.length,
    services: SERVICES.length,
    variables: VARIABLES.length,
    offices: OFFICES.length,
    ...corpus,
  };
}

/**
 * Refuse to finish if any citizen-facing fact lacks a source.
 *
 * `requireSource` already throws at insert time; this is the belt-and-braces
 * check against a row that reached the table by some other path.
 */
async function assertNoOrphanFacts(): Promise<void> {
  const [audit] = await sql<{ orphans: number }>(`
    SELECT (
      (SELECT count(*) FROM requirements WHERE source_id IS NULL) +
      (SELECT count(*) FROM procedure_steps WHERE source_id IS NULL) +
      (SELECT count(*) FROM eligibility_rules WHERE source_id IS NULL) +
      (SELECT count(*) FROM fees WHERE source_id IS NULL)
    )::int AS orphans
  `);
  if ((audit?.orphans ?? 0) > 0) {
    throw new Error(
      `${audit?.orphans} citizen-facing fact(s) have no source_id. This must never ship.`,
    );
  }
}
