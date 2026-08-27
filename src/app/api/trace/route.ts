/**
 * GET /api/trace — "How this answer was produced".
 *
 * Returns the agent trace for a session: every step, in order, tagged with
 * whether a model was consulted, which provider and model served it, how long
 * it took, and a summary of what went in and out.
 *
 * This exists because the product has to be able to show — not assert — where
 * AI is used and where deterministic logic is used. A judge asking "how do I
 * know the eligibility decision wasn't made by the model?" gets a live answer
 * from the running system.
 *
 * Traces are already sanitised at write time (agents/base.ts): sensitive
 * variables are excluded and long strings truncated, so nothing here can leak
 * a citizen's identifiers.
 */
import { z } from 'zod';
import { sql } from '@/lib/db/client';
import { route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QuerySchema = z.object({
  /** Limit to one turn; omit for the whole session. */
  turn: z.string().optional(),
  limit: z.string().optional(),
});

interface TraceRow {
  turn_id: string;
  step_index: number;
  agent: string;
  stage: string;
  deterministic: boolean;
  status: string;
  provider: string | null;
  model: string | null;
  input_summary: unknown;
  output_summary: unknown;
  notes: string | null;
  latency_ms: number;
  prompt_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export const GET = route(
  { querySchema: QuerySchema, requireSession: true, skipRateLimit: true },
  async ({ query, session }) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? '200', 10) || 200));

    const rows = await sql<TraceRow>(
      `SELECT turn_id, step_index, agent, stage, deterministic, status, provider, model,
              input_summary, output_summary, notes, latency_ms, prompt_tokens, output_tokens, created_at
         FROM agent_traces
        WHERE session_id = $1
          AND ($2::text IS NULL OR turn_id = $2::text)
        ORDER BY created_at ASC, step_index ASC
        LIMIT $3`,
      [session.id, query.turn ?? null, limit],
    );

    const guardrails = await sql<{
      turn_id: string | null;
      direction: string;
      rule: string;
      severity: string;
      action: string;
      detail: unknown;
      created_at: string;
    }>(
      `SELECT turn_id, direction, rule, severity, action, detail, created_at
         FROM guardrail_events WHERE session_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [session.id],
    );

    const steps = rows.map((r) => ({
      turnId: r.turn_id,
      stepIndex: r.step_index,
      agent: r.agent,
      stage: r.stage,
      deterministic: r.deterministic,
      status: r.status,
      provider: r.provider,
      model: r.model,
      input: r.input_summary,
      output: r.output_summary,
      notes: r.notes,
      latencyMs: r.latency_ms,
      promptTokens: r.prompt_tokens,
      outputTokens: r.output_tokens,
      at: new Date(r.created_at).toISOString(),
    }));

    const deterministicSteps = steps.filter((s) => s.deterministic).length;

    return {
      steps,
      guardrailEvents: guardrails.map((g) => ({
        turnId: g.turn_id,
        direction: g.direction,
        rule: g.rule,
        severity: g.severity,
        action: g.action,
        detail: g.detail,
        at: new Date(g.created_at).toISOString(),
      })),
      summary: {
        totalSteps: steps.length,
        deterministicSteps,
        modelSteps: steps.length - deterministicSteps,
        deterministicShare:
          steps.length === 0 ? 1 : Number((deterministicSteps / steps.length).toFixed(2)),
        totalLatencyMs: steps.reduce((sum, s) => sum + s.latencyMs, 0),
        totalPromptTokens: steps.reduce((sum, s) => sum + (s.promptTokens ?? 0), 0),
        totalOutputTokens: steps.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0),
        turns: [...new Set(steps.map((s) => s.turnId))].length,
      },
    };
  },
);
