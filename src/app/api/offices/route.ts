/**
 * GET /api/offices?service=cnic&city=Karachi
 *
 * Office finder. Ranked by locality specificity (exact city, then province)
 * rather than distance, because citizens give a city name and not coordinates.
 *
 * Every row carries its verification status. The seeded offices are synthetic
 * placeholders with no street address, and the UI says so and links to the
 * department's own locator — an unverified address a citizen travels to is
 * worse than no address at all.
 */
import { z } from 'zod';
import { findOffices, getServiceByCode } from '@/lib/db/knowledge';
import { badRequest, route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QuerySchema = z.object({
  service: z.string().min(1).max(64),
  city: z.string().max(80).optional(),
  province: z.string().max(80).optional(),
  limit: z.string().optional(),
});

export const GET = route({ querySchema: QuerySchema, skipRateLimit: true }, async ({ query }) => {
  const service = await getServiceByCode(query.service);
  if (!service) throw badRequest(`Unknown service '${query.service}'.`);

  const limit = Math.min(20, Math.max(1, Number.parseInt(query.limit ?? '5', 10) || 5));

  const offices = await findOffices({
    serviceId: service.id,
    city: query.city ?? null,
    province: query.province ?? null,
    limit,
  });

  const anySynthetic = offices.some((o) => o.verificationStatus === 'synthetic');

  return {
    offices: offices.map((o) => ({
      code: o.code,
      name: o.name,
      officeType: o.officeType,
      address: o.address,
      city: o.city,
      district: o.district,
      province: o.province,
      phone: o.phone,
      hours: o.hours,
      appointmentUrl: o.appointmentUrl,
      verificationStatus: o.verificationStatus,
      source: o.source,
    })),
    ...(anySynthetic
      ? {
          notice:
            'These office records are structural placeholders and carry no verified street address. ' +
            'Use the department’s official locator, linked on each card, for the actual address.',
        }
      : {}),
  };
});
