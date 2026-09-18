/**
 * Esri JSON geometry to GeoJSON.
 *
 * ArcGIS services can emit GeoJSON directly (`f=geojson`) on 10.4 and later,
 * but plenty of deployments in the wild are older or have it disabled, so the
 * native `f=json` form has to be understood too.
 *
 * The one real subtlety is polygons: Esri puts every ring of every part into a
 * single flat `rings` array and distinguishes outer rings from holes by
 * winding order (outer rings clockwise, holes counter-clockwise) rather than by
 * nesting. Reconstructing GeoJSON's explicit nesting means reading that winding
 * order — which is what `ringIsClockwise` below does.
 */

import type { Geometry, Position } from '@/lib/geo/types';

export type EsriGeometry = {
  x?: number;
  y?: number;
  z?: number;
  points?: Position[];
  paths?: Position[][];
  rings?: Position[][];
  spatialReference?: { wkid?: number; latestWkid?: number; wkt?: string };
};

export type EsriFeature = {
  attributes?: Record<string, unknown>;
  geometry?: EsriGeometry;
};

/**
 * Signed area of a ring using the shoelace formula. Positive means clockwise in
 * the screen/Esri sense (y increasing upward, ring wound clockwise gives a
 * negative shoelace sum, so the sign convention is fixed here explicitly).
 */
export function ringSignedArea(ring: Position[]): number {
  let total = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (!current || !next) continue;
    const [x1, y1] = current;
    const [x2, y2] = next;
    if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
      continue;
    }
    total += (x2 - x1) * (y2 + y1);
  }
  return total;
}

/** Esri outer rings are clockwise; a positive shoelace sum in this convention. */
export function ringIsClockwise(ring: Position[]): boolean {
  return ringSignedArea(ring) > 0;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    return [...ring, [...first]];
  }
  return ring;
}

/**
 * Group Esri's flat ring list into GeoJSON polygons.
 *
 * Each clockwise ring opens a new polygon; counter-clockwise rings are holes
 * belonging to the polygon most recently opened. When a service emits holes
 * before any outer ring — which happens with malformed data — the orphan ring
 * is promoted to its own polygon rather than being dropped, so no geometry is
 * silently lost.
 */
export function ringsToPolygons(rings: Position[][]): Position[][][] {
  const polygons: Position[][][] = [];
  let current: Position[][] | null = null;

  for (const raw of rings) {
    if (raw.length < 3) continue;
    const ring = closeRing(raw);
    if (ringIsClockwise(ring) || current === null) {
      current = [ring];
      polygons.push(current);
    } else {
      current.push(ring);
    }
  }

  return polygons;
}

/** Convert one Esri geometry object to GeoJSON. Returns null when empty. */
export function esriGeometryToGeoJson(geometry: EsriGeometry | null | undefined): Geometry | null {
  if (!geometry) return null;

  if (typeof geometry.x === 'number' && typeof geometry.y === 'number') {
    if (!Number.isFinite(geometry.x) || !Number.isFinite(geometry.y)) return null;
    const coordinates: Position =
      typeof geometry.z === 'number' && Number.isFinite(geometry.z)
        ? [geometry.x, geometry.y, geometry.z]
        : [geometry.x, geometry.y];
    return { type: 'Point', coordinates };
  }

  if (Array.isArray(geometry.points)) {
    const points = geometry.points.filter((point) => Array.isArray(point) && point.length >= 2);
    if (points.length === 0) return null;
    return points.length === 1 && points[0]
      ? { type: 'Point', coordinates: points[0] }
      : { type: 'MultiPoint', coordinates: points };
  }

  if (Array.isArray(geometry.paths)) {
    const paths = geometry.paths.filter((path) => Array.isArray(path) && path.length >= 2);
    if (paths.length === 0) return null;
    return paths.length === 1 && paths[0]
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths };
  }

  if (Array.isArray(geometry.rings)) {
    const polygons = ringsToPolygons(geometry.rings);
    if (polygons.length === 0) return null;
    return polygons.length === 1 && polygons[0]
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }

  return null;
}

/** Map an Esri geometry type name to the GeoJSON family it produces. */
export function esriGeometryTypeToGeoJson(esriType: string | null | undefined): string | null {
  switch (esriType) {
    case 'esriGeometryPoint':
      return 'Point';
    case 'esriGeometryMultipoint':
      return 'MultiPoint';
    case 'esriGeometryPolyline':
      return 'MultiLineString';
    case 'esriGeometryPolygon':
      return 'MultiPolygon';
    case 'esriGeometryEnvelope':
      return 'Polygon';
    default:
      return null;
  }
}

/** Flatten Esri attribute values to the scalar types GeoJSON properties allow. */
export function normaliseAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}
