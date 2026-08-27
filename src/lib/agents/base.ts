/**
 * Shared agent infrastructure.
 *
 * Every agent in this system is the same shape: a typed input, a JSON-Schema-
 * constrained output, a deterministic fallback, and a trace entry recording
 * which of those two actually produced the answer.
 *
 * The `deterministic` flag on each trace step is not decoration. The product
 * has to be able to show a judge — in under four minutes — exactly where AI is
 * used and where fixed logic is used. A claim like that is only convincing if
 * the system can point at a live record of it, so the trace is written on
 * every turn and rendered by the UI's "How this answer was produced" panel.
 *
 * Traces are written best-effort: a failure to record must never fail the
 * citizen's request.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { logger } from '@/lib/obs/logger';
import type { JourneyStage, Language } from '@/lib/schemas/core';
import { truncateWords } from '@/lib/i18n/normalize';

export type AgentName =
  | 'input_guardrail'
  | 'language'
  | 'intent'
  | 'service_resolver'
  | 'interview_planner'
  | 'question_phrasing'
  | 'retrieval'
  | 'rules_engine'
  | 'plan_composer'
  | 'output_verifier'
  | 'readiness'
  | 'document_check';

export type TraceStatus = 'ok' | 'degraded' | 'blocked' | 'error' | 'cache_hit';

export interface TraceStep {
  stepIndex: number;
  agent: AgentName;
  stage: JourneyStage;
  /** TRUE means no model was consulted for this step. */
  deterministic: boolean;
  status: TraceStatus;
  provider: string | null;
  model: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  notes: string | null;
  latencyMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  retryCount: number;
}

export interface RecordStepInput {
  agent: AgentName;
  stage: JourneyStage;
  deterministic: boolean;
  status?: TraceStatus;
  provider?: string | null;
  model?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  notes?: string | null;
  latencyMs?: number;
  promptTokens?: number | null;
  outputTokens?: number | null;
  retryCount?: number;
}

/**
 * Per-turn context threaded through the pipeline.
 *
 * Holds the trace, the session identity and the working language. Nothing in
 * here is sensitive: answers to variables marked `is_sensitive` are excluded
 * before they reach a trace entry.
 */
export class TurnContext {
  readonly turnId: string;
  readonly steps: TraceStep[] = [];
  private index = 0;

  constructor(
    readonly sessionId: number | null,
    public language: Language,
    turnId?: string,
  ) {
    this.turnId = turnId ?? randomUUID();
  }

  record(step: RecordStepInput): TraceStep {
    const entry: TraceStep = {
      stepIndex: this.index,
      agent: step.agent,
      stage: step.stage,
      deterministic: step.deterministic,
      status: step.status ?? 'ok',
      provider: step.provider ?? null,
      model: step.model ?? null,
      input: sanitizeForTrace(step.input ?? {}),
      output: sanitizeForTrace(step.output ?? {}),
      notes: step.notes ?? null,
      latencyMs: step.latencyMs ?? 0,
      promptTokens: step.promptTokens ?? null,
      outputTokens: step.outputTokens ?? null,
      retryCount: step.retryCount ?? 0,
    };
    this.index += 1;
    this.steps.push(entry);
    return entry;
  }

  /** Wall-clock across every recorded step. */
  get totalLatencyMs(): number {
    return this.steps.reduce((sum, s) => sum + s.latencyMs, 0);
  }

  /** Share of steps that ran without consulting a model. */
  get deterministicShare(): number {
    if (this.steps.length === 0) return 1;
    return this.steps.filter((s) => s.deterministic).length / this.steps.length;
  }
}

/**
 * Trim and mask anything heading into a trace record.
 *
 * Traces are the most-read artefact in the system during a demo and the most
 * likely to be screenshotted, so they get the same redaction treatment as
 * logs, plus aggressive truncation to keep the panel readable.
 */
function sanitizeForTrace(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/^(cnic|passport|phone|email|raw_?text|extracted_?fields)$/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof raw === 'string') {
      out[key] = truncateWords(raw, 400);
    } else if (Array.isArray(raw)) {
      out[key] = raw.slice(0, 20).map((v) => (typeof v === 'string' ? truncateWords(v, 200) : v));
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Derive a JSON Schema from a zod schema.
 *
 * Generated rather than hand-written so the prompt contract and the runtime
 * validator can never disagree — a divergence there produces output that
 * validates locally and gets rejected by the provider, or worse, the reverse.
 */
export function jsonSchemaOf(schema: z.ZodType<unknown>, name: string): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  // zodToJsonSchema wraps the result in { definitions: { [name]: ... } } when
  // given a name; unwrap so the prompt carries the schema itself.
  const definitions = generated.definitions as Record<string, unknown> | undefined;
  const unwrapped = definitions?.[name];
  return (unwrapped as Record<string, unknown>) ?? generated;
}

/** Persist a turn's trace. Best-effort by design. */
export async function persistTrace(context: TurnContext): Promise<void> {
  if (context.sessionId === null || context.steps.length === 0) return;
  try {
    const { getDb } = await import('@/lib/db/client');
    const db = await getDb();
    await db.transaction(async (tx) => {
      for (const step of context.steps) {
        await tx.query(
          `INSERT INTO agent_traces
             (session_id, turn_id, step_index, agent, stage, deterministic, status,
              provider, model, input_summary, output_summary, notes, latency_ms,
              prompt_tokens, output_tokens, retry_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)`,
          [
            context.sessionId,
            context.turnId,
            step.stepIndex,
            step.agent,
            step.stage,
            step.deterministic,
            step.status,
            step.provider,
            step.model,
            JSON.stringify(step.input),
            JSON.stringify(step.output),
            step.notes,
            step.latencyMs,
            step.promptTokens,
            step.outputTokens,
            step.retryCount,
          ],
        );
      }
    });
  } catch (err) {
    logger().warn({ err, turnId: context.turnId }, 'failed to persist agent trace');
  }
}

/** Persist a guardrail trip. Also best-effort. */
export async function persistGuardrailEvent(input: {
  sessionId: number | null;
  turnId: string | null;
  direction: 'input' | 'output';
  rule: string;
  severity: 'info' | 'warn' | 'block';
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { sql } = await import('@/lib/db/client');
    await sql(
      `INSERT INTO guardrail_events (session_id, turn_id, direction, rule, severity, action, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        input.sessionId,
        input.turnId,
        input.direction,
        input.rule,
        input.severity,
        input.action,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  } catch (err) {
    logger().warn({ err, rule: input.rule }, 'failed to persist guardrail event');
  }
}
