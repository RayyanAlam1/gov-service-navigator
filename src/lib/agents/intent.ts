/**
 * Intent & situation extraction.
 *
 * Reads the citizen's opening sentence and proposes: which service they might
 * mean, which scenario it sounds like, where they are, and any circumstances
 * they already volunteered ("gum hogya" implies lost; "renew karwana hai"
 * implies renewal).
 *
 * Three constraints keep this honest:
 *
 *   1. The service list is passed in as an enum of codes that exist. The model
 *      cannot nominate a service the knowledge base has never heard of — and
 *      the resolver discards it anyway if it does.
 *   2. Everything it extracts is stored with `origin: 'inferred'`, shown back
 *      to the citizen as an assumption, and freely overridable. A wrong
 *      extraction becomes a visible checkbox, not a silent wrong branch.
 *   3. There is a full deterministic fallback. With no model available, keyword
 *      rules over the alias table do the same job less fluently, and the rest
 *      of the pipeline cannot tell the difference.
 */
import { z } from 'zod';
import { generateStructured } from '@/lib/llm/client';
import { tokenize } from '@/lib/i18n/normalize';
import type { Language } from '@/lib/schemas/core';
import type { ServiceAlias } from '@/lib/db/knowledge';
import type { Service } from '@/lib/schemas/domain';
import { jsonSchemaOf, type TurnContext } from './base';

/* ── Output contract ──────────────────────────────────────────────────── */

export const IntentExtractionSchema = z.object({
  /** Service codes from the supplied list, best first. Empty if unsure. */
  serviceCandidates: z.array(z.string()).max(3),
  /** Scenario codes such as 'lost', 'renewal', 'new', 'modification'. */
  scenarioHints: z.array(z.string()).max(3),
  /** City exactly as the citizen wrote it, or null. */
  city: z.string().nullable(),
  province: z.string().nullable(),
  /**
   * Circumstances the citizen already stated. Keys must be decision-variable
   * codes from the supplied list; anything else is dropped by the caller.
   */
  circumstances: z
    .array(
      z.object({
        variable: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
        /** Verbatim words that justify this, for the assumption chip in the UI. */
        evidence: z.string(),
      }),
    )
    .max(8),
  /** 0..1 self-reported confidence in the service proposal. */
  confidence: z.number().min(0).max(1),
  /** One line, in English, summarising what the citizen wants. */
  goalSummary: z.string().max(200),
});

export type IntentExtraction = z.infer<typeof IntentExtractionSchema>;

const INTENT_JSON_SCHEMA = jsonSchemaOf(IntentExtractionSchema, 'IntentExtraction');

/* ── Deterministic fallback ───────────────────────────────────────────── */

/**
 * Scenario vocabulary across the three languages.
 *
 * This is the fallback's whole intelligence, and it is also what the live path
 * is checked against — if the model proposes 'renewal' for a message full of
 * lost-vocabulary, the resolver's alias scoring will disagree with it.
 */
const SCENARIO_KEYWORDS: ReadonlyArray<{ scenario: string; tokens: readonly string[] }> = [
  {
    scenario: 'lost',
    tokens: [
      'lost', 'gum', 'khoya', 'kho', 'misplaced', 'stolen', 'chori', 'gumshuda',
      // Urdu script. Without these an Urdu speaker gets a longer interview than
      // a Roman-Urdu speaker asking the identical question — the exact
      // inequality this product is meant to remove.
      'گم', 'گمشدہ', 'کھو', 'چوری',
    ],
  },
  {
    scenario: 'damaged',
    tokens: ['damaged', 'broken', 'torn', 'kharab', 'toota', 'phata', 'خراب', 'ٹوٹ', 'پھٹ'],
  },
  {
    scenario: 'renewal',
    tokens: [
      'renew', 'renewal', 'expired', 'expire', 'tajdeed', 'purana', 'khatam',
      'تجدید', 'ختم', 'میعاد', 'پرانا', 'پرانی',
    ],
  },
  {
    scenario: 'modification',
    tokens: [
      'change', 'correct', 'correction', 'update', 'modify', 'tabdeel', 'ghalti', 'wrong',
      'تبدیل', 'تبدیلی', 'درست', 'درستی', 'غلط', 'غلطی',
    ],
  },
  {
    scenario: 'new',
    tokens: [
      'new', 'first', 'naya', 'nayi', 'pehli', 'pehla', 'banwana', 'banana', 'apply',
      'نیا', 'نئی', 'پہلی', 'پہلا', 'بنوانا', 'بنانا',
    ],
  },
];

const PROVINCE_BY_CITY: Readonly<Record<string, string>> = {
  karachi: 'Sindh', hyderabad: 'Sindh', sukkur: 'Sindh', larkana: 'Sindh', mirpurkhas: 'Sindh',
  lahore: 'Punjab', faisalabad: 'Punjab', rawalpindi: 'Punjab', multan: 'Punjab',
  gujranwala: 'Punjab', sialkot: 'Punjab', bahawalpur: 'Punjab', sargodha: 'Punjab',
  peshawar: 'Khyber Pakhtunkhwa', mardan: 'Khyber Pakhtunkhwa', abbottabad: 'Khyber Pakhtunkhwa',
  quetta: 'Balochistan', gwadar: 'Balochistan',
  islamabad: 'Islamabad Capital Territory',
  gilgit: 'Gilgit-Baltistan', skardu: 'Gilgit-Baltistan',
  muzaffarabad: 'Azad Jammu and Kashmir', mirpur: 'Azad Jammu and Kashmir',
};

export interface IntentInput {
  query: string;
  language: Language;
  services: readonly Service[];
  aliases: readonly ServiceAlias[];
  /** Decision-variable codes the model is permitted to fill. */
  allowedVariables: readonly string[];
}

/**
 * Keyword extraction over the alias table.
 *
 * Runs when no model is available, and is also what the live call's fallback
 * returns. It is genuinely usable: alias matching resolves the three MVP
 * services reliably, because citizens name the document.
 */
export function extractIntentDeterministically(input: IntentInput): IntentExtraction {
  const tokens = tokenize(input.query);
  const tokenSet = new Set(tokens);

  const serviceScores = new Map<string, number>();
  for (const alias of input.aliases) {
    const aliasTokens = tokenize(alias.alias);
    if (aliasTokens.length === 0) continue;
    const allPresent = aliasTokens.every((t) => tokenSet.has(t));
    if (allPresent) {
      serviceScores.set(
        alias.serviceCode,
        (serviceScores.get(alias.serviceCode) ?? 0) + alias.weight * aliasTokens.length,
      );
    }
  }

  const serviceCandidates = [...serviceScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code]) => code);

  const scenarioHints = SCENARIO_KEYWORDS.filter((s) => s.tokens.some((t) => tokenSet.has(t))).map(
    (s) => s.scenario,
  );

  const city = tokens.find((t) => Object.hasOwn(PROVINCE_BY_CITY, t)) ?? null;
  const province = city ? (PROVINCE_BY_CITY[city] ?? null) : null;

  // Only propose circumstances for variables that actually exist.
  const circumstances: IntentExtraction['circumstances'] = [];
  const allowed = new Set(input.allowedVariables);
  const primaryScenario = scenarioHints[0];
  if (primaryScenario && allowed.has('application_type')) {
    circumstances.push({
      variable: 'application_type',
      value: primaryScenario,
      evidence: SCENARIO_KEYWORDS.find((s) => s.scenario === primaryScenario)?.tokens.find((t) =>
        tokenSet.has(t),
      ) ?? primaryScenario,
    });
  }

  const topScore = serviceCandidates.length > 0 ? (serviceScores.get(serviceCandidates[0] ?? '') ?? 0) : 0;

  return {
    serviceCandidates,
    scenarioHints,
    city: city ? titleCase(city) : null,
    province,
    circumstances,
    // Keyword matching is reliable when it fires and silent when it does not,
    // so confidence tracks whether anything matched at all.
    confidence: topScore > 0 ? Math.min(0.75, 0.35 + topScore * 0.12) : 0.1,
    goalSummary: input.query.slice(0, 180),
  };
}

/* ── Live extraction ──────────────────────────────────────────────────── */

function buildPrompt(input: IntentInput): { system: string; user: string } {
  const serviceList = input.services
    .map((s) => `  - ${s.code}: ${s.name.en}${s.summary.en ? ` — ${s.summary.en}` : ''}`)
    .join('\n');

  const system = [
    'You extract structured intent from a Pakistani citizen describing a government-service need.',
    '',
    'You are NOT answering their question. You are not stating any requirement, fee, document or',
    'procedure. You only identify what they are asking about and what they have already told you.',
    '',
    'Rules:',
    `- serviceCandidates MUST come from this list of codes, or be empty:\n${serviceList}`,
    '- If you are not confident which service they mean, return fewer candidates or none. An empty',
    '  list is a correct answer; a wrong service sends the citizen to the wrong department.',
    '- scenarioHints should be one of: new, renewal, lost, damaged, modification.',
    `- circumstances[].variable MUST be one of: ${input.allowedVariables.join(', ')}`,
    '- Only include a circumstance the citizen actually stated. Do not infer beyond their words.',
    '- evidence must quote the citizen\'s own words that justify the value.',
    '- The citizen may write in English, Urdu or Roman Urdu. Understand all three.',
    '- goalSummary must be in English regardless of the input language.',
  ].join('\n');

  const user = [
    `Citizen message (detected language: ${input.language}):`,
    '"""',
    input.query,
    '"""',
  ].join('\n');

  return { system, user };
}

export interface IntentResult {
  extraction: IntentExtraction;
  provider: string;
  model: string;
  deterministic: boolean;
}

export async function extractIntent(input: IntentInput, context: TurnContext): Promise<IntentResult> {
  const started = Date.now();
  const { system, user } = buildPrompt(input);
  const fallback = () => extractIntentDeterministically(input);

  let fallbackReason: string | null = null;

  const result = await generateStructured(
    {
      kind: 'intent.extract',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema: IntentExtractionSchema,
      jsonSchema: INTENT_JSON_SCHEMA,
      tier: 'primary',
    },
    fallback,
    { onFallback: (reason) => { fallbackReason = reason; } },
  );

  // Discard anything outside the permitted vocabulary. The prompt asks for
  // this; the code guarantees it.
  const validServiceCodes = new Set(input.services.map((s) => s.code));
  const allowedVariables = new Set(input.allowedVariables);

  const extraction: IntentExtraction = {
    ...result.data,
    serviceCandidates: result.data.serviceCandidates.filter((c) => validServiceCodes.has(c)),
    circumstances: result.data.circumstances.filter((c) => allowedVariables.has(c.variable)),
  };

  const droppedServices = result.data.serviceCandidates.length - extraction.serviceCandidates.length;
  const droppedVariables = result.data.circumstances.length - extraction.circumstances.length;

  context.record({
    agent: 'intent',
    stage: 'language_intent',
    deterministic: result.provider === 'mock',
    status: result.provider === 'mock' ? 'degraded' : result.cached ? 'cache_hit' : 'ok',
    provider: result.provider,
    model: result.model,
    input: { query: input.query, language: input.language },
    output: {
      serviceCandidates: extraction.serviceCandidates,
      scenarioHints: extraction.scenarioHints,
      city: extraction.city,
      confidence: extraction.confidence,
      circumstances: extraction.circumstances.map((c) => `${c.variable}=${String(c.value)}`),
    },
    notes:
      [
        fallbackReason ? `deterministic fallback: ${fallbackReason}` : null,
        droppedServices > 0 ? `dropped ${droppedServices} proposed service(s) not in the knowledge base` : null,
        droppedVariables > 0 ? `dropped ${droppedVariables} circumstance(s) referencing unknown variables` : null,
      ]
        .filter(Boolean)
        .join('; ') || null,
    latencyMs: Date.now() - started,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
  });

  return {
    extraction,
    provider: result.provider,
    model: result.model,
    deterministic: result.provider === 'mock',
  };
}

function titleCase(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}
