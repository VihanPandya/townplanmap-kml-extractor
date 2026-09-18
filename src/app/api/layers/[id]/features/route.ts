/**
 * GET /api/layers/:id/features — a page of features from a layer.
 *
 * Geometry is omitted by default: a list view needs names and attributes, and
 * pulling every polygon for a table would be slow and wasteful. The map and the
 * detail view request it explicitly.
 */

import { listFeatures } from '@/lib/catalog';
import { getLayer } from '@/lib/catalog';
import { LIMITS } from '@/lib/config';
import { fail, handler, intParam, ok, pathParam, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = handler(async (request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const layer = await getLayer(id);
  if (!layer) return fail(404, 'Unknown layer.');

  const params = searchParams(request);
  const limit = intParam(params, 'limit', 200, LIMITS.featurePageSize);
  const search = params.get('search');
  const cursor = params.get('cursor');
  const includeGeometry = params.get('geometry') === '1';

  let bbox: [number, number, number, number] | null = null;
  const bboxParam = params.get('bbox');
  if (bboxParam) {
    const parts = bboxParam.split(',').map(Number);
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      bbox = parts as [number, number, number, number];
    }
  }

  const result = await listFeatures(
    id,
    { limit, search, cursor, includeGeometry, bbox },
    request.signal,
  );

  return ok({
    layer: {
      id: layer.id,
      name: layer.name,
      category: layer.category,
      fields: layer.fields,
      availability: layer.availability,
      crs: layer.crs,
      kmlExportable: layer.kmlExportable,
      kmlNote: layer.kmlNote,
      bbox: layer.bbox,
      attribution: layer.attribution,
    },
    features: result.features,
    nextCursor: result.nextCursor,
    total: result.total,
    notes: result.notes,
    truncated: result.truncated,
  });
});
