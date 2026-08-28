#!/usr/bin/env tsx
/**
 * npm run check:models — find which models your key can actually use.
 *
 * Groq and DashScope both vary model availability by account, and the failure
 * is quiet and expensive: a model the docs list as "production" can return 404
 * for your key, and a model that answers normally can still fail JSON mode.
 *
 * This pipeline depends entirely on structured output — every agent call is
 * schema-validated JSON. A model that cannot honour `response_format:
 * json_object` does not degrade gracefully here; it falls back on every single
 * call, so the app runs entirely on templates while appearing configured.
 *
 * So this checks the thing that matters, not just whether the key is valid:
 *
 *   1. Does the key authenticate?
 *   2. Which chat models does it list?
 *   3. Which of those actually return valid JSON under json_object mode?
 *
 * Reasoning-style models are the common casualty — they emit thinking tokens
 * that break strict JSON validation, and Groq rejects the completion with
 * `json_validate_failed` and an empty `failed_generation`.
 */
import './_env';

import { getConfig } from '@/lib/config/env';

interface ModelList {
  data?: Array<{ id?: string }>;
}

interface Completion {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string };
}

const NON_CHAT = /whisper|tts|guard|prompt-?guard|embed|orpheus|allam/i;

async function main(): Promise<void> {
  const cfg = getConfig();
  const key = cfg.groqKeys[0];

  if (!key) {
    console.error('\n✖ No Groq key configured. Set GROQ_API_KEY in .env.local and retry.\n');
    process.exitCode = 1;
    return;
  }

  const base = cfg.GROQ_BASE_URL.replace(/\/+$/, '');
  console.log(`\n\x1b[1mGroq model check\x1b[0m  key ending …${key.slice(-4)}\n`);

  // ── 1. list ──
  let models: string[] = [];
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) {
      console.error('✖ Key rejected (HTTP 401). It is invalid, revoked, or mistyped.\n');
      process.exitCode = 1;
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as ModelList;
    models = (payload.data ?? [])
      .map((m) => m.id ?? '')
      .filter((id) => id && !NON_CHAT.test(id))
      .sort();
  } catch (err) {
    console.error(`✖ Could not list models: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`Key is valid. ${models.length} chat model(s) available.\n`);
  console.log('Testing JSON mode — the only capability this pipeline actually requires:\n');

  // ── 2. probe json mode ──
  const usable: Array<{ id: string; ms: number }> = [];

  /** One JSON-mode attempt. Returns latency, or a failure reason. */
  const attempt = async (id: string): Promise<{ ms: number } | { reason: string }> => {
    const started = Date.now();
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: id,
          messages: [
            { role: 'system', content: 'Return one JSON object: {"ok":true}. No prose.' },
            { role: 'user', content: 'Respond.' },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 60,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(45_000),
      });

      const ms = Date.now() - started;
      const payload = (await response.json()) as Completion;

      if (!response.ok || payload.error) {
        return { reason: payload.error?.code ?? `http_${response.status}` };
      }
      JSON.parse(payload.choices?.[0]?.message?.content ?? '');
      return { ms };
    } catch {
      return { reason: 'invalid JSON' };
    }
  };

  for (const id of models) {
    // Twice, and both must pass. Reasoning-style models are *intermittently*
    // valid under JSON mode — they emit thinking tokens that sometimes survive
    // and sometimes do not. A single lucky pass would recommend a model that
    // fails partway through a live demo, which is worse than not recommending
    // it at all.
    const first = await attempt(id);
    if ('reason' in first) {
      console.log(`  \x1b[31m✖\x1b[0m ${id.padEnd(26)} ${first.reason}`);
      continue;
    }

    const second = await attempt(id);
    if ('reason' in second) {
      console.log(
        `  \x1b[33m~\x1b[0m ${id.padEnd(26)} unreliable — passed once, then ${second.reason}`,
      );
      continue;
    }

    const ms = Math.round((first.ms + second.ms) / 2);
    console.log(`  \x1b[32m✓\x1b[0m ${id.padEnd(26)} ${String(ms).padStart(5)}ms  (2/2)`);
    usable.push({ id, ms });
  }

  // ── 3. recommend ──
  console.log('');
  if (usable.length === 0) {
    console.log('\x1b[31m▸ No available model supports JSON mode.\x1b[0m');
    console.log('  The app will run entirely on the deterministic provider — still factually');
    console.log('  correct, but phrasing and translation will be templated.\n');
    process.exitCode = 1;
    return;
  }

  // Ranked by measured latency. Capability cannot be measured from here, and
  // among models that all pass JSON mode, the one that answers fastest is the
  // defensible default — an interview turn is several sequential calls, so
  // latency compounds directly into how the demo feels.
  const ranked = [...usable].sort((a, b) => a.ms - b.ms);
  const best = ranked[0];

  console.log(`\x1b[32m▸ ${usable.length} model(s) passed twice. Set these:\x1b[0m\n`);
  console.log(`    LLM_PROVIDER        = groq`);
  console.log(`    GROQ_MODEL_PRIMARY  = ${best?.id}`);
  console.log(`    GROQ_MODEL_FAST     = ${best?.id}`);
  console.log('');

  if (ranked.length > 1) {
    console.log('  Other verified options, slowest last:');
    for (const m of ranked.slice(1)) console.log(`    ${m.id}  (${m.ms}ms)`);
    console.log('');
  }
}

main().catch((err: unknown) => {
  console.error('\n✖ check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
