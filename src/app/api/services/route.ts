/**
 * GET /api/services
 *
 * The catalogue, used by the landing page and by the disambiguation prompt.
 * Carries provenance per service so the UI can badge unverified content
 * everywhere it appears, not only inside a plan.
 */
import { listServices } from '@/lib/db/knowledge';
import { route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route({ skipRateLimit: true }, async () => {
  const services = await listServices();

  return {
    services: services.map((s) => ({
      code: s.code,
      name: s.name,
      summary: s.summary,
      category: s.category,
      department: s.departmentName,
      officialUrl: s.officialUrl,
      onlineApplicationUrl: s.onlineApplicationUrl,
      verificationStatus: s.verificationStatus,
      source: s.source,
    })),
  };
});
