/**
 * Geometry inspection, validation and CRS application.
 *
 * Everything here operates on GeoJSON geometry objects. Nothing in this module
 * invents, simplifies or repairs geometry beyond closing a polygon ring that
 * the source left open — a lossless correction that KML requires — and every
 * such correction is reported rather than applied silently.
 */

import area from '@turf/area';
import type {
  BoundingBox,
  Geometry,
  GeometryType,
  Position,
} from './types';
import { type CrsIdentification, type Transformer, transformerToWgs84 } from './crs';
import { LIMITS } from '@/lib/config';

export type GeometryStats = {
  type: GeometryType;
  vertices: number;
  rings: number;
  outerRings: number;
  innerRings: number;
  parts: number;
  hasElevation: boolean;
  bbox: BoundingBox | null;
};

export type GeometryIssue = {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'non-finite-coordinate'
    | 'unclosed-ring'
    | 'insufficient-vertices'
    | 'out-of-range'
    | 'empty-geometry'
    | 'too-many-vertices'
    | 'unsupported-type'
    | 'ring-closed';
  message: string;
};

export type GeometryValidation = {
  valid: boolean;
  issues: GeometryIssue[];
  stats: GeometryStats | null;
};

const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

export function isGeometryType(value: unknown): value is GeometryType {
  return typeof value === 'string' && GEOMETRY_TYPES.has(value);
}

/** Walk every coordinate position in a geometry. */
export function eachPosition(geometry: Geometry, visit: (position: Position) => void): void {
  switch (geometry.type) {
    case 'Point':
      visit(geometry.coordinates);
      return;
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(visit);
      return;
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach((line) => line.forEach(visit));
      return;
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
      return;
    case 'GeometryCollection':
      geometry.geometries.forEach((child) => eachPosition(child, visit));
      return;
    default:
      return;
  }
}

/** Map every position through `transform`, producing a new geometry. */
export function mapPositions(geometry: Geometry, transform: Transformer): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: transform(geometry.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map(transform) };
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(transform) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geometry.coordinates.map((line) => line.map(transform)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(transform)) };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(transform))),
      };
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map((child) => mapPositions(child, transform)),
      };
    default:
      return geometry;
  }
}

function ringsOf(geometry: Geometry): Position[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(ringsOf);
  return [];
}

export function describeGeometry(geometry: Geometry): GeometryStats {
  let vertices = 0;
  let hasElevation = false;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  eachPosition(geometry, (position) => {
    vertices += 1;
    const [x, y, z] = position;
    if (typeof z === 'number') hasElevation = true;
    if (typeof x === 'number' && Number.isFinite(x)) {
      if (x < west) west = x;
      if (x > east) east = x;
    }
    if (typeof y === 'number' && Number.isFinite(y)) {
      if (y < south) south = y;
      if (y > north) north = y;
    }
  });

  const polygons = ringsOf(geometry);
  const rings = polygons.reduce((total, polygon) => total + polygon.length, 0);
  const outerRings = polygons.length === 0 ? 0 : polygons.filter((polygon) => polygon.length > 0).length;
  const innerRings = Math.max(0, rings - outerRings);

  let parts = 1;
  if (geometry.type === 'MultiPolygon') parts = geometry.coordinates.length;
  else if (geometry.type === 'MultiLineString') parts = geometry.coordinates.length;
  else if (geometry.type === 'MultiPoint') parts = geometry.coordinates.length;
  else if (geometry.type === 'GeometryCollection') parts = geometry.geometries.length;

  const bbox: BoundingBox | null =
    Number.isFinite(west) && Number.isFinite(south) && Number.isFinite(east) && Number.isFinite(north)
      ? [west, south, east, north]
      : null;

  return {
    type: geometry.type,
    vertices,
    rings,
    outerRings,
    innerRings,
    parts,
    hasElevation,
    bbox,
  };
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Close any polygon ring whose last position does not repeat its first.
 *
 * KML requires closed `LinearRing`s and several services emit open rings. The
 * correction repeats an existing vertex; it never moves or adds a new location,
 * so it cannot change the shape on the ground.
 */
export function closeRings(geometry: Geometry): { geometry: Geometry; closed: number } {
  let closed = 0;

  const closeRing = (ring: Position[]): Position[] => {
    if (ring.length === 0) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && !positionsEqual(first, last)) {
      closed += 1;
      return [...ring, [...first]];
    }
    return ring;
  };

  switch (geometry.type) {
    case 'Polygon':
      return { geometry: { type: 'Polygon', coordinates: geometry.coordinates.map(closeRing) }, closed };
    case 'MultiPolygon':
      return {
        geometry: {
          type: 'MultiPolygon',
          coordinates: geometry.coordinates.map((polygon) => polygon.map(closeRing)),
        },
        closed,
      };
    case 'GeometryCollection': {
      const geometries = geometry.geometries.map((child) => {
        const result = closeRings(child);
        closed += result.closed;
        return result.geometry;
      });
      return { geometry: { type: 'GeometryCollection', geometries }, closed };
    }
    default:
      return { geometry, closed };
  }
}

/**
 * Validate a geometry that is already in WGS84.
 *
 * Longitude/latitude range checks only make sense once coordinates are in
 * degrees, so run this *after* transformation, not before.
 */
export function validateWgs84Geometry(geometry: Geometry): GeometryValidation {
  const issues: GeometryIssue[] = [];

  if (!isGeometryType(geometry.type)) {
    return {
      valid: false,
      issues: [
        { severity: 'error', code: 'unsupported-type', message: `Geometry type "${String(geometry.type)}" is not supported.` },
      ],
      stats: null,
    };
  }

  const stats = describeGeometry(geometry);

  if (stats.vertices === 0) {
    issues.push({ severity: 'error', code: 'empty-geometry', message: 'Geometry contains no coordinates.' });
    return { valid: false, issues, stats };
  }

  if (stats.vertices > LIMITS.maxVerticesPerGeometry) {
    issues.push({
      severity: 'error',
      code: 'too-many-vertices',
      message: `Geometry has ${stats.vertices.toLocaleString()} vertices, above the ${LIMITS.maxVerticesPerGeometry.toLocaleString()} limit.`,
    });
    return { valid: false, issues, stats };
  }

  let nonFinite = 0;
  let outOfRange = 0;
  eachPosition(geometry, (position) => {
    const [x, y] = position;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      nonFinite += 1;
      return;
    }
    if (x < -180 || x > 180 || y < -90 || y > 90) outOfRange += 1;
  });

  if (nonFinite > 0) {
    issues.push({
      severity: 'error',
      code: 'non-finite-coordinate',
      message: `${nonFinite} coordinate value(s) are NaN, Infinity or non-numeric.`,
    });
  }
  if (outOfRange > 0) {
    issues.push({
      severity: 'error',
      code: 'out-of-range',
      message: `${outOfRange} coordinate(s) fall outside the valid WGS84 range (±180 longitude, ±90 latitude).`,
    });
  }

  for (const polygon of ringsOf(geometry)) {
    for (const ring of polygon) {
      if (ring.length > 0 && ring.length < 4) {
        issues.push({
          severity: 'error',
          code: 'insufficient-vertices',
          message: `A polygon ring has ${ring.length} position(s); a closed ring needs at least 4.`,
        });
        continue;
      }
      if (ring.length > 0 && !positionsEqual(ring[0], ring[ring.length - 1])) {
        issues.push({
          severity: 'error',
          code: 'unclosed-ring',
          message: 'A polygon ring does not close: its last position differs from its first.',
        });
      }
    }
  }

  if (geometry.type === 'LineString' && geometry.coordinates.length < 2) {
    issues.push({
      severity: 'error',
      code: 'insufficient-vertices',
      message: 'A LineString needs at least two positions.',
    });
  }

  return { valid: issues.every((issue) => issue.severity !== 'error'), issues, stats };
}

export type PreparedGeometry = {
  geometry: Geometry;
  validation: GeometryValidation;
  /** Rings the preparation step closed. */
  ringsClosed: number;
  /** True when a CRS transformation was applied. */
  transformed: boolean;
  sourceCrs: CrsIdentification;
};

export type PreparationFailure = {
  ok: false;
  reason: string;
  /** Set when the failure is specifically an unusable CRS. */
  crs?: CrsIdentification;
};

/**
 * Take a geometry in its source CRS and produce a validated WGS84 geometry
 * ready for KML.
 *
 * Refuses rather than guesses: a geometry whose CRS the source never declared
 * is not quietly treated as degrees.
 */
export function prepareForKml(
  geometry: Geometry,
  sourceCrs: CrsIdentification,
): ({ ok: true } & PreparedGeometry) | PreparationFailure {
  if (!sourceCrs.code) {
    return {
      ok: false,
      reason:
        'The coordinate reference system of this geometry is unknown, so it cannot be converted to the ' +
        'WGS84 coordinates KML requires. Producing KML from it would mean guessing at its position.',
      crs: sourceCrs,
    };
  }

  const transformer = transformerToWgs84(sourceCrs.code);
  if (!transformer) {
    return {
      ok: false,
      reason: `No transformation from ${sourceCrs.code} to WGS84 is available in this build.`,
      crs: sourceCrs,
    };
  }

  let projected: Geometry;
  try {
    projected = sourceCrs.isWgs84 ? geometry : mapPositions(geometry, transformer);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Coordinate transformation failed.',
      crs: sourceCrs,
    };
  }

  const { geometry: closed, closed: ringsClosed } = closeRings(projected);
  const validation = validateWgs84Geometry(closed);
  if (ringsClosed > 0) {
    validation.issues.push({
      severity: 'info',
      code: 'ring-closed',
      message: `${ringsClosed} polygon ring(s) were left open by the source and were closed by repeating the first vertex.`,
    });
  }

  return {
    ok: true,
    geometry: closed,
    validation,
    ringsClosed,
    transformed: !sourceCrs.isWgs84,
    sourceCrs,
  };
}

/** Planar area in square metres, for WGS84 geometry. Null for non-areal types. */
export function areaSquareMetres(geometry: Geometry): number | null {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon' && geometry.type !== 'GeometryCollection') {
    return null;
  }
  try {
    const value = area(geometry as never);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatArea(squareMetres: number | null): string | null {
  if (squareMetres === null) return null;
  if (squareMetres >= 10_000) return `${(squareMetres / 10_000).toFixed(2)} ha`;
  return `${Math.round(squareMetres).toLocaleString()} m²`;
}

/** Union of two bounding boxes. */
export function mergeBbox(a: BoundingBox | null, b: BoundingBox | null): BoundingBox | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
