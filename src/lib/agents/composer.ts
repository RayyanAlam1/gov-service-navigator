/**
 * Plan composition — the language layer's narrowest job.
 *
 * By the time this runs, the plan is fully decided: steps, documents, fees,
 * offices and caveats are database rows selected by the rules engine. Nothing
 * here can add, remove or alter a plan element. The model is asked one thing:
 * express these exact strings in the citizen's language.
 *
 * Even that is a last resort. The order of preference is:
 *
 *   1. A translation already in the database (`title_ur`, `instruction_ur`, …).
 *      Authored, reviewable, versioned alongside the fact it describes.
 *   2. A model translation of the supplied English string.
 *   3. The English string itself.
 *
 * Every model translation is run through the output verifier before it is
 * shown. A translation that gained a number, lost a number, or acquired a URL
 * is discarded in favour of the original — because the most likely way a
 * translation goes wrong is that "PKR 750" becomes "PKR 7500", and a citizen
 * acts on that.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config/env';
import { generateStructured } from '@/lib/llm/client';
import { buildGroundingContext, verifyText, type ClaimViolation } from '@/lib/guardrails/output';
import { pickLocalized, type Language, type LocalizedText } from '@/lib/schemas/core';
import type { ActionPlan, ReadinessReport } from '@/lib/schemas/domain';
import { planFactInventory } from '@/lib/engine/plan';
import { jsonSchemaOf, persistGuardrailEvent, type TurnContext } from './base';

/* ── Translation contract ─────────────────────────────────────────────── */

const TranslationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
});

const TRANSLATION_JSON_SCHEMA = jsonSchemaOf(TranslationSchema, 'Translations');

interface TranslatableField {
  id: string;
  /** English source text. Always the ground truth. */
  english: string;
  /** Database translation if one exists. */
  existing: string | null;
}

/**
 * A field is only sent to the model when the database has no translation.
 *
 * This is what keeps token spend proportional to missing content rather than
 * to plan size, and it means a well-curated knowledge base gradually removes
 * the model from the rendering path altogether.
 */
function needsTranslation(field: TranslatableField): boolean {
  return field.existing === null || field.existing.trim() === '';
}

export interface ComposePlanInput {
  plan: ActionPlan;
  readiness: ReadinessReport;
  language: Language;
}

export interface ComposedPlan {
  /** Field id -> the string that will actually be shown. */
  text: Record<string, string>;
  violations: Array<{ id: string; violations: ClaimViolation[] }>;
  translatedCount: number;
  fromDatabaseCount: number;
  rejectedCount: number;
  deterministic: boolean;
}

function collectFields(plan: ActionPlan, readiness: ReadinessReport, language: Language): TranslatableField[] {
  const fields: TranslatableField[] = [];

  const push = (id: string, text: LocalizedText) => {
    const existing = language === 'en' ? text.en : language === 'ur' ? text.ur : text.roman_ur;
    fields.push({ id, english: text.en, existing: existing ?? null });
  };

  push('headline', plan.headline);
  push('readiness.summary', readiness.summary);

  for (const step of plan.steps) {
    push(`step.${step.code}.title`, step.title);
    push(`step.${step.code}.instruction`, step.instruction);
  }
  for (const item of plan.checklist) {
    push(`checklist.${item.requirementCode}.title`, item.title);
    // The "why is this on my list" line is generated in English by the rules
    // engine and has no stored translation, so it goes through the model when
    // the citizen is not reading English. It is the sentence most likely to be
    // read carefully, so leaving it untranslated would be the wrong gap to have.
    fields.push({
      id: `checklist.${item.requirementCode}.reason`,
      english: item.reason,
      existing: language === 'en' ? item.reason : null,
    });
  }
  for (const exception of plan.exceptions) {
    push(`exception.${exception.code}.name`, exception.name);
    push(`exception.${exception.code}.guidance`, exception.guidance);
  }
  for (const [index, caveat] of plan.caveats.entries()) {
    // Caveats are generated in English by the engine and have no stored
    // translation, so they always go through the model when not in English.
    fields.push({ id: `caveat.${index}`, english: caveat, existing: language === 'en' ? caveat : null });
  }

  fields.push({
    id: 'readiness.nextAction',
    english: readiness.nextAction,
    existing: language === 'en' ? readiness.nextAction : null,
  });

  return fields;
}

export async function composePlanText(
  { plan, readiness, language }: ComposePlanInput,
  context: TurnContext,
): Promise<ComposedPlan> {
  const cfg = getConfig();
  const started = Date.now();

  const fields = collectFields(plan, readiness, language);
  const text: Record<string, string> = {};
  const pending: TranslatableField[] = [];

  for (const field of fields) {
    if (needsTranslation(field)) pending.push(field);
    else text[field.id] = field.existing as string;
  }

  const fromDatabaseCount = fields.length - pending.length;

  // English needs no model at all: `english` is already the answer.
  if (language === 'en' || pending.length === 0) {
    for (const field of pending) text[field.id] = field.english;
    context.record({
      agent: 'plan_composer',
      stage: 'personalized_plan',
      deterministic: true,
      status: 'ok',
      input: { language, fields: fields.length },
      output: { fromDatabase: fromDatabaseCount, translated: 0 },
      notes: language === 'en' ? 'English needs no translation layer' : 'every field had a stored translation',
      latencyMs: Date.now() - started,
    });
    return {
      text,
      violations: [],
      translatedCount: 0,
      fromDatabaseCount,
      rejectedCount: 0,
      deterministic: true,
    };
  }

  const languageName = language === 'ur' ? 'Urdu (Arabic script)' : 'Roman Urdu (Urdu written in Latin script)';

  const fallback = () => ({
    translations: pending.map((f) => ({ id: f.id, text: f.english })),
  });

  let fallbackReason: string | null = null;

  const result = await generateStructured(
    {
      kind: 'plan.translate',
      messages: [
        {
          role: 'system',
          content: [
            `You translate short government-service instructions into ${languageName}.`,
            '',
            'This is a translation task, not a writing task. Hard rules:',
            '- Translate meaning only. Do not add, remove, round or reformat any number.',
            '- Every digit in the source must appear unchanged in the translation.',
            '- Do not add URLs, office names, document names, fees or timeframes that are not',
            '  in the source string. Do not remove any that are.',
            '- Do not add advice, encouragement or caveats of your own.',
            '- Keep proper nouns and acronyms (NADRA, CNIC, B-Form, NICOP) in their usual form.',
            '- Return one translation per input id. Do not merge or drop entries.',
            language === 'roman_ur'
              ? '- Roman Urdu means natural Urdu phonetically in Latin letters, as Pakistanis text. Not English.'
              : '- Use clear, plain Urdu that an ordinary citizen reads easily. Not formal legalese.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(pending.map((f) => ({ id: f.id, text: f.english })), null, 1),
        },
      ],
      schema: TranslationSchema,
      jsonSchema: TRANSLATION_JSON_SCHEMA,
      tier: 'primary',
      maxTokens: Math.min(4096, 200 + pending.length * 90),
    },
    fallback,
    { onFallback: (reason) => { fallbackReason = reason; } },
  );

  // Verify every translation against the plan's own facts before it is shown.
  const inventory = planFactInventory(plan);
  const grounding = buildGroundingContext(inventory);

  const returned = new Map(result.data.translations.map((t) => [t.id, t.text] as const));
  const violations: ComposedPlan['violations'] = [];
  let rejectedCount = 0;

  for (const field of pending) {
    const candidate = returned.get(field.id);

    if (!candidate || candidate.trim() === '') {
      text[field.id] = field.english;
      continue;
    }

    const found = verifyText(candidate, grounding);

    // A translation must not change the numbers it carries. Comparing digit
    // sequences catches the specific, high-consequence error — 750 becoming
    // 7500 — that a claim scan alone would miss when both values happen to be
    // in the fact set.
    const sourceDigits = digitSignature(field.english);
    const targetDigits = digitSignature(candidate);
    const digitsDrifted = sourceDigits !== targetDigits;

    if (found.length > 0 || digitsDrifted) {
      rejectedCount += 1;
      violations.push({
        id: field.id,
        violations: digitsDrifted
          ? [
              ...found,
              {
                kind: 'large_number' as const,
                text: candidate.slice(0, 120),
                reason: `numbers changed during translation (source: ${sourceDigits || 'none'}, translation: ${targetDigits || 'none'})`,
              },
            ]
          : found,
      });
      // Fall back to the English source, which is always correct.
      text[field.id] = cfg.STRICT_GROUNDING ? field.english : candidate;
      void persistGuardrailEvent({
        sessionId: context.sessionId,
        turnId: context.turnId,
        direction: 'output',
        rule: 'translation_ungrounded',
        severity: 'block',
        action: cfg.STRICT_GROUNDING ? 'rewritten' : 'allowed',
        detail: { field: field.id, language, reasons: violations.at(-1)?.violations.map((v) => v.reason) },
      });
    } else {
      text[field.id] = candidate;
    }
  }

  const translatedCount = pending.length - rejectedCount;

  context.record({
    agent: 'plan_composer',
    stage: 'personalized_plan',
    deterministic: result.provider === 'mock',
    status: rejectedCount > 0 ? 'degraded' : result.provider === 'mock' ? 'degraded' : 'ok',
    provider: result.provider,
    model: result.model,
    input: { language, fields: fields.length, sentToModel: pending.length },
    output: {
      fromDatabase: fromDatabaseCount,
      translated: translatedCount,
      rejected: rejectedCount,
    },
    notes:
      [
        fallbackReason ? `no translation available: ${fallbackReason}` : null,
        rejectedCount > 0
          ? `${rejectedCount} translation(s) failed grounding verification and were replaced with the English source`
          : null,
      ]
        .filter(Boolean)
        .join('; ') || null,
    latencyMs: Date.now() - started,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
  });

  return {
    text,
    violations,
    translatedCount,
    fromDatabaseCount,
    rejectedCount,
    deterministic: result.provider === 'mock',
  };
}

/**
 * Digits in order of appearance, as a comparable signature.
 *
 * Arabic-Indic digits are folded to ASCII first so an Urdu translation that
 * correctly renders 750 as ۷۵۰ is not flagged as drift.
 */
export function digitSignature(text: string): string {
  const folded = text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
  return (folded.match(/\d+/g) ?? []).join(',');
}

/** Resolve a localized field, preferring composed text and falling back cleanly. */
export function resolveText(
  composed: ComposedPlan,
  id: string,
  source: LocalizedText,
  language: Language,
): string {
  return composed.text[id] ?? pickLocalized(source, language);
}
