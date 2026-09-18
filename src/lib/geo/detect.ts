/**
 * The vector-versus-raster detector.
 *
 * This is the judgement the product is built around: does a URL hand back real
 * coordinates, or a picture of them? It is answered from the URL shape, the
 * declared content type and — decisively — the first bytes of the body, since a
 * server's content type is frequently wrong and a URL is only a hint.
 */

import type { DataNature, EndpointKind } from '@/lib/discovery/types';

export type Detection = {
  kind: EndpointKind;
  nature: DataNature;
  evidence: string[];
};

/** Magic numbers for the raster formats a map server is likely to return. */
const IMAGE_SIGNATURES: Array<{ name: string; bytes: number[]; offset?: number }> = [
  { name: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { name: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'BMP', bytes: [0x42, 0x4d] },
  { name: 'TIFF (LE)', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { name: 'TIFF (BE)', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { name: 'WebP', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

function matches(body: Uint8Array, bytes: number[], offset = 0): boolean {
  if (body.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => body[offset + index] === byte);
}

/** Identify a raster image by its magic bytes. Returns the format name. */
export function detectImageFormat(body: Uint8Array): string | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (matches(body, signature.bytes, signature.offset ?? 0)) return signature.name;
  }
  return null;
}

export function isZipArchive(body: Uint8Array): boolean {
  return matches(body, ZIP_SIGNATURE);
}

/**
 * Classify by URL alone. Used to rank candidates before spending a request on
 * them; never used as the final word once a body is in hand.
 */
export function classifyUrl(rawUrl: string): Detection {
  const evidence: string[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'unknown', nature: 'unknown', evidence: ['URL could not be parsed.'] };
  }

  const path = url.pathname;
  const lower = `${path}?${url.search}`.toLowerCase();
  const params = url.searchParams;
  const service = (params.get('service') ?? params.get('SERVICE') ?? '').toUpperCase();
  const request = (params.get('request') ?? params.get('REQUEST') ?? '').toUpperCase();

  // --- ArcGIS REST ---------------------------------------------------------
  if (/\/rest\/services\//i.test(path)) {
    if (/\/featureserver(\/\d+)?\/?$/i.test(path)) {
      evidence.push('ArcGIS REST path ends in FeatureServer, which serves vector features.');
      return { kind: 'arcgis-feature-server', nature: 'vector', evidence };
    }
    if (/\/mapserver\/\d+\/?$/i.test(path)) {
      evidence.push('ArcGIS MapServer sub-layer; may expose queryable vector features.');
      return { kind: 'arcgis-map-server', nature: 'unknown', evidence };
    }
    if (/\/mapserver\/?$/i.test(path)) {
      evidence.push('ArcGIS MapServer, which renders images but can expose queryable layers.');
      return { kind: 'arcgis-map-server', nature: 'unknown', evidence };
    }
    if (/\/imageserver\/?$/i.test(path)) {
      evidence.push('ArcGIS ImageServer serves raster imagery.');
      return { kind: 'arcgis-image-server', nature: 'raster', evidence };
    }
    evidence.push('ArcGIS REST services root.');
    return { kind: 'arcgis-rest-root', nature: 'metadata', evidence };
  }

  // --- OGC services --------------------------------------------------------
  if (service === 'WFS' || /\bwfs\b/.test(lower)) {
    evidence.push('OGC Web Feature Service: serves vector features.');
    return { kind: 'ogc-wfs', nature: 'vector', evidence };
  }
  if (service === 'WMTS' || /\bwmts\b/.test(lower)) {
    evidence.push('OGC Web Map Tile Service: serves rendered tiles.');
    return { kind: 'ogc-wmts', nature: 'raster', evidence };
  }
  if (service === 'WMS' || /\bwms\b/.test(lower) || request === 'GETMAP') {
    evidence.push('OGC Web Map Service: renders map images rather than geometry.');
    return { kind: 'ogc-wms', nature: 'raster', evidence };
  }
  if (/\/collections\/[^/]+\/items/i.test(path) || /\/ogcapi/i.test(path)) {
    evidence.push('OGC API — Features items endpoint.');
    return { kind: 'ogc-api-features', nature: 'vector', evidence };
  }

  // --- File extensions -----------------------------------------------------
  if (/\.geojson(\?|$)/i.test(lower) || /geojson/i.test(lower)) {
    evidence.push('URL names a GeoJSON document.');
    return { kind: 'geojson', nature: 'vector', evidence };
  }
  if (/\.topojson(\?|$)/i.test(lower)) {
    evidence.push('URL names a TopoJSON document.');
    return { kind: 'topojson', nature: 'vector', evidence };
  }
  if (/\.kml(\?|$)/i.test(lower)) {
    evidence.push('URL names a KML document.');
    return { kind: 'kml', nature: 'vector', evidence };
  }
  if (/\.kmz(\?|$)/i.test(lower)) {
    evidence.push('URL names a KMZ archive.');
    return { kind: 'kmz', nature: 'vector', evidence };
  }
  if (/\.gpx(\?|$)/i.test(lower)) {
    evidence.push('URL names a GPX document.');
    return { kind: 'gpx', nature: 'vector', evidence };
  }
  if (/\.gpkg(\?|$)/i.test(lower)) {
    evidence.push('URL names a GeoPackage.');
    return { kind: 'geopackage', nature: 'vector', evidence };
  }
  if (/\.(zip|shp)(\?|$)/i.test(lower) && /(shape|shp|boundary|parcel|village)/i.test(lower)) {
    evidence.push('URL looks like a shapefile archive.');
    return { kind: 'shapefile-archive', nature: 'vector', evidence };
  }

  // --- Tiles ---------------------------------------------------------------
  if (/\.(pbf|mvt)(\?|$)/i.test(lower) || /\{z\}\/\{x\}\/\{y\}\.(pbf|mvt)/i.test(lower)) {
    evidence.push('Mapbox Vector Tile endpoint: carries geometry quantised to the tile grid.');
    return { kind: 'vector-tiles', nature: 'vector', evidence };
  }
  if (/\{z\}\/\{x\}\/\{y\}\.(png|jpg|jpeg|webp)/i.test(lower) || /\.(png|jpe?g|webp)(\?|$)/i.test(lower)) {
    evidence.push('Raster tile or image URL.');
    return { kind: 'raster-tiles', nature: 'raster', evidence };
  }
  if (/tile\.json(\?|$)/i.test(lower) || /\/tilejson/i.test(lower)) {
    evidence.push('TileJSON descriptor.');
    return { kind: 'tilejson', nature: 'metadata', evidence };
  }
  if (/style\.json(\?|$)/i.test(lower) || /\/styles?\//i.test(lower)) {
    evidence.push('Map style document; lists the sources a map draws from.');
    return { kind: 'maplibre-style', nature: 'metadata', evidence };
  }

  if (/\.json(\?|$)/i.test(lower)) {
    evidence.push('JSON document; contents decide whether it carries geometry.');
    return { kind: 'unknown', nature: 'unknown', evidence };
  }

  return { kind: 'unknown', nature: 'unknown', evidence: [] };
}

/**
 * Classify with the body in hand. This supersedes any URL-based guess.
 */
export function classifyBody(
  body: Uint8Array,
  contentType: string,
  urlHint: Detection,
): Detection {
  const evidence = [...urlHint.evidence];
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  const imageFormat = detectImageFormat(body);
  if (imageFormat) {
    evidence.push(`Response body begins with a ${imageFormat} signature: this is rendered imagery, not geometry.`);
    return { kind: urlHint.kind === 'raster-tiles' ? 'raster-tiles' : 'raster-image', nature: 'raster', evidence };
  }

  if (type.startsWith('image/')) {
    evidence.push(`Server declared Content-Type ${type}.`);
    return { kind: 'raster-image', nature: 'raster', evidence };
  }

  if (isZipArchive(body)) {
    if (urlHint.kind === 'kmz') {
      evidence.push('ZIP archive at a .kmz URL: treated as a compressed KML document.');
      return { kind: 'kmz', nature: 'vector', evidence };
    }
    evidence.push('ZIP archive.');
    return { kind: urlHint.kind === 'shapefile-archive' ? 'shapefile-archive' : 'unknown', nature: 'unknown', evidence };
  }

  const head = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 4096)).trim();

  if (head.startsWith('{') || head.startsWith('[')) {
    if (/"type"\s*:\s*"FeatureCollection"/.test(head)) {
      evidence.push('JSON body declares type "FeatureCollection": GeoJSON vector data.');
      return { kind: 'geojson', nature: 'vector', evidence };
    }
    if (/"type"\s*:\s*"(Feature|Point|LineString|Polygon|MultiPolygon|MultiLineString|MultiPoint|GeometryCollection)"/.test(head)) {
      evidence.push('JSON body declares a GeoJSON geometry type.');
      return { kind: 'geojson', nature: 'vector', evidence };
    }
    if (/"type"\s*:\s*"Topology"/.test(head)) {
      evidence.push('JSON body declares a TopoJSON topology.');
      return { kind: 'topojson', nature: 'vector', evidence };
    }
    if (/"geometryType"\s*:\s*"esriGeometry/.test(head)) {
      evidence.push('ArcGIS feature JSON with an esriGeometry type.');
      return { kind: 'arcgis-feature-server', nature: 'vector', evidence };
    }
    if (/"tiles"\s*:\s*\[/.test(head) && /"vector_layers"/.test(head)) {
      evidence.push('TileJSON describing vector layers.');
      return { kind: 'tilejson', nature: 'vector', evidence };
    }
    if (/"tiles"\s*:\s*\[/.test(head)) {
      evidence.push('TileJSON descriptor.');
      return { kind: 'tilejson', nature: 'metadata', evidence };
    }
    if (/"sources"\s*:\s*\{/.test(head) && /"version"\s*:\s*8/.test(head)) {
      evidence.push('MapLibre/Mapbox style document version 8.');
      return { kind: 'maplibre-style', nature: 'metadata', evidence };
    }
    if (/"layers"\s*:\s*\[/.test(head) || /"currentVersion"/.test(head)) {
      evidence.push('ArcGIS service description.');
      return { kind: 'arcgis-rest-root', nature: 'metadata', evidence };
    }
    evidence.push('JSON document with no recognised geospatial structure.');
    return { kind: 'unknown', nature: 'unknown', evidence };
  }

  if (head.startsWith('<')) {
    if (/<kml[\s>]/i.test(head)) {
      evidence.push('XML root element is <kml>: vector geometry.');
      return { kind: 'kml', nature: 'vector', evidence };
    }
    if (/<(wfs:)?FeatureCollection/i.test(head) || /WFS_Capabilities/i.test(head)) {
      evidence.push('WFS document: vector features.');
      return { kind: 'ogc-wfs', nature: 'vector', evidence };
    }
    if (/WMT_MS_Capabilities|WMS_Capabilities/i.test(head)) {
      evidence.push('WMS capabilities: the service renders images.');
      return { kind: 'ogc-wms', nature: 'raster', evidence };
    }
    if (/<gpx[\s>]/i.test(head)) {
      evidence.push('XML root element is <gpx>.');
      return { kind: 'gpx', nature: 'vector', evidence };
    }
    if (/<(html|!doctype html)/i.test(head)) {
      evidence.push('HTML document.');
      return { kind: 'unknown', nature: 'metadata', evidence };
    }
    if (/ServiceException|ExceptionReport/i.test(head)) {
      evidence.push('Service returned an OGC exception report.');
      return { kind: urlHint.kind, nature: 'unknown', evidence };
    }
  }

  // Protobuf vector tiles have no magic number; the content type is the signal.
  if (type.includes('vnd.mapbox-vector-tile') || type.includes('x-protobuf') || type.includes('octet-stream')) {
    if (urlHint.kind === 'vector-tiles') {
      evidence.push(`Binary body with Content-Type ${type} at a vector tile URL.`);
      return { kind: 'vector-tiles', nature: 'vector', evidence };
    }
  }

  evidence.push(`Body could not be classified (Content-Type ${type || 'absent'}).`);
  return { kind: urlHint.kind, nature: 'unknown', evidence };
}

/** One-line summary for the data-source panel. */
export function describeNature(nature: DataNature): string {
  switch (nature) {
    case 'vector':
      return 'Vector geometry available';
    case 'raster':
      return 'Only map imagery available';
    case 'metadata':
      return 'Service metadata (points at other resources)';
    default:
      return 'Could not be determined';
  }
}
