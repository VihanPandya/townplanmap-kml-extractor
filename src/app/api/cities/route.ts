/** GET /api/cities — cities discovered from the source. */

import { listCities } from '@/lib/catalog';
import { handler, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const cities = await listCities();
  return ok({
    cities,
    note:
      cities.length === 0
        ? 'No city list has been discovered yet. Connect to the source first; if a list still does not appear, ' +
          'the source may not expose one in a form this tool can read.'
        : null,
  });
});
