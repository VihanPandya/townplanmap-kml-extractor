/** GET /api/layers — every layer in the catalog. */

import { discoverLayers } from '@/lib/catalog';
import { handler, ok, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = handler(async (request) => {
  const params = searchParams(request);
  const result = await discoverLayers(params.get('locationId'), {
    refresh: params.get('refresh') === '1',
    signal: request.signal,
  });
  return ok({ layers: result.layers, notes: result.notes, rasterOnly: result.rasterOnly });
});
