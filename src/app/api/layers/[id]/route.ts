/** GET /api/layers/:id — one layer's description and data-source detail. */

import { getLayer } from '@/lib/catalog';
import { getStore } from '@/lib/db';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const layer = await getLayer(id);
  if (!layer) return fail(404, 'Unknown layer.');

  const store = await getStore();
  const cachedFeatures = await store.countFeatures(id);

  return ok({
    layer,
    dataSource: {
      type: layer.endpointKind,
      geometry: layer.availability.status === 'vector'
        ? layer.availability.geometryTypes.join(', ') || 'Reported per feature'
        : 'Not available',
      features: layer.featureCount,
      coordinateSystem: layer.crs.code ?? 'Unknown',
      crsConfidence: layer.crs.confidence,
      crsNote: layer.crs.note,
      kmlExport: layer.kmlExportable,
      kmlNote: layer.kmlNote,
    },
    cachedFeatures,
  });
});
