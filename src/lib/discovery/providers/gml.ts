/**
 * GML reading, for WFS servers that cannot emit GeoJSON.
 *
 * Plenty of GeoServer and MapServer deployments in the wild — including a good
 * share of municipal ones — offer only GML output. Without this they are
 * detected, reported and then unusable, so this closes the most common gap
 * between "vector geometry exists" and "KML can be produced from it".
 *
 * ## The axis-order trap
 *
 * This is the one genuinely dangerous part of reading GML, and the reason this
 * module is careful rather than short.
 *
 * `EPSG:4326` defines its axes as **latitude first**. The old short form
 * `EPSG:4326` was nevertheless used by almost everyone to mean longitude
 * first, so OGC introduced the URN form `urn:ogc:def:crs:EPSG::4326` to mean
 * the authority's real order — latitude first. The two spellings of "the same"
 * CRS therefore imply *opposite* coordinate orders.
 *
 * Getting this wrong does not throw and does not look broken: it silently
 * transposes every coordinate, and a parcel in Gujarat is written into the
 * Indian Ocean off Somalia. Since this tool's entire claim is that it does not
 * publish geometry it cannot vouch for, the order is derived from the declared
 * `srsName` by explicit rule, and where no `srsName` is declared at all the
 * geometry is rejected rather than guessed at.
 *
 * A sanity check backs the rule up: see `plausibleForIndia` below.
 */

import { safeParseXml, asArray, pick, text } from '@/lib/xml/safe-parse';
import type { Geometry, Position } from '@/lib/geo/types';
import { normaliseCrsCode } from '@/lib/geo/crs';

export type AxisOrder = 'lon-lat' | 'lat-lon';

export type SrsInterpretation = {
  code: string | null;
  axisOrder: AxisOrder;
  /** How the axis order was arrived at, for the provenance note. */
  reason: string;
  /** False when no srsName was declared, so nothing can be relied on. */
  declared: boolean;
};

/**
 * Work out the CRS and axis order from a `srsName`.
 *
 * The rules, in the order they are applied:
 *   1. `CRS:84` / `urn:ogc:def:crs:OGC:...:CRS84` is longitude first, always.
 *      That is the whole reason CRS84 exists.
 *   2. A URN (`urn:ogc:def:crs:EPSG::4326`) or an OGC HTTP URI
 *      (`http://www.opengis.net/def/crs/EPSG/0/4326`) means the authority's
 *      own axis order. For geographic CRSs that is latitude first.
 *   3. The short form (`EPSG:4326`) means longitude first, by long convention.
 *   4. A projected CRS (UTM and friends) is easting/northing, which maps to
 *      x,y — the same ordering as longitude first.
 */
export function interpretSrsName(srsName: string | undefined | null): SrsInterpretation {
  if (!srsName || !srsName.trim()) {
    return {
      code: null,
      axisOrder: 'lon-lat',
      reason: 'No srsName was declared on the geometry.',
      declared: false,
    };
  }

  const raw = srsName.trim();
  const code = normaliseCrsCode(raw);
  const upper = raw.toUpperCase();

  // 1. CRS84 is defined as longitude/latitude.
  if (upper.includes('CRS84') || upper === 'CRS:84') {
    return {
      code: 'EPSG:4326',
      axisOrder: 'lon-lat',
      reason: 'CRS84 is defined as longitude/latitude order.',
      declared: true,
    };
  }

  const isUrn = /^urn:/i.test(raw);
  const isOgcUri = /opengis\.net\/def\/crs/i.test(raw);

  // 4. A projected CRS is easting/northing regardless of spelling.
  if (code && isProjected(code)) {
    return {
      code,
      axisOrder: 'lon-lat',
      reason: `${code} is a projected CRS, so its axes are easting/northing.`,
      declared: true,
    };
  }

  // 2. Authority-order spellings put latitude first for a geographic CRS.
  if (isUrn || isOgcUri) {
    return {
      code,
      axisOrder: 'lat-lon',
      reason:
        `${raw} is the authority form, which uses the EPSG axis order — ` +
        'latitude before longitude for a geographic CRS.',
      declared: true,
    };
  }

  // 3. The short form, by convention, is longitude first.
  return {
    code,
    axisOrder: 'lon-lat',
    reason: `${raw} is the short form, which is conventionally longitude/latitude.`,
    declared: true,
  };
}

/** Geographic CRSs this tool may see; everything else is treated as projected. */
const GEOGRAPHIC_CODES = new Set(['EPSG:4326', 'EPSG:4258', 'EPSG:4269', 'EPSG:4283', 'EPSG:4030']);

function isProjected(code: string): boolean {
  return !GEOGRAPHIC_CODES.has(code);
}

/**
 * Read a coordinate list, applying the axis order.
 *
 * `srsDimension` says how many ordinates each tuple carries; it defaults to 2
 * and a third is kept as elevation.
 */
export function readPosList(raw: string | undefined, axisOrder: AxisOrder, dimension = 2): Position[] {
  if (!raw) return [];
  const numbers = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((value) => Number.isFinite(value));

  const step = dimension >= 3 ? 3 : 2;
  const positions: Position[] = [];

  for (let index = 0; index + step - 1 < numbers.length; index += step) {
    const a = numbers[index] as number;
    const b = numbers[index + 1] as number;
    const [lon, lat] = axisOrder === 'lat-lon' ? [b, a] : [a, b];
    if (step === 3) {
      positions.push([lon, lat, numbers[index + 2] as number]);
    } else {
      positions.push([lon, lat]);
    }
  }

  return positions;
}

/**
 * Read a GML 2 `<coordinates>` block.
 *
 * Tuples are separated by whitespace and ordinates within a tuple by a comma,
 * both configurable via attributes that are honoured here because a few
 * producers really do change them.
 */
export function readCoordinates(
  raw: string | undefined,
  axisOrder: AxisOrder,
  options: { decimal?: string; cs?: string; ts?: string } = {},
): Position[] {
  if (!raw) return [];
  const cs = options.cs ?? ',';
  const ts = options.ts ?? ' ';
  const decimal = options.decimal ?? '.';

  const positions: Position[] = [];
  for (const tuple of raw.trim().split(new RegExp(`[${escapeForClass(ts)}\\s]+`))) {
    if (!tuple) continue;
    const parts = tuple.split(cs).map((part) => Number(decimal === '.' ? part : part.replace(decimal, '.')));
    const a = parts[0];
    const b = parts[1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    const [lon, lat] = axisOrder === 'lat-lon' ? [b as number, a as number] : [a as number, b as number];
    const z = parts[2];
    positions.push(Number.isFinite(z) ? [lon, lat, z as number] : [lon, lat]);
  }
  return positions;
}

function escapeForClass(value: string): string {
  return value.replace(/[-\\\]^]/g, '\\$&');
}

type GmlNode = Record<string, unknown>;

/** Read the positions of a ring or line, in whichever GML spelling is used. */
function positionsOf(node: unknown, axisOrder: AxisOrder, dimension: number): Position[] {
  const posList = text(pick(node, 'posList'));
  if (posList) {
    const declared = Number(text(pick(node, 'posList', '@srsDimension')) ?? dimension);
    return readPosList(posList, axisOrder, Number.isFinite(declared) ? declared : dimension);
  }

  const coordinates = text(pick(node, 'coordinates'));
  if (coordinates) {
    return readCoordinates(coordinates, axisOrder, {
      cs: text(pick(node, 'coordinates', '@cs')) ?? ',',
      ts: text(pick(node, 'coordinates', '@ts')) ?? ' ',
      decimal: text(pick(node, 'coordinates', '@decimal')) ?? '.',
    });
  }

  // A sequence of <pos> elements, one per position.
  const positions: Position[] = [];
  for (const pos of asArray(pick(node, 'pos') as unknown)) {
    const value = text(pos);
    if (!value) continue;
    const parsed = readPosList(value, axisOrder, dimension);
    if (parsed[0]) positions.push(parsed[0]);
  }
  return positions;
}

/** Read one `<LinearRing>` out of an exterior/interior wrapper. */
function ringOf(wrapper: unknown, axisOrder: AxisOrder, dimension: number): Position[] {
  const ring = pick(wrapper, 'LinearRing') ?? wrapper;
  return positionsOf(ring, axisOrder, dimension);
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

/** Convert a `<Polygon>` (GML 2 or 3 spelling) to a ring array. */
function polygonRings(node: unknown, axisOrder: AxisOrder, dimension: number): Position[][] {
  const rings: Position[][] = [];

  // GML 3 spelling.
  const exterior = pick(node, 'exterior');
  if (exterior) {
    const outer = closeRing(ringOf(exterior, axisOrder, dimension));
    if (outer.length >= 4) rings.push(outer);
    for (const interior of asArray(pick(node, 'interior') as unknown)) {
      const inner = closeRing(ringOf(interior, axisOrder, dimension));
      if (inner.length >= 4) rings.push(inner);
    }
    return rings;
  }

  // GML 2 spelling.
  const outerBoundary = pick(node, 'outerBoundaryIs');
  if (outerBoundary) {
    const outer = closeRing(ringOf(outerBoundary, axisOrder, dimension));
    if (outer.length >= 4) rings.push(outer);
    for (const interior of asArray(pick(node, 'innerBoundaryIs') as unknown)) {
      const inner = closeRing(ringOf(interior, axisOrder, dimension));
      if (inner.length >= 4) rings.push(inner);
    }
  }

  return rings;
}

function dimensionOf(node: unknown, fallback = 2): number {
  const declared = Number(text(pick(node, '@srsDimension')) ?? fallback);
  return Number.isFinite(declared) && declared >= 2 ? declared : fallback;
}

/**
 * Convert a GML geometry element to GeoJSON.
 *
 * `inherited` carries the srsName from an enclosing element, since GML allows
 * it to be declared once on a collection rather than on every member.
 */
export function gmlGeometryToGeoJson(
  node: GmlNode,
  inherited: SrsInterpretation,
): { geometry: Geometry | null; srs: SrsInterpretation } {
  // `srsName` may sit on the geometry property wrapper, but far more often it
  // sits on the geometry element itself (`<gml:MultiSurface srsName="...">`).
  // Reading only the wrapper silently loses the declaration and, with it, the
  // axis order — which transposes every coordinate without any error.
  const wrapperSrs = text(pick(node, '@srsName'));
  const effectiveInherited = wrapperSrs ? interpretSrsName(wrapperSrs) : inherited;

  /** Resolve the srsName that actually governs one geometry element. */
  const srsFor = (element: unknown): SrsInterpretation => {
    const declared = text(pick(element, '@srsName'));
    return declared ? interpretSrsName(declared) : effectiveInherited;
  };

  const build = (element: unknown, name: string, axis: AxisOrder): Geometry | null => {
    const dimension = dimensionOf(element);

    switch (name) {
      case 'Point': {
        const positions = positionsOf(element, axis, dimension);
        return positions[0] ? { type: 'Point', coordinates: positions[0] } : null;
      }
      case 'LineString':
      case 'LinearRing':
      case 'Curve': {
        const positions =
          name === 'Curve'
            ? positionsOf(pick(element, 'segments', 'LineStringSegment') ?? element, axis, dimension)
            : positionsOf(element, axis, dimension);
        return positions.length >= 2 ? { type: 'LineString', coordinates: positions } : null;
      }
      case 'Polygon': {
        const rings = polygonRings(element, axis, dimension);
        return rings.length > 0 ? { type: 'Polygon', coordinates: rings } : null;
      }
      case 'Surface': {
        // A Surface wraps its polygon in patches.
        const patches = asArray(pick(element, 'patches', 'PolygonPatch') as unknown);
        const rings = patches.flatMap((patch) => polygonRings(patch, axis, dimension));
        return rings.length > 0 ? { type: 'Polygon', coordinates: rings } : null;
      }
      default:
        return null;
    }
  };

  // --- single geometries ---------------------------------------------------
  for (const name of ['Point', 'LineString', 'Curve', 'Polygon', 'Surface'] as const) {
    const element = asArray(node[name] as unknown)[0];
    if (element !== undefined) {
      const srs = srsFor(element);
      const geometry = build(element, name, srs.axisOrder);
      if (geometry) return { geometry, srs };
    }
  }

  // --- aggregates ----------------------------------------------------------
  /** The srsName governing whichever aggregate container was found. */
  let aggregateSrs = effectiveInherited;

  const collect = (
    container: string,
    memberNames: string[],
    childNames: string[],
  ): Geometry[] => {
    const element = asArray(node[container] as unknown)[0];
    if (element === undefined) return [];

    // The aggregate usually carries the srsName for all of its members.
    const containerSrs = srsFor(element);
    aggregateSrs = containerSrs;

    const out: Geometry[] = [];
    for (const memberName of memberNames) {
      // `...Member` holds one child; `...Members` holds many.
      for (const member of asArray(pick(element, memberName) as unknown)) {
        for (const childName of childNames) {
          for (const child of asArray(pick(member, childName) as unknown)) {
            // A member may still override the container's declaration.
            const childSrs = text(pick(child, '@srsName'))
              ? interpretSrsName(text(pick(child, '@srsName')))
              : containerSrs;
            const geometry = build(child, childName, childSrs.axisOrder);
            if (geometry) out.push(geometry);
          }
        }
      }
    }
    return out;
  };

  const multiPolygons = [
    ...collect('MultiSurface', ['surfaceMember', 'surfaceMembers'], ['Polygon', 'Surface']),
    ...collect('MultiPolygon', ['polygonMember', 'polygonMembers'], ['Polygon']),
  ];
  if (multiPolygons.length > 0) {
    return {
      geometry: {
        type: 'MultiPolygon',
        coordinates: multiPolygons.map((polygon) => (polygon as { coordinates: Position[][] }).coordinates),
      },
      srs: aggregateSrs,
    };
  }

  const multiLines = [
    ...collect('MultiCurve', ['curveMember', 'curveMembers'], ['LineString', 'Curve']),
    ...collect('MultiLineString', ['lineStringMember', 'lineStringMembers'], ['LineString']),
  ];
  if (multiLines.length > 0) {
    return {
      geometry: {
        type: 'MultiLineString',
        coordinates: multiLines.map((line) => (line as { coordinates: Position[] }).coordinates),
      },
      srs: aggregateSrs,
    };
  }

  const multiPoints = collect('MultiPoint', ['pointMember', 'pointMembers'], ['Point']);
  if (multiPoints.length > 0) {
    return {
      geometry: {
        type: 'MultiPoint',
        coordinates: multiPoints.map((point) => (point as { coordinates: Position }).coordinates),
      },
      srs: aggregateSrs,
    };
  }

  return { geometry: null, srs: effectiveInherited };
}

export type GmlFeature = {
  id: string | null;
  properties: Record<string, string | number | boolean | null>;
  geometry: Geometry | null;
  srs: SrsInterpretation;
};

export type GmlParseResult = {
  features: GmlFeature[];
  /** `numberMatched`, when the server reported it. */
  numberMatched: number | null;
  numberReturned: number | null;
  notes: string[];
};

/** Element names that are structure rather than a feature's own attributes. */
const STRUCTURAL = new Set([
  'boundedBy',
  'Envelope',
  'lowerCorner',
  'upperCorner',
  'Box',
  'coordinates',
  'pos',
  'posList',
]);

const GEOMETRY_ELEMENTS = new Set([
  'Point',
  'LineString',
  'LinearRing',
  'Curve',
  'Polygon',
  'Surface',
  'MultiPoint',
  'MultiCurve',
  'MultiLineString',
  'MultiSurface',
  'MultiPolygon',
  'MultiGeometry',
]);

/** True when a node holds a GML geometry rather than a scalar value. */
function holdsGeometry(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  return Object.keys(node as GmlNode).some((key) => GEOMETRY_ELEMENTS.has(key));
}

/**
 * Parse a WFS `FeatureCollection` delivered as GML.
 *
 * Handles both the WFS 2.0 (`member`) and WFS 1.x (`featureMember` /
 * `featureMembers`) envelopes, and both GML 2 and GML 3 geometry spellings.
 */
export function parseGmlFeatureCollection(
  xml: string,
  fallbackSrsName?: string | null,
): { ok: true; result: GmlParseResult } | { ok: false; reason: string } {
  const parsed = safeParseXml(xml);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  // An OGC exception report is a valid document but not a feature collection.
  const exception = pick(parsed.doc, 'ExceptionReport');
  if (exception) {
    const message =
      text(pick(exception, 'Exception', 'ExceptionText')) ??
      text(pick(exception, 'Exception', '@exceptionCode')) ??
      'The service returned an exception report.';
    return { ok: false, reason: `The service refused the request: ${message}` };
  }

  const collection = pick(parsed.doc, 'FeatureCollection') as GmlNode | undefined;
  if (!collection) {
    return { ok: false, reason: 'The document is not a WFS FeatureCollection.' };
  }

  const notes: string[] = [];
  const inherited = interpretSrsName(
    text(pick(collection, '@srsName')) ?? fallbackSrsName ?? null,
  );

  const numberMatched = toCount(text(pick(collection, '@numberMatched')));
  const numberReturned = toCount(text(pick(collection, '@numberReturned')));

  // Gather feature members from every envelope spelling.
  const memberNodes: unknown[] = [
    ...asArray(collection.member as unknown),
    ...asArray(collection.featureMember as unknown),
  ];
  for (const plural of asArray(collection.featureMembers as unknown)) {
    if (plural && typeof plural === 'object') {
      for (const value of Object.values(plural as GmlNode)) {
        memberNodes.push(...asArray(value as unknown));
      }
    }
  }

  const features: GmlFeature[] = [];

  for (const member of memberNodes) {
    if (!member || typeof member !== 'object') continue;

    // A member wraps exactly one feature element, whose name is the type name.
    for (const [, featureNode] of Object.entries(member as GmlNode)) {
      for (const feature of asArray(featureNode as unknown)) {
        if (!feature || typeof feature !== 'object') continue;
        const record = readFeature(feature as GmlNode, inherited);
        if (record) features.push(record);
      }
    }
  }

  if (!inherited.declared && features.some((feature) => !feature.srs.declared)) {
    notes.push(
      'The service did not declare a coordinate reference system on its geometry, so the coordinate order ' +
        'could not be established. Those features are not offered for KML export.',
    );
  }

  return { ok: true, result: { features, numberMatched, numberReturned, notes } };
}

function toCount(value: string | undefined): number | null {
  if (!value || value === 'unknown') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFeature(node: GmlNode, inherited: SrsInterpretation): GmlFeature | null {
  const properties: Record<string, string | number | boolean | null> = {};
  let geometry: Geometry | null = null;
  let srs = inherited;

  const id = text(node['@id']) ?? text(node['@fid']) ?? null;

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (STRUCTURAL.has(key)) continue;

    const first = asArray(value as unknown)[0];

    if (holdsGeometry(first)) {
      const converted = gmlGeometryToGeoJson(first as GmlNode, inherited);
      if (converted.geometry && !geometry) {
        geometry = converted.geometry;
        srs = converted.srs;
      }
      continue;
    }

    // A geometry element sitting directly on the feature rather than inside a
    // named geometry property.
    if (GEOMETRY_ELEMENTS.has(key)) {
      const converted = gmlGeometryToGeoJson({ [key]: value } as GmlNode, inherited);
      if (converted.geometry && !geometry) {
        geometry = converted.geometry;
        srs = converted.srs;
      }
      continue;
    }

    const scalar = text(first);
    if (scalar !== undefined) {
      properties[key] = coerce(scalar);
    } else if (first === '' || first === null) {
      properties[key] = null;
    }
  }

  if (!geometry && Object.keys(properties).length === 0) return null;
  return { id, properties, geometry, srs };
}

/** Numbers arrive as text in XML; keep them numeric where unambiguous. */
function coerce(value: string): string | number | boolean {
  if (/^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    // Long identifiers must stay strings rather than lose precision.
    if (Number.isSafeInteger(parsed) && value.length <= 15) return parsed;
    return value;
  }
  if (/^-?\d*\.\d+$/.test(value)) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * A blunt sanity check on the axis-order decision.
 *
 * If coordinates land outside the plausible envelope for the subcontinent but
 * their transpose lands inside it, the axis order was almost certainly read
 * the wrong way round. This does not silently correct the geometry — silently
 * correcting is exactly what this project refuses to do — it reports the
 * suspicion so the caller can surface it.
 */
export function axisOrderLooksTransposed(positions: Position[]): boolean {
  if (positions.length === 0) return false;

  let asRead = 0;
  let transposed = 0;

  for (const position of positions) {
    const [x, y] = position;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (plausibleForIndia(x, y)) asRead += 1;
    if (plausibleForIndia(y, x)) transposed += 1;
  }

  // Only claim a transposition when the evidence is one-sided.
  return transposed > 0 && asRead === 0;
}

/** Rough bounding envelope of India, generous at the edges. */
function plausibleForIndia(lon: number, lat: number): boolean {
  return lon >= 66 && lon <= 98 && lat >= 6 && lat <= 38;
}
