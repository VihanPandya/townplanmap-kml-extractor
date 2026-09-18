/** GET /api/cities/:id/areas — villages and localities inside a city. */

import { listAreas } from '@/lib/catalog';
import { getStore } from '@/lib/db';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const store = await getStore();
  const city = await store.getLocation(id);
  if (!city) return fail(404, 'Unknown city.');

  const { areas, note } = await listAreas(id);
  return ok({ city, areas, note });
});
