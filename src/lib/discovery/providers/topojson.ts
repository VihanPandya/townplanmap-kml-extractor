/**
 * TopoJSON decoding.
 *
 * TopoJSON stores shared boundaries once, as "arcs", and builds each geometry
 * by referencing them. That makes it markedly smaller than GeoJSON for
 * administrative boundaries, which is exactly why boundary datasets are often
 * published in it — so a tool that detects it and then cannot read it is
 * leaving real geometry on the table.
 *
 * Two details carry the decoding:
 *
 *   - **Quantisation.** When a `transform` is present, arc positions are
 *     delta-encoded integers: each position is a cumulative offset from the
 *     previous one, and the result is scaled and translated back into real
 *     coordinates. Skipping the cumulative step yields a shape that is
 *     recognisably wrong; skipping the transform yields coordinates in the
 *     millions.
 *
 *   - **Arc reversal.** A negative arc index means "traverse this arc
 *     backwards", encoded as the one's complement, so arc `-1` is `~(-1) = 0`
 *     reversed. Interior rings are wound the opposite way from exterior ones
 *     and reuse the same arcs, so getting this wrong silently turns holes
 *     inside out.
 *
 * Coordinates are longitude/latitude by the same RFC 7946 convention GeoJSON
 * follows, so there is no axis-order ambiguity here.
 */

import type { Geometry, Position } from '@/lib/geo/types';

export type TopoTransform = { scale: [number, number]; translate: [number, number] };

export type TopoGeometry = {
  type: string;
  id?: string | number;
  properties?: Record<string, unknown>;
  arcs?: unknown;
  coordinates?: unknown;
  geometries?: TopoGeometry[];
};

export type Topology = {
  type: 'Topology';
  transform?: TopoTransform;
  arcs: Position[][];
  objects: Record<string, TopoGeometry>;
  bbox?: number[];
};

export function isTopology(value: unknown): value is Topology {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'Topology' && Array.isArray(candidate.arcs) && typeof candidate.objects === 'object';
}

/**
 * Decode one arc into real coordinates.
 *
 * With a transform present the stored values are cumulative deltas, so each
 * position is the running sum of everything before it.
 */
export function decodeArc(arc: Position[], transform?: TopoTransform): Position[] {
  const out: Position[] = [];

  if (!transform) {
    for (const position of arc) {
      const [x, y] = position;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      out.push([x, y]);
    }
    return out;
  }

  const [scaleX, scaleY] = transform.scale;
  const [translateX, translateY] = transform.translate;
  let x = 0;
  let y = 0;

  for (const position of arc) {
    const [dx, dy] = position;
    if (typeof dx !== 'number' || typeof dy !== 'number') continue;
    x += dx;
    y += dy;
    out.push([x * scaleX + translateX, y * scaleY + translateY]);
  }

  return out;
}

/** Decode every arc in a topology once, so geometries can share the results. */
export function decodeArcs(topology: Topology): Position[][] {
  return topology.arcs.map((arc) => decodeArc(arc, topology.transform));
}

/**
 * Stitch an arc index list into a single line of positions.
 *
 * Consecutive arcs share their join position, so the leading position of each
 * subsequent arc is dropped to avoid a duplicated vertex.
 */
export function stitchArcs(indexes: number[], arcs: Position[][]): Position[] {
  const line: Position[] = [];

  for (const index of indexes) {
    const reversed = index < 0;
    // A negative index is the one's complement of the real one.
    const arc = arcs[reversed ? ~index : index];
    if (!arc) continue;

    const positions = reversed ? [...arc].reverse() : arc;
    if (line.length === 0) {
      line.push(...positions.map((position) => [...position] as Position));
    } else {
      // Drop the shared join position.
      line.push(...positions.slice(1).map((position) => [...position] as Position));
    }
  }

  return line;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    return [...ring, [...first]];
  }
  return ring;
}

/** Apply the transform to a point, which is quantised like an arc position. */
function decodePoint(coordinates: unknown, transform?: TopoTransform): Position | null {
  if (!Array.isArray(coordinates)) return null;
  const [x, y] = coordinates as number[];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!transform) return [x, y];
  return [x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]];
}

function asIndexArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : [];
}

/** Convert one TopoJSON geometry object into GeoJSON. */
export function topoGeometryToGeoJson(
  geometry: TopoGeometry,
  arcs: Position[][],
  transform?: TopoTransform,
): Geometry | null {
  switch (geometry.type) {
    case 'Point': {
      const point = decodePoint(geometry.coordinates, transform);
      return point ? { type: 'Point', coordinates: point } : null;
    }

    case 'MultiPoint': {
      const points = Array.isArray(geometry.coordinates)
        ? geometry.coordinates
            .map((entry) => decodePoint(entry, transform))
            .filter((entry): entry is Position => entry !== null)
        : [];
      return points.length > 0 ? { type: 'MultiPoint', coordinates: points } : null;
    }

    case 'LineString': {
      const line = stitchArcs(asIndexArray(geometry.arcs), arcs);
      return line.length >= 2 ? { type: 'LineString', coordinates: line } : null;
    }

    case 'MultiLineString': {
      const lines = (Array.isArray(geometry.arcs) ? geometry.arcs : [])
        .map((part) => stitchArcs(asIndexArray(part), arcs))
        .filter((line) => line.length >= 2);
      return lines.length > 0 ? { type: 'MultiLineString', coordinates: lines } : null;
    }

    case 'Polygon': {
      const rings = (Array.isArray(geometry.arcs) ? geometry.arcs : [])
        .map((ring) => closeRing(stitchArcs(asIndexArray(ring), arcs)))
        .filter((ring) => ring.length >= 4);
      return rings.length > 0 ? { type: 'Polygon', coordinates: rings } : null;
    }

    case 'MultiPolygon': {
      const polygons = (Array.isArray(geometry.arcs) ? geometry.arcs : [])
        .map((polygon) =>
          (Array.isArray(polygon) ? polygon : [])
            .map((ring) => closeRing(stitchArcs(asIndexArray(ring), arcs)))
            .filter((ring) => ring.length >= 4),
        )
        .filter((polygon) => polygon.length > 0);
      return polygons.length > 0 ? { type: 'MultiPolygon', coordinates: polygons } : null;
    }

    case 'GeometryCollection': {
      const children = (geometry.geometries ?? [])
        .map((child) => topoGeometryToGeoJson(child, arcs, transform))
        .filter((child): child is Geometry => child !== null);
      return children.length > 0 ? { type: 'GeometryCollection', geometries: children } : null;
    }

    default:
      return null;
  }
}

export type TopoFeature = {
  id: string | null;
  /** The object key this feature came from, which names the layer. */
  objectName: string;
  properties: Record<string, string | number | boolean | null>;
  geometry: Geometry | null;
};

/**
 * Flatten a topology into features.
 *
 * Each top-level object is a layer; a `GeometryCollection` object contributes
 * one feature per child, which is how TopoJSON normally represents a layer.
 */
export function topologyToFeatures(topology: Topology, objectName?: string): TopoFeature[] {
  const arcs = decodeArcs(topology);
  const features: TopoFeature[] = [];

  const entries = objectName
    ? Object.entries(topology.objects).filter(([name]) => name === objectName)
    : Object.entries(topology.objects);

  for (const [name, object] of entries) {
    const children =
      object.type === 'GeometryCollection' && Array.isArray(object.geometries)
        ? object.geometries
        : [object];

    for (const child of children) {
      const geometry = topoGeometryToGeoJson(child, arcs, topology.transform);
      features.push({
        id: child.id !== undefined && child.id !== null ? String(child.id) : null,
        objectName: name,
        properties: normaliseProperties(child.properties),
        geometry,
      });
    }
  }

  return features;
}

/** Names of the layers a topology carries. */
export function topologyObjectNames(topology: Topology): string[] {
  return Object.keys(topology.objects ?? {});
}

function normaliseProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!properties) return out;
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = JSON.stringify(value);
  }
  return out;
}
