/**
 * GET /api/health
 *
 * Deployment liveness plus an honest capability report. The capability half
 * matters as much as the liveness half: this system has several supported
 * degraded modes (no LLM credentials, hash embeddings, no ANN index), and the
 * difference between "degraded but correct" and "broken" has to be visible
 * rather than inferred from odd output.
 *
 * `?deep=1` additionally checks the knowledge base and provenance, which is
 * what the pre-demo check and the container health check use.
 */
import { z } from 'zod';
import { describeCapabilities, getConfig } from '@/lib/config/env';
import { sql } from '@/lib/db/client';
import { assertEmbeddingDim } from '@/lib/db/migrate';
import { provenanceSummary } from '@/lib/db/knowledge';
import { breakerSnapshot } from '@/lib/llm/client';
import { poolSnapshots } from '@/lib/llm/providers';
import { route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QuerySchema = z.object({
  deep: z.string().optional(),
});

type Check = { name: string; ok: boolean; detail: string };

export const GET = route(
  { querySchema: QuerySchema, skipRateLimit: true },
  async ({ query }) => {
    const cfg = getConfig();
    const checks: Check[] = [];
    const deep = query.deep === '1' || query.deep === 'true';

    let databaseOk = false;
    const started = Date.now();
    try {
      await sql('SELECT 1');
      databaseOk = true;
      checks.push({ name: 'database', ok: true, detail: `${cfg.DB_DRIVER} reachable in ${Date.now() - started}ms` });
    } catch (err) {
      checks.push({
        name: 'database',
        ok: false,
        detail: err instanceof Error ? err.message : 'unreachable',
      });
    }

    if (databaseOk) {
      try {
        await assertEmbeddingDim();
        checks.push({ name: 'embedding_dim', ok: true, detail: `vector(${cfg.EMBEDDING_DIM}) consistent` });
      } catch (err) {
        checks.push({
          name: 'embedding_dim',
          ok: false,
          detail: err instanceof Error ? err.message : 'mismatch',
        });
      }
    }

    const capabilities = describeCapabilities();

    const body: Record<string, unknown> = {
      // `ok` reflects correctness, not completeness: running on the
      // deterministic provider is a supported mode, not an outage.
      ok: checks.every((c) => c.ok),
      version: process.env.npm_package_version ?? '1.0.0',
      environment: cfg.APP_ENV,
      timestamp: new Date().toISOString(),
      checks,
      capabilities,
      llm: {
        breakers: breakerSnapshot(),
        keyPools: poolSnapshots(),
      },
    };

    if (deep && databaseOk) {
      const [counts] = await sql<{
        services: number;
        requirements: number;
        chunks: number;
        embedded: number;
        sessions: number;
      }>(`
        SELECT
          (SELECT count(*) FROM services WHERE is_active)::int      AS services,
          (SELECT count(*) FROM requirements)::int                  AS requirements,
          (SELECT count(*) FROM document_chunks)::int               AS chunks,
          (SELECT count(embedding) FROM document_chunks)::int       AS embedded,
          (SELECT count(*) FROM sessions WHERE expires_at > NOW())::int AS sessions
      `);

      const provenance = await provenanceSummary();

      body.knowledgeBase = counts ?? null;
      body.provenance = provenance;
      // Surfaced deliberately. A judge asking "how much of this is verified?"
      // gets a number from the running system, not a claim from a slide.
      body.provenanceNote =
        'Facts marked unverified or synthetic render with a visible badge in the UI. ' +
        'See docs/DATA_PROVENANCE.md.';

      if ((counts?.services ?? 0) === 0) {
        checks.push({ name: 'knowledge_base', ok: false, detail: 'no services seeded; run npm run db:seed' });
        body.ok = false;
      }
    }

    return body;
  },
);
