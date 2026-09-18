/** GET /api/areas/:id/layers — map layers available for an area. */

import { discoverLayers } from '@/lib/catalog';
import { getStore } from '@/lib/db';
import { fail, handler, ok, pathParam, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = handler(async (request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const params = searchParams(request);
  const refresh = params.get('refresh') === '1';

  const store = await getStore();
  // `all` means "everything discovered", not scoped to one area.
  const locationId = id === 'all' ? null : id;
  const location = locationId ? await store.getLocation(locationId) : null;

  const result = await discoverLayers(locationId, { refresh, signal: request.signal });

  return ok({
    location,
    layers: result.layers,
    notes: result.notes,
    rasterOnly: result.rasterOnly,
  });
});
