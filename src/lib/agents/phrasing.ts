/**
 * Question phrasing.
 *
 * The interview planner has already decided *which* question to ask — by
 * information gain over the rule set, with no model involved. This agent only
 * decides how to word it, and only when the database has no stored phrasing
 * for the citizen's language.
 *
 * Keeping selection and phrasing apart is what makes the adaptive interview
 * demonstrable. "Why did it ask me that?" has a real answer computed from the
 * rules, and it stays true whether or not a model was available to make the
 * wording nicer.
 */
import { z } from 'zod';
import { generateStructured } from '@/lib/llm/client';
import { pickLocalized, type Language, type LocalizedText } from '@/lib/schemas/core';
import type { DecisionVariable, VariableOption } from '@/lib/schemas/domain';
import { jsonSchemaOf, type TurnContext } from './base';

export const PhrasedQuestionSchema = z.object({
  question: z.string().min(3).max(220),
  /** Why this is being asked, in the citizen's language. One short sentence. */
  why: z.string().max(200),
  options: z
    .array(z.object({ value: z.string(), label: z.string().max(80) }))
    .max(12),
});

export type PhrasedQuestion = z.infer<typeof PhrasedQuestionSchema>;

const PHRASED_JSON_SCHEMA = jsonSchemaOf(PhrasedQuestionSchema, 'PhrasedQuestion');

export interface PresentedQuestion {
  variableCode: string;
  type: DecisionVariable['type'];
  question: string;
  help: string | null;
  why: string;
  options: Array<{ value: string | number | boolean; label: string }>;
  deterministic: boolean;
}

/**
 * Why-copy for the affordance that answers "why are you asking me this?".
 *
 * Built from the planner's impact analysis, which lists exactly which parts of
 * the outcome this answer moves. Templated in all three languages so the
 * explanation never depends on a model being reachable.
 */
const WHY_TEMPLATES: Record<Language, { lead: string; join: string; tail: string }> = {
  en: { lead: 'Your answer changes', join: ' and ', tail: '.' },
  ur: { lead: 'آپ کا جواب', join: ' اور ', tail: ' کو بدلتا ہے۔' },
  roman_ur: { lead: 'Aap ka jawab', join: ' aur ', tail: ' ko badalta hai.' },
};

const IMPACT_LABELS: Record<string, Record<Language, string>> = {
  'which case applies to you': {
    en: 'which case applies to you',
    ur: 'آپ پر کون سا کیس لاگو ہوتا ہے',
    roman_ur: 'aap par kaunsa case lagu hota hai',
  },
  'whether you are eligible': {
    en: 'whether you are eligible',
    ur: 'آپ اہل ہیں یا نہیں',
    roman_ur: 'aap eligible hain ya nahi',
  },
  'which documents you need': {
    en: 'which documents you need',
    ur: 'آپ کو کون سی دستاویزات درکار ہیں',
    roman_ur: 'aap ko kaunse documents chahiye',
  },
  'the steps you follow': {
    en: 'the steps you follow',
    ur: 'آپ کو کون سے مراحل طے کرنے ہیں',
    roman_ur: 'aap ko kaunse steps follow karne hain',
  },
  'what it costs': {
    en: 'what it costs',
    ur: 'اس کی فیس',
    roman_ur: 'is ki fees',
  },
  'special handling for your situation': {
    en: 'special handling for your situation',
    ur: 'آپ کی صورتحال کے لیے خصوصی ہدایات',
    roman_ur: 'aap ki situation ke liye khaas hidayat',
  },
};

export function buildWhyText(impacts: readonly string[], language: Language): string {
  const template = WHY_TEMPLATES[language];
  const labels = impacts
    .map((impact) => IMPACT_LABELS[impact]?.[language] ?? impact)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 3);

  if (labels.length === 0) {
    return language === 'ur'
      ? 'یہ سوال آپ کے لیے درست طریقہ کار طے کرنے کے لیے ضروری ہے۔'
      : language === 'roman_ur'
        ? 'Yeh sawal aap ke liye sahi procedure tay karne ke liye zaroori hai.'
        : 'This question determines the correct procedure for your case.';
  }

  return `${template.lead} ${labels.join(template.join)}${template.tail}`;
}

function optionLabel(option: VariableOption, language: Language): string {
  return pickLocalized(option.label, language);
}

function storedPhrasing(variable: DecisionVariable, language: Language): string | null {
  const prompt: LocalizedText = variable.prompt;
  const value = language === 'ur' ? prompt.ur : language === 'roman_ur' ? prompt.roman_ur : prompt.en;
  return value && value.trim() !== '' ? value : null;
}

export interface PhraseQuestionInput {
  variable: DecisionVariable;
  /** Impact strings from the interview planner. */
  impacts: readonly string[];
  language: Language;
  /** The citizen's original words, for tone matching only. */
  situation: string;
}

export async function phraseQuestion(
  { variable, impacts, language, situation }: PhraseQuestionInput,
  context: TurnContext,
): Promise<PresentedQuestion> {
  const started = Date.now();
  const why = buildWhyText(impacts, language);
  const stored = storedPhrasing(variable, language);

  const deterministicOptions = variable.options.map((o) => ({
    value: o.value,
    label: optionLabel(o, language),
  }));

  // The database has this phrasing already: no model call, no risk, no latency.
  const allOptionsStored = variable.options.every((o) => {
    const label = language === 'ur' ? o.label.ur : language === 'roman_ur' ? o.label.roman_ur : o.label.en;
    return label !== null && label !== undefined && label.trim() !== '';
  });

  if (stored && (variable.options.length === 0 || allOptionsStored)) {
    context.record({
      agent: 'question_phrasing',
      stage: 'situation_interview',
      deterministic: true,
      status: 'ok',
      input: { variable: variable.code, language },
      output: { source: 'database', question: stored },
      notes: 'stored phrasing used; no model call',
      latencyMs: Date.now() - started,
    });

    return {
      variableCode: variable.code,
      type: variable.type,
      question: stored,
      help: variable.help ? pickLocalized(variable.help, language) : null,
      why,
      options: deterministicOptions,
      deterministic: true,
    };
  }

  const fallback = (): PhrasedQuestion => ({
    question: variable.prompt.en,
    why,
    options: variable.options.map((o) => ({ value: String(o.value), label: o.label.en })),
  });

  let fallbackReason: string | null = null;

  const languageName =
    language === 'ur' ? 'Urdu (Arabic script)' : language === 'roman_ur' ? 'Roman Urdu' : 'English';

  const result = await generateStructured(
    {
      kind: 'interview.phrase',
      messages: [
        {
          role: 'system',
          content: [
            `Rewrite one interview question in ${languageName} for a Pakistani citizen.`,
            '',
            'You are NOT choosing what to ask — that is already decided. You are only wording it.',
            '',
            'Rules:',
            '- Keep the exact meaning. Do not broaden or narrow what is being asked.',
            '- Return the same option values, translating only the labels.',
            '- Do not add examples that name specific documents, offices or fees.',
            '- One short, plain sentence. Citizens using this are often anxious and in a hurry.',
            language === 'roman_ur'
              ? '- Roman Urdu means natural spoken Urdu in Latin letters, as Pakistanis text. Not English.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              question: variable.prompt.en,
              help: variable.help?.en ?? null,
              options: variable.options.map((o) => ({ value: String(o.value), label: o.label.en })),
              why_we_ask: buildWhyText(impacts, 'en'),
              citizen_wrote: situation.slice(0, 200),
            },
            null,
            1,
          ),
        },
      ],
      schema: PhrasedQuestionSchema,
      jsonSchema: PHRASED_JSON_SCHEMA,
      tier: 'fast',
      maxTokens: 600,
    },
    fallback,
    { onFallback: (reason) => { fallbackReason = reason; } },
  );

  // Option values are authoritative from the database. The model may relabel
  // them; it may not add, drop or renumber them, because the rules engine
  // matches on the value.
  const labelByValue = new Map(result.data.options.map((o) => [o.value, o.label] as const));
  const options = variable.options.map((o) => ({
    value: o.value,
    label: labelByValue.get(String(o.value)) ?? optionLabel(o, language),
  }));

  const droppedOptions = variable.options.length - result.data.options.length;

  context.record({
    agent: 'question_phrasing',
    stage: 'situation_interview',
    deterministic: result.provider === 'mock',
    status: result.provider === 'mock' ? 'degraded' : result.cached ? 'cache_hit' : 'ok',
    provider: result.provider,
    model: result.model,
    input: { variable: variable.code, language },
    output: { source: 'model', question: result.data.question, options: options.length },
    notes:
      [
        fallbackReason ? `English fallback: ${fallbackReason}` : null,
        droppedOptions > 0 ? `model returned ${droppedOptions} fewer option(s); database values kept` : null,
      ]
        .filter(Boolean)
        .join('; ') || null,
    latencyMs: Date.now() - started,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
  });

  return {
    variableCode: variable.code,
    type: variable.type,
    question: result.data.question,
    help: variable.help ? pickLocalized(variable.help, language) : null,
    // The templated `why` is preferred over the model's: it is computed from
    // the actual rule impacts, so it is true by construction.
    why,
    options,
    deterministic: result.provider === 'mock',
  };
}
