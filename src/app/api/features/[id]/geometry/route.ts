/**
 * GET /api/features/:id/geometry — a feature's geometry, with the inspector
 * detail the UI shows alongside it.
 *
 * Geometry is fetched upstream if the catalog does not hold it yet, then
 * transformed and validated exactly as an export would, so the inspector shows
 * the same verdict the exporter will reach.
 */

import { ensureGeometry, getFeature } from '@/lib/catalog';
import { describeGeometry, prepareForKml, formatArea } from '@/lib/geo/geometry';
import { crsLabel } from '@/lib/geo/crs';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = handler(async (request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const stored = await getFeature(id);
  if (!stored) return fail(404, 'Unknown feature.');

  const feature = await ensureGeometry(stored, request.signal);

  if (!feature.geometry) {
    return ok({
      feature: { ...feature, geometry: null },
      geometry: null,
      inspector: {
        type: 'Not available',
        coordinates: 'Not available',
        vertices: 0,
        rings: 0,
        outerBoundary: 'Not available',
        innerBoundaries: 0,
        crs: crsLabel(feature.crs),
        crsConfidence: feature.crs.confidence,
      },
      kmlAvailable: false,
      kmlNote:
        feature.provenance === 'image-only'
          ? 'Map image detected. Underlying vector geometry was not found. KML export cannot be generated reliably.'
          : feature.kmlNote || 'No geometry is available for this feature.',
      validation: null,
    });
  }

  const stats = describeGeometry(feature.geometry);
  const prepared = prepareForKml(feature.geometry, feature.crs);

  return ok({
    feature,
    // Always hand the client WGS84 so the map can draw it without re-projecting.
    geometry: prepared.ok ? prepared.geometry : null,
    sourceGeometry: feature.geometry,
    inspector: {
      type: stats.type,
      coordinates: 'Available',
      vertices: stats.vertices,
      rings: stats.rings,
      outerBoundary: stats.outerRings > 0 ? 'Available' : 'Not applicable',
      innerBoundaries: stats.innerRings,
      parts: stats.parts,
      hasElevation: stats.hasElevation,
      bbox: stats.bbox,
      crs: crsLabel(feature.crs),
      crsConfidence: feature.crs.confidence,
      crsNote: feature.crs.note,
      transformed: prepared.ok ? prepared.transformed : false,
    },
    areaLabel: formatArea(feature.areaSquareMetres),
    kmlAvailable: prepared.ok && prepared.validation.valid,
    kmlNote: prepared.ok
      ? prepared.validation.valid
        ? feature.kmlNote
        : 'The geometry did not pass validation, so KML cannot be generated from it.'
      : prepared.reason,
    validation: prepared.ok ? prepared.validation : null,
  });
});
