/**
 * Agentic retrieval.
 *
 * A single embedding of the citizen's raw sentence is a weak query. It is in
 * the wrong language half the time, it is phrased as a personal situation
 * ("mera CNIC gum hogya") rather than as the topic of a document ("procedure
 * for replacement of a lost national identity card"), and it bundles several
 * information needs into one string.
 *
 * So retrieval is a loop rather than a call:
 *
 *   1. Plan      expand the situation into several targeted queries, across
 *                languages, one per information need.
 *   2. Retrieve  hybrid search per query, fused.
 *   3. Assess    is this actually enough to support the claims we need to make?
 *   4. Re-query  if not, and budget remains, ask a differently-shaped question.
 *
 * The assessment step is what makes this more than a fan-out. It has a real
 * negative outcome: "we do not have this documented" is a legitimate, shippable
 * answer that routes the citizen to the office with its source, and it is
 * strictly better than assembling a confident answer out of loosely related
 * text.
 *
 * Query planning uses the model (with a deterministic template fallback).
 * Sufficiency assessment is deterministic — coverage is measured against the
 * information needs the rules engine actually has, not judged by a model.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config/env';
import { jsonSchemaOf, type TurnContext } from '@/lib/agents/base';
import { generateStructured } from '@/lib/llm/client';
import { tokenize } from '@/lib/i18n/normalize';
import type { Language } from '@/lib/schemas/core';
import type { EvidenceChunk } from '@/lib/schemas/domain';
import { hybridSearch, type RetrievalFilters } from './retrieve';

/* ── Query planning ───────────────────────────────────────────────────── */

export const QueryPlanSchema = z.object({
  queries: z
    .array(
      z.object({
        text: z.string().min(3).max(200),
        language: z.enum(['en', 'ur', 'roman_ur']),
        /** What this query is trying to find, for the trace panel. */
        intent: z.string().max(80),
      }),
    )
    .min(1)
    .max(6),
});

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

const QUERY_PLAN_JSON_SCHEMA = jsonSchemaOf(QueryPlanSchema, 'QueryPlan');

/**
 * The information needs the downstream pipeline actually has.
 *
 * Coverage is measured against these rather than against a vague notion of
 * relevance, which is what lets the sufficiency check be deterministic.
 */
export type InformationNeed =
  | 'procedure'
  | 'documents'
  | 'eligibility'
  | 'fees'
  | 'processing_time'
  | 'office'
  | 'exception';

const NEED_VOCABULARY: Readonly<Record<InformationNeed, readonly string[]>> = {
  procedure: ['procedure', 'process', 'step', 'steps', 'apply', 'application', 'submit', 'tarika', 'darkhast'],
  documents: ['document', 'documents', 'required', 'requirement', 'attach', 'copy', 'copies', 'form', 'dastavez', 'kaghaz'],
  eligibility: ['eligible', 'eligibility', 'qualify', 'condition', 'criteria', 'age', 'resident', 'residence'],
  fees: ['fee', 'fees', 'charge', 'charges', 'cost', 'payment', 'rupees', 'pkr'],
  processing_time: ['days', 'time', 'duration', 'processing', 'delivery', 'urgent', 'normal', 'executive'],
  office: ['office', 'centre', 'center', 'branch', 'location', 'address', 'daftar', 'nadra', 'appointment'],
  exception: ['lost', 'stolen', 'damaged', 'mismatch', 'different', 'missing', 'exception', 'special', 'affidavit', 'fir'],
};

function deterministicQueryPlan(
  situation: string,
  serviceName: string,
  scenarioName: string | null,
  needs: readonly InformationNeed[],
  language: Language,
): QueryPlan {
  const subject = scenarioName ? `${serviceName} — ${scenarioName}` : serviceName;

  const templates: Record<InformationNeed, string> = {
    procedure: `${subject} procedure and steps to apply`,
    documents: `${subject} required documents checklist`,
    eligibility: `${subject} eligibility conditions and criteria`,
    fees: `${subject} fee schedule and charges`,
    processing_time: `${subject} processing time and delivery`,
    office: `${subject} office locations and appointment`,
    exception: `${subject} special cases and exceptions`,
  };

  const queries: QueryPlan['queries'] = needs.slice(0, 4).map((need) => ({
    text: templates[need],
    language: 'en' as const,
    intent: need,
  }));

  // Always keep the citizen's own words as one arm: it is the only query that
  // preserves the exact phrasing the corpus might share.
  queries.unshift({ text: situation.slice(0, 200), language, intent: 'citizen wording' });

  return { queries: queries.slice(0, 5) };
}

export interface PlanQueriesInput {
  situation: string;
  serviceName: string;
  scenarioName: string | null;
  needs: readonly InformationNeed[];
  language: Language;
}

export async function planQueries(
  input: PlanQueriesInput,
  context: TurnContext,
): Promise<{ plan: QueryPlan; deterministic: boolean }> {
  const cfg = getConfig();
  const started = Date.now();

  if (cfg.RAG_MAX_QUERY_EXPANSIONS === 0) {
    const plan: QueryPlan = {
      queries: [{ text: input.situation, language: input.language, intent: 'citizen wording' }],
    };
    return { plan, deterministic: true };
  }

  const fallback = () =>
    deterministicQueryPlan(
      input.situation,
      input.serviceName,
      input.scenarioName,
      input.needs,
      input.language,
    );

  let fallbackReason: string | null = null;

  const result = await generateStructured(
    {
      kind: 'rag.plan_queries',
      messages: [
        {
          role: 'system',
          content: [
            'You turn a citizen\'s personal situation into search queries against a corpus of',
            'official Pakistani government documents.',
            '',
            'The corpus is written in formal, institutional language. The citizen is not. Your job',
            'is to bridge that gap.',
            '',
            'Rules:',
            '- Write queries the way an official notification would phrase the topic, not the way',
            '  the citizen phrased their problem.',
            '- One query per information need. Do not bundle.',
            '- Include at least one query in English even if the citizen wrote in Urdu or Roman',
            '  Urdu, because most of the corpus is English.',
            '- Do not invent document names, form numbers or office names. Use only what the',
            '  service and scenario names give you.',
            `- Return between 1 and ${Math.min(6, cfg.RAG_MAX_QUERY_EXPANSIONS + 2)} queries.`,
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Service: ${input.serviceName}`,
            `Scenario: ${input.scenarioName ?? 'not yet determined'}`,
            `Information needed: ${input.needs.join(', ')}`,
            `Citizen's situation (${input.language}): "${input.situation}"`,
          ].join('\n'),
        },
      ],
      schema: QueryPlanSchema,
      jsonSchema: QUERY_PLAN_JSON_SCHEMA,
      tier: 'fast',
    },
    fallback,
    { onFallback: (reason) => { fallbackReason = reason; } },
  );

  const plan: QueryPlan = {
    queries: result.data.queries.slice(0, Math.max(1, cfg.RAG_MAX_QUERY_EXPANSIONS + 2)),
  };

  context.record({
    agent: 'retrieval',
    stage: 'official_retrieval',
    deterministic: result.provider === 'mock',
    status: result.provider === 'mock' ? 'degraded' : result.cached ? 'cache_hit' : 'ok',
    provider: result.provider,
    model: result.model,
    input: { situation: input.situation, needs: [...input.needs] },
    output: { queries: plan.queries.map((q) => `[${q.language}] ${q.text}`) },
    notes: fallbackReason ? `template query plan: ${fallbackReason}` : null,
    latencyMs: Date.now() - started,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
  });

  return { plan, deterministic: result.provider === 'mock' };
}

/* ── Sufficiency ──────────────────────────────────────────────────────── */

export interface SufficiencyReport {
  sufficient: boolean;
  /** Needs with at least one supporting chunk. */
  covered: InformationNeed[];
  /** Needs with nothing above the evidence floor. */
  uncovered: InformationNeed[];
  /** 0..1 share of needs covered. */
  coverage: number;
  /** Citizen-facing caveats for whatever could not be verified. */
  caveats: string[];
}

const NEED_LABELS: Readonly<Record<InformationNeed, string>> = {
  procedure: 'the step-by-step procedure',
  documents: 'the required documents',
  eligibility: 'the eligibility conditions',
  fees: 'the current fee',
  processing_time: 'the processing time',
  office: 'the office to visit',
  exception: 'guidance for your specific situation',
};

/**
 * Does the retrieved evidence actually cover what we need to say?
 *
 * Deterministic on purpose. Asking a model "is this evidence sufficient?" and
 * believing the answer reintroduces the failure mode the whole architecture
 * exists to prevent — and it is the answer most likely to be optimistic,
 * because models are agreeable.
 *
 * Two thresholds, for two different questions:
 *
 *   RAG_MIN_SIMILARITY         is this chunk worth showing as evidence?
 *   RAG_SUFFICIENCY_SIMILARITY do we have enough to claim this topic is
 *                              documented at all?
 *
 * The second is strictly higher, and that is the important one. Including a
 * loosely-related chunk as context is cheap; asserting "yes, we have official
 * guidance on the fee" when we do not is what puts a wrong number in front of a
 * citizen. Both are model-specific — `npm run probe` re-derives them, because
 * e5-family models compress cosine similarity into a narrow high band where a
 * threshold borrowed from another model filters nothing.
 *
 * `score` is deliberately not used here: it is rank-normalised, so the top
 * chunk always scores 1.0 no matter how irrelevant it is. Absolute similarity
 * is the only signal that can distinguish "best of a bad set" from "good".
 */
export function assessSufficiency(
  evidence: readonly EvidenceChunk[],
  needs: readonly InformationNeed[],
  minSimilarity?: number,
): SufficiencyReport {
  const threshold = minSimilarity ?? getConfig().RAG_SUFFICIENCY_SIMILARITY;

  const usable = evidence.filter((e) =>
    // A chunk both arms agreed on is admissible even without a vector score:
    // exact lexical agreement on a rare term is strong evidence precisely
    // where a small embedding model is weakest.
    e.vectorSimilarity !== null
      ? e.vectorSimilarity >= threshold
      : e.retrievedBy.includes('lexical'),
  );

  const vocabulary = new Set<string>();
  for (const chunk of usable) for (const token of tokenize(chunk.content)) vocabulary.add(token);

  const covered: InformationNeed[] = [];
  const uncovered: InformationNeed[] = [];

  for (const need of needs) {
    const hit = NEED_VOCABULARY[need].some((term) => vocabulary.has(term));
    (hit ? covered : uncovered).push(need);
  }

  const coverage = needs.length === 0 ? 1 : covered.length / needs.length;

  return {
    sufficient: uncovered.length === 0,
    covered,
    uncovered,
    coverage,
    caveats: uncovered.map(
      (need) =>
        `We could not verify ${NEED_LABELS[need]} against an official source. Confirm this at the office before you rely on it.`,
    ),
  };
}

/* ── The loop ─────────────────────────────────────────────────────────── */

export interface AgenticRetrievalInput {
  situation: string;
  serviceName: string;
  serviceId: number | null;
  scenarioName: string | null;
  scenarioCode: string | null;
  needs: readonly InformationNeed[];
  language: Language;
}

export interface AgenticRetrievalResult {
  evidence: EvidenceChunk[];
  sufficiency: SufficiencyReport;
  queriesRun: string[];
  loops: number;
  rejected: number;
}

/**
 * Run planned queries, fuse the results, and re-query once if coverage is
 * short. Deduplicates by chunk id, keeping the best score per chunk.
 */
export async function retrieveEvidence(
  input: AgenticRetrievalInput,
  context: TurnContext,
): Promise<AgenticRetrievalResult> {
  const cfg = getConfig();
  const started = Date.now();

  const filters: RetrievalFilters = {
    serviceId: input.serviceId,
    scenarioCode: input.scenarioCode,
    language: input.language,
  };

  const byChunk = new Map<number, EvidenceChunk>();
  const queriesRun: string[] = [];
  let rejected = 0;
  let loops = 0;
  let needs = [...input.needs];

  const { plan } = await planQueries(
    {
      situation: input.situation,
      serviceName: input.serviceName,
      scenarioName: input.scenarioName,
      needs,
      language: input.language,
    },
    context,
  );

  let queries = plan.queries.map((q) => q.text);

  while (loops < cfg.RAG_MAX_RETRIEVAL_LOOPS) {
    loops += 1;

    const batches = await Promise.all(queries.map((q) => hybridSearch(q, filters)));
    queriesRun.push(...queries);

    for (const batch of batches) {
      rejected += batch.rejected;
      for (const chunk of batch.evidence) {
        const existing = byChunk.get(chunk.chunkId);
        // A chunk found by several queries is more relevant, not less; keep
        // the best score it achieved on any of them.
        if (!existing || chunk.score > existing.score) byChunk.set(chunk.chunkId, chunk);
      }
    }

    const current = [...byChunk.values()].sort((a, b) => b.score - a.score);
    const assessment = assessSufficiency(current, needs, cfg.RAG_SUFFICIENCY_SIMILARITY);

    if (assessment.sufficient || loops >= cfg.RAG_MAX_RETRIEVAL_LOOPS) {
      const evidence = current.slice(0, cfg.RAG_TOP_K);
      const finalAssessment = assessSufficiency(evidence, input.needs, cfg.RAG_SUFFICIENCY_SIMILARITY);

      context.record({
        agent: 'retrieval',
        stage: 'official_retrieval',
        deterministic: true,
        status: finalAssessment.sufficient ? 'ok' : 'degraded',
        input: { queries: queriesRun, loops },
        output: {
          chunks: evidence.length,
          rejectedBelowFloor: rejected,
          coverage: Number(finalAssessment.coverage.toFixed(2)),
          uncovered: finalAssessment.uncovered,
          sources: [...new Set(evidence.map((e) => e.source.title))],
        },
        notes: finalAssessment.sufficient
          ? null
          : `no official evidence found for: ${finalAssessment.uncovered.join(', ')}`,
        latencyMs: Date.now() - started,
      });

      return {
        evidence,
        sufficiency: finalAssessment,
        queriesRun,
        loops,
        rejected,
      };
    }

    // Re-query only the needs that came up empty, with a differently-shaped
    // query. Repeating the same query would return the same nothing.
    needs = assessment.uncovered;
    queries = needs.map((need) => {
      const subject = input.scenarioName
        ? `${input.serviceName} ${input.scenarioName}`
        : input.serviceName;
      return `${subject} ${NEED_VOCABULARY[need].slice(0, 4).join(' ')}`;
    });

    if (queries.length === 0) break;
  }

  const evidence = [...byChunk.values()].sort((a, b) => b.score - a.score).slice(0, cfg.RAG_TOP_K);
  return {
    evidence,
    sufficiency: assessSufficiency(evidence, input.needs, cfg.RAG_SUFFICIENCY_SIMILARITY),
    queriesRun,
    loops,
    rejected,
  };
}
