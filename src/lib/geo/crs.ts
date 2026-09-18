/**
 * Coordinate reference system identification and transformation.
 *
 * All transformation maths is delegated to proj4; this module's job is only to
 * work out *which* CRS a source is in, and to refuse to guess when it cannot
 * tell. KML is defined in WGS84 (EPSG:4326), so anything else must be
 * transformed before it can be written out.
 */

import proj4 from 'proj4';

export const WGS84 = 'EPSG:4326';

/**
 * Definitions for projections that Indian planning data commonly arrives in,
 * plus the web-mercator variants that map services return. proj4 already knows
 * EPSG:4326 and EPSG:3857; the rest are registered here so a transform does not
 * require a network lookup against an EPSG registry.
 */
const DEFINITIONS: Record<string, string> = {
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:900913': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:102100': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  // WGS84 / UTM zones covering India (42N-47N).
  'EPSG:32642': '+proj=utm +zone=42 +datum=WGS84 +units=m +no_defs',
  'EPSG:32643': '+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs',
  'EPSG:32644': '+proj=utm +zone=44 +datum=WGS84 +units=m +no_defs',
  'EPSG:32645': '+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs',
  'EPSG:32646': '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs',
  'EPSG:32647': '+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs',
  // Kalianpur 1975 / India zones — the classic Survey of India grids.
  'EPSG:24378': '+proj=lcc +lat_1=32.5 +lat_0=32.5 +lon_0=68 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  'EPSG:24379': '+proj=lcc +lat_1=26 +lat_0=26 +lon_0=74 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  'EPSG:24380': '+proj=lcc +lat_1=26 +lat_0=26 +lon_0=90 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  'EPSG:24381': '+proj=lcc +lat_1=19 +lat_0=19 +lon_0=80 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  'EPSG:24382': '+proj=lcc +lat_1=24 +lat_0=24 +lon_0=68 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  'EPSG:24383': '+proj=lcc +lat_1=12 +lat_0=12 +lon_0=80 +k_0=0.99878641 +x_0=2743195.5 +y_0=914398.5 +a=6377299.151 +b=6356098.145120132 +units=m +no_defs',
  // WGS84 / India NSF LCC — used by several state GIS portals.
  'EPSG:7755': '+proj=lcc +lat_0=24 +lon_0=80 +lat_1=12.472955 +lat_2=35.172806 +x_0=4000000 +y_0=4000000 +datum=WGS84 +units=m +no_defs',
};

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  for (const [code, definition] of Object.entries(DEFINITIONS)) {
    proj4.defs(code, definition);
  }
  // Common aliases used by ArcGIS and OGC services. CRS84 is WGS84 with the
  // axis order made explicit, so it shares the same proj4 definition.
  const wgs84 = '+proj=longlat +datum=WGS84 +no_defs';
  proj4.defs('urn:ogc:def:crs:OGC:1.3:CRS84', wgs84);
  proj4.defs('CRS:84', wgs84);
  proj4.defs('urn:ogc:def:crs:EPSG::4326', wgs84);
  registered = true;
}

export type CrsIdentification = {
  /** Canonical `EPSG:xxxx` code, or null when the source did not state one. */
  code: string | null;
  /** How the code was arrived at. */
  confidence: 'declared' | 'assumed-by-spec' | 'unknown';
  /** Human-readable note shown in the geometry inspector. */
  note: string;
  /** Whether a transform to WGS84 is available for this CRS. */
  transformable: boolean;
  /** True when the source is already WGS84 and needs no transformation. */
  isWgs84: boolean;
};

export const UNKNOWN_CRS: CrsIdentification = {
  code: null,
  confidence: 'unknown',
  note: 'The source did not declare a coordinate reference system.',
  transformable: false,
  isWgs84: false,
};

/** Normalise the many spellings of a CRS identifier to `EPSG:xxxx`. */
export function normaliseCrsCode(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!value) return null;

  // Bare numeric WKID, as ArcGIS reports it.
  if (/^\d{4,6}$/.test(value)) {
    const code = Number.parseInt(value, 10);
    // ArcGIS uses 102100 / 900913 for web mercator.
    if (code === 102100 || code === 900913) return 'EPSG:3857';
    return `EPSG:${code}`;
  }

  const upper = value.toUpperCase();
  if (upper === 'CRS:84' || upper === 'OGC:CRS84' || upper.endsWith('CRS84')) return WGS84;
  if (upper === 'WGS84' || upper === 'WGS 84') return WGS84;

  // urn:ogc:def:crs:EPSG::3857 / http://www.opengis.net/def/crs/EPSG/0/3857
  const urn = /EPSG[:/]{1,2}(?:0[:/])?(\d{4,6})/i.exec(value);
  if (urn?.[1]) {
    const code = Number.parseInt(urn[1], 10);
    if (code === 102100 || code === 900913) return 'EPSG:3857';
    return `EPSG:${code}`;
  }

  return null;
}

/** Whether proj4 can transform from `code` to WGS84. */
export function canTransform(code: string | null): boolean {
  if (!code) return false;
  ensureRegistered();
  if (code === WGS84) return true;
  try {
    return typeof proj4.defs(code) !== 'undefined';
  } catch {
    return false;
  }
}

export function identifyCrs(raw: string | number | null | undefined, sourceNote?: string): CrsIdentification {
  const code = normaliseCrsCode(raw);
  if (!code) {
    return { ...UNKNOWN_CRS, note: sourceNote ?? UNKNOWN_CRS.note };
  }
  const transformable = canTransform(code);
  return {
    code,
    confidence: 'declared',
    note:
      sourceNote ??
      (transformable
        ? `Coordinate reference system ${code} was declared by the source.`
        : `The source declared ${code}, for which no transformation definition is available in this build.`),
    transformable,
    isWgs84: code === WGS84,
  };
}

/**
 * GeoJSON as specified in RFC 7946 is always WGS84. A GeoJSON document with no
 * `crs` member is therefore WGS84 *by specification* rather than by assumption,
 * and that distinction is surfaced to the user as `assumed-by-spec`.
 */
export function geojsonDefaultCrs(): CrsIdentification {
  return {
    code: WGS84,
    confidence: 'assumed-by-spec',
    note:
      'No CRS member was present. RFC 7946 defines GeoJSON coordinates as WGS84 longitude/latitude, ' +
      'so that is what has been applied. The source did not state it explicitly.',
    transformable: true,
    isWgs84: true,
  };
}

export class CrsTransformError extends Error {}

export type Transformer = (position: number[]) => number[];

/**
 * Build a transformer from `code` to WGS84.
 *
 * Returns null when the CRS is unknown or unsupported — callers must then mark
 * the geometry as untransformable rather than passing the numbers through and
 * hoping they were already degrees.
 */
export function transformerToWgs84(code: string | null): Transformer | null {
  if (!code) return null;
  ensureRegistered();
  if (code === WGS84) {
    return (position) => position;
  }
  if (!canTransform(code)) return null;

  const converter = proj4(code, WGS84);
  return (position) => {
    const [x, y, ...rest] = position;
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new CrsTransformError('Coordinate pair is not numeric.');
    }
    const [lon, lat] = converter.forward([x, y]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new CrsTransformError(`Transformation of [${x}, ${y}] from ${code} produced a non-finite result.`);
    }
    // Preserve an elevation ordinate if the source carried one.
    return rest.length > 0 && typeof rest[0] === 'number' ? [lon, lat, rest[0]] : [lon, lat];
  };
}

/** Human-readable label for a CRS, for the inspector panel. */
export function crsLabel(identification: CrsIdentification): string {
  if (!identification.code) return 'Unknown';
  if (identification.confidence === 'assumed-by-spec') return `${identification.code} (per GeoJSON spec)`;
  return identification.code;
}
