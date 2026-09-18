/** GET /api/features/:id — one feature's attributes and metadata. */

import { getFeature, getLayer } from '@/lib/catalog';
import { formatArea } from '@/lib/geo/geometry';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const feature = await getFeature(id);
  if (!feature) return fail(404, 'Unknown feature.');

  const layer = await getLayer(feature.layerId);

  return ok({
    feature,
    layer: layer ? { id: layer.id, name: layer.name, category: layer.category } : null,
    areaLabel: formatArea(feature.areaSquareMetres),
  });
});
