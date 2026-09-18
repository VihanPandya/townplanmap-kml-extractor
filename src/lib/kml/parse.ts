/**
 * KML reading.
 *
 * Needed in two places: when the source publishes KML directly (that is already
 * the geometry we want, so it is read rather than re-derived), and for the
 * built-in viewer, which renders a generated document by parsing it back.
 *
 * Parsing goes through the hardened XML parser, so a KML file cannot carry an
 * entity-expansion payload into the server.
 */

import { safeParseXml, asArray, pick, text } from '@/lib/xml/safe-parse';
import type { Geometry, Position, FeatureProperties } from '@/lib/geo/types';

export type ParsedPlacemark = {
  name: string | null;
  description: string | null;
  geometry: Geometry | null;
  properties: FeatureProperties;
  /** Folder names from the document root down to this placemark. */
  folderPath: string[];
};

export type ParsedKml = {
  documentName: string | null;
  placemarks: ParsedPlacemark[];
};

/**
 * Parse a KML `<coordinates>` block.
 *
 * KML writes `lon,lat[,alt]` tuples separated by whitespace — note the ordering
 * is longitude first, matching GeoJSON, which is why no axis swap is needed.
 */
export function parseCoordinates(raw: string | undefined): Position[] {
  if (!raw) return [];
  const positions: Position[] = [];
  for (const tuple of raw.trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(',');
    const lon = Number.parseFloat(parts[0] ?? '');
    const lat = Number.parseFloat(parts[1] ?? '');
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const alt = parts.length > 2 ? Number.parseFloat(parts[2] ?? '') : Number.NaN;
    positions.push(Number.isFinite(alt) ? [lon, lat, alt] : [lon, lat]);
  }
  return positions;
}

function polygonRings(node: unknown): Position[][] {
  const rings: Position[][] = [];
  const outer = parseCoordinates(
    text(pick(node, 'outerBoundaryIs', 'LinearRing', 'coordinates')),
  );
  if (outer.length > 0) rings.push(outer);
  for (const inner of asArray(pick(node, 'innerBoundaryIs') as unknown)) {
    const ring = parseCoordinates(text(pick(inner, 'LinearRing', 'coordinates')));
    if (ring.length > 0) rings.push(ring);
  }
  return rings;
}

/** Turn one KML geometry element into GeoJSON. */
export function kmlGeometryToGeoJson(node: Record<string, unknown>): Geometry | null {
  if (node.Point) {
    const point = asArray(node.Point as unknown)[0];
    const positions = parseCoordinates(text(pick(point, 'coordinates')));
    return positions[0] ? { type: 'Point', coordinates: positions[0] } : null;
  }

  if (node.LineString) {
    const lines = asArray(node.LineString as unknown)
      .map((line) => parseCoordinates(text(pick(line, 'coordinates'))))
      .filter((line) => line.length >= 2);
    if (lines.length === 0) return null;
    return lines.length === 1 && lines[0]
      ? { type: 'LineString', coordinates: lines[0] }
      : { type: 'MultiLineString', coordinates: lines };
  }

  if (node.LinearRing && !node.Polygon) {
    const ring = parseCoordinates(text(pick(asArray(node.LinearRing as unknown)[0], 'coordinates')));
    return ring.length >= 4 ? { type: 'Polygon', coordinates: [ring] } : null;
  }

  if (node.Polygon) {
    const polygons = asArray(node.Polygon as unknown)
      .map((polygon) => polygonRings(polygon))
      .filter((rings) => rings.length > 0);
    if (polygons.length === 0) return null;
    return polygons.length === 1 && polygons[0]
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }

  if (node.MultiGeometry) {
    const container = asArray(node.MultiGeometry as unknown)[0] as Record<string, unknown> | undefined;
    if (!container) return null;
    const children: Geometry[] = [];
    for (const key of ['Point', 'LineString', 'Polygon', 'LinearRing'] as const) {
      for (const child of asArray(container[key] as unknown)) {
        const geometry = kmlGeometryToGeoJson({ [key]: child } as Record<string, unknown>);
        if (geometry) children.push(geometry);
      }
    }
    if (children.length === 0) return null;
    if (children.length === 1 && children[0]) return children[0];

    // Collapse a homogeneous collection into the matching Multi* type, which is
    // what the source meant; keep a GeometryCollection only for mixed content.
    const types = new Set(children.map((child) => child.type));
    if (types.size === 1) {
      const only = [...types][0];
      if (only === 'Polygon') {
        return {
          type: 'MultiPolygon',
          coordinates: children.map((child) => (child as { coordinates: Position[][] }).coordinates),
        };
      }
      if (only === 'LineString') {
        return {
          type: 'MultiLineString',
          coordinates: children.map((child) => (child as { coordinates: Position[] }).coordinates),
        };
      }
      if (only === 'Point') {
        return {
          type: 'MultiPoint',
          coordinates: children.map((child) => (child as { coordinates: Position }).coordinates),
        };
      }
    }
    return { type: 'GeometryCollection', geometries: children };
  }

  return null;
}

function extendedDataToProperties(node: unknown): FeatureProperties {
  const properties: FeatureProperties = {};
  const extended = pick(node, 'ExtendedData');
  if (!extended) return properties;

  for (const entry of asArray(pick(extended, 'Data') as unknown)) {
    const name = text(pick(entry, '@name'));
    if (!name) continue;
    properties[name] = text(pick(entry, 'value')) ?? null;
  }

  // Also read the SchemaData form some producers use.
  for (const schema of asArray(pick(extended, 'SchemaData') as unknown)) {
    for (const entry of asArray(pick(schema, 'SimpleData') as unknown)) {
      const name = text(pick(entry, '@name'));
      if (!name) continue;
      properties[name] = text(entry) ?? null;
    }
  }

  return properties;
}

function collectPlacemarks(
  node: Record<string, unknown>,
  folderPath: string[],
  out: ParsedPlacemark[],
  depth: number,
): void {
  if (depth > 32) return; // Guard against a pathologically nested document.

  for (const placemark of asArray(node.Placemark as unknown)) {
    const record = placemark as Record<string, unknown>;
    out.push({
      name: text(record.name) ?? null,
      description: text(record.description) ?? null,
      geometry: kmlGeometryToGeoJson(record),
      properties: extendedDataToProperties(record),
      folderPath: [...folderPath],
    });
  }

  for (const folder of asArray(node.Folder as unknown)) {
    const record = folder as Record<string, unknown>;
    collectPlacemarks(record, [...folderPath, text(record.name) ?? 'Folder'], out, depth + 1);
  }

  for (const document of asArray(node.Document as unknown)) {
    const record = document as Record<string, unknown>;
    // The outermost <Document> is the document itself, so its name is the file
    // title rather than a folder level. Nested <Document> elements are legal
    // and *do* act as containers, so those keep contributing to the path.
    const name = depth === 0 ? null : text(record.name);
    collectPlacemarks(record, name ? [...folderPath, name] : folderPath, out, depth + 1);
  }
}

export function parseKml(xml: string): { ok: true; kml: ParsedKml } | { ok: false; reason: string } {
  const parsed = safeParseXml(xml);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = pick(parsed.doc, 'kml') as Record<string, unknown> | undefined;
  if (!root) return { ok: false, reason: 'Document has no <kml> root element.' };

  const placemarks: ParsedPlacemark[] = [];
  const documentNode = asArray(root.Document as unknown)[0] as Record<string, unknown> | undefined;
  const documentName = documentNode ? (text(documentNode.name) ?? null) : null;

  collectPlacemarks(root, [], placemarks, 0);

  return { ok: true, kml: { documentName, placemarks } };
}

/** Convert a parsed KML document into a GeoJSON FeatureCollection. */
export function kmlToFeatureCollection(kml: ParsedKml): {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; geometry: Geometry | null; properties: FeatureProperties }>;
} {
  return {
    type: 'FeatureCollection',
    features: kml.placemarks.map((placemark) => ({
      type: 'Feature' as const,
      geometry: placemark.geometry,
      properties: {
        ...placemark.properties,
        ...(placemark.name ? { name: placemark.name } : {}),
        ...(placemark.folderPath.length > 0 ? { _folder: placemark.folderPath.join(' / ') } : {}),
      },
    })),
  };
}
