/**
 * Providers for endpoints that hand back a whole dataset in one response:
 * GeoJSON/TopoJSON documents, and KML/KMZ files.
 *
 * These are the simplest and most trustworthy sources — the coordinates are
 * published directly, so the geometry needs no reconstruction at all.
 */

import JSZip from 'jszip';
import { LIMITS } from '@/lib/config';
import { safeFetch, asText } from '@/lib/net/safe-fetch';
import { identifyCrs, geojsonDefaultCrs, type CrsIdentification } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry, mergeBbox } from '@/lib/geo/geometry';
import type { BoundingBox, Geometry } from '@/lib/geo/types';
import { parseKml, type ParsedPlacemark } from '@/lib/kml/parse';
import type { DiscoveredEndpoint, FeatureRecord, LayerRecord } from '../types';
import { hash } from '../harvest';
import {
  categoriseLayer,
  deriveFeatureName,
  type FeaturePage,
  type FeatureQuery,
  type GeoProvider,
  type ProviderContext,
} from './base';
import { featureMatches } from './arcgis';
import { normaliseAttributes } from './esri-json';

/**
 * Documents are read once per request rather than cached across requests: a
 * short-lived in-process cache keyed by URL keeps a feature list and a
 * subsequent geometry read from costing two downloads, without holding data
 * beyond the life of the process.
 */
const documentCache = new Map<string, { at: number; features: FeatureRecord[]; crs: CrsIdentification }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(url: string): { features: FeatureRecord[]; crs: CrsIdentification } | null {
  const entry = documentCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    documentCache.delete(url);
    return null;
  }
  return { features: entry.features, crs: entry.crs };
}

function cacheSet(url: string, features: FeatureRecord[], crs: CrsIdentification): void {
  // Keep the cache small; this is a convenience, not a datastore.
  if (documentCache.size > 24) {
    const oldest = [...documentCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) documentCache.delete(oldest[0]);
  }
  documentCache.set(url, { at: Date.now(), features, crs });
}

function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname;
    return decodeURIComponent(last).replace(/\.(geo)?json$|\.kmz?$/i, '').replace(/[_-]+/g, ' ').trim() || parsed.hostname;
  } catch {
    return 'Dataset';
  }
}

/** Read a GeoJSON document's declared CRS, honouring the pre-RFC7946 `crs` member. */
function crsOfGeoJson(document: Record<string, unknown>): CrsIdentification {
  const crs = document.crs as { properties?: { name?: string; href?: string }; type?: string } | undefined;
  const name = crs?.properties?.name ?? crs?.properties?.href;
  if (name) {
    return identifyCrs(name, `The GeoJSON document declares a legacy crs member naming ${name}.`);
  }
  return geojsonDefaultCrs();
}

function buildRecord(
  layer: LayerRecord,
  crs: CrsIdentification,
  index: number,
  geometry: Geometry | null,
  properties: Record<string, string | number | boolean | null>,
  explicitId: string | null,
  provenanceNote: string,
): FeatureRecord {
  const { name } = deriveFeatureName(properties, explicitId ?? String(index + 1), layer.name);
  const stats = geometry ? describeGeometry(geometry) : null;
  return {
    id: `feat_${layer.id}_${explicitId ?? index}`,
    layerId: layer.id,
    sourceFeatureId: explicitId,
    name,
    geometryType: geometry?.type ?? null,
    properties,
    geometry,
    crs,
    provenance: 'source-geometry',
    provenanceNote,
    areaSquareMetres: geometry && crs.isWgs84 ? areaSquareMetres(geometry) : null,
    bbox: crs.isWgs84 ? (stats?.bbox ?? null) : null,
    kmlAvailable: Boolean(geometry) && crs.transformable,
    kmlNote: !geometry
      ? 'This record carries no geometry.'
      : crs.transformable
        ? layer.kmlNote
        : 'The coordinate reference system of this document is unknown, so KML cannot be generated reliably.',
    sourceUrl: layer.serviceUrl,
  };
}

export class GeoJsonFileProvider implements GeoProvider {
  readonly id = 'geojson-file';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return endpoint.kind === 'geojson';
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const name = nameFromUrl(endpoint.url);
    // A single document is one layer; reading it here would double the cost, so
    // the layer is described from what the probe already established.
    const detail = endpoint.probe?.detail ?? {};
    const declaredCrs = typeof detail.crs === 'string' ? detail.crs : null;
    const crs = declaredCrs
      ? identifyCrs(declaredCrs, `The document declares ${declaredCrs}.`)
      : geojsonDefaultCrs();
    const featureCount = typeof detail.featureCount === 'number' ? detail.featureCount : null;
    const geometryTypes =
      typeof detail.geometryTypes === 'string' && detail.geometryTypes ? detail.geometryTypes.split(',') : [];

    return [
      {
        id: `layer_geojson_${hash(endpoint.url)}`,
        sourceLayerId: endpoint.url,
        name,
        description: 'GeoJSON document published by the source.',
        category: categoriseLayer(name),
        endpointId: endpoint.id,
        endpointKind: endpoint.kind,
        serviceUrl: endpoint.url,
        availability: {
          status: 'vector',
          geometryTypes,
          note: 'GeoJSON carries coordinate geometry directly.',
        },
        crs,
        featureCount,
        fields: [],
        bbox: null,
        locationId: context.locationId ?? null,
        kmlExportable: crs.transformable,
        kmlNote: crs.isWgs84
          ? 'GeoJSON coordinates are WGS84 and can be written to KML directly.'
          : `Coordinates are in ${crs.code} and will be transformed to WGS84 for KML.`,
        attribution: null,
      },
    ];
  }

  async listFeatures(layer: LayerRecord, query: FeatureQuery, context: ProviderContext): Promise<FeaturePage> {
    const cached = cacheGet(layer.serviceUrl);
    let all: FeatureRecord[];

    if (cached) {
      all = cached.features;
    } else {
      const response = await safeFetch(layer.serviceUrl, {
        budget: context.budget,
        signal: context.signal,
        accept: 'application/geo+json,application/json',
      });
      if (!response.ok) {
        return {
          features: [],
          nextCursor: null,
          total: null,
          truncated: false,
          notes: [
            response.kind === 'auth-required'
              ? 'This dataset requires authorised access through TownPlanMap.'
              : `The document could not be read: ${response.reason}`,
          ],
        };
      }

      let document: Record<string, unknown>;
      try {
        document = JSON.parse(asText(response)) as Record<string, unknown>;
      } catch {
        return { features: [], nextCursor: null, total: null, truncated: false, notes: ['The document is not valid JSON.'] };
      }

      const crs = crsOfGeoJson(document);
      const entries = Array.isArray(document.features)
        ? (document.features as Array<Record<string, unknown>>)
        : document.type === 'Feature'
          ? [document]
          : [];

      all = entries.slice(0, LIMITS.maxFeaturesPerLayer).map((entry, index) =>
        buildRecord(
          layer,
          crs,
          index,
          (entry.geometry as Geometry | null) ?? null,
          normaliseAttributes(entry.properties as Record<string, unknown> | undefined),
          entry.id !== undefined && entry.id !== null ? String(entry.id) : null,
          crs.confidence === 'assumed-by-spec'
            ? 'Coordinates are exactly as published in the GeoJSON document, which RFC 7946 defines as WGS84.'
            : `Coordinates are exactly as published in the document, in ${crs.code}.`,
        ),
      );
      cacheSet(layer.serviceUrl, all, crs);
    }

    return paginate(all, query);
  }
}

export class KmlFileProvider implements GeoProvider {
  readonly id = 'kml-file';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return endpoint.kind === 'kml' || endpoint.kind === 'kmz';
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const name = nameFromUrl(endpoint.url);
    const detail = endpoint.probe?.detail ?? {};
    // KML is defined against WGS84 by the OGC specification.
    const crs = identifyCrs(
      4326,
      'KML is defined by its OGC specification to use WGS84 longitude/latitude, so no transformation is needed.',
    );

    return [
      {
        id: `layer_kml_${hash(endpoint.url)}`,
        sourceLayerId: endpoint.url,
        name,
        description: typeof detail.documentName === 'string' ? detail.documentName : 'KML document published by the source.',
        category: categoriseLayer(name, typeof detail.documentName === 'string' ? detail.documentName : null),
        endpointId: endpoint.id,
        endpointKind: endpoint.kind,
        serviceUrl: endpoint.url,
        availability: {
          status: 'vector',
          geometryTypes: [],
          note: 'KML placemarks carry coordinate geometry directly.',
        },
        crs,
        featureCount: typeof detail.featureCount === 'number' ? detail.featureCount : null,
        fields: [],
        bbox: null,
        locationId: context.locationId ?? null,
        kmlExportable: true,
        kmlNote: 'The source is already KML; geometry is preserved exactly as published.',
        attribution: null,
      },
    ];
  }

  async listFeatures(layer: LayerRecord, query: FeatureQuery, context: ProviderContext): Promise<FeaturePage> {
    const cached = cacheGet(layer.serviceUrl);
    let all: FeatureRecord[];

    if (cached) {
      all = cached.features;
    } else {
      const response = await safeFetch(layer.serviceUrl, {
        budget: context.budget,
        signal: context.signal,
        accept: 'application/vnd.google-earth.kml+xml,application/xml',
      });
      if (!response.ok) {
        return {
          features: [],
          nextCursor: null,
          total: null,
          truncated: false,
          notes: [
            response.kind === 'auth-required'
              ? 'This dataset requires authorised access through TownPlanMap.'
              : `The document could not be read: ${response.reason}`,
          ],
        };
      }

      let xml: string;
      if (layer.endpointKind === 'kmz') {
        const extracted = await extractKmlFromKmz(response.body);
        if (!extracted) {
          return { features: [], nextCursor: null, total: null, truncated: false, notes: ['The KMZ archive contained no KML document.'] };
        }
        xml = extracted;
      } else {
        xml = asText(response);
      }

      const parsed = parseKml(xml);
      if (!parsed.ok) {
        return { features: [], nextCursor: null, total: null, truncated: false, notes: [parsed.reason] };
      }

      all = parsed.kml.placemarks
        .slice(0, LIMITS.maxFeaturesPerLayer)
        .map((placemark, index) => placemarkToRecord(layer, placemark, index));
      cacheSet(layer.serviceUrl, all, layer.crs);
    }

    return paginate(all, query);
  }
}

function placemarkToRecord(layer: LayerRecord, placemark: ParsedPlacemark, index: number): FeatureRecord {
  const properties: Record<string, string | number | boolean | null> = { ...placemark.properties };
  if (placemark.folderPath.length > 0) properties._folder = placemark.folderPath.join(' / ');
  if (placemark.description) properties._description = placemark.description;

  const stats = placemark.geometry ? describeGeometry(placemark.geometry) : null;
  const name = placemark.name ?? deriveFeatureName(properties, String(index + 1), layer.name).name;

  return {
    id: `feat_${layer.id}_${index}`,
    layerId: layer.id,
    sourceFeatureId: null,
    name,
    geometryType: placemark.geometry?.type ?? null,
    properties,
    geometry: placemark.geometry,
    crs: layer.crs,
    provenance: 'source-geometry',
    provenanceNote: 'Coordinates are exactly as published in the source KML document.',
    areaSquareMetres: placemark.geometry ? areaSquareMetres(placemark.geometry) : null,
    bbox: stats?.bbox ?? null,
    kmlAvailable: Boolean(placemark.geometry),
    kmlNote: layer.kmlNote,
    sourceUrl: layer.serviceUrl,
  };
}

/** Pull the first .kml entry out of a KMZ archive, with a decompression cap. */
export async function extractKmlFromKmz(body: Uint8Array): Promise<string | null> {
  const zip = await JSZip.loadAsync(body);
  const entries = Object.values(zip.files).filter((file) => !file.dir && /\.kml$/i.test(file.name));
  // doc.kml is the conventional entry point; otherwise take the first KML found.
  const chosen = entries.find((file) => /(^|\/)doc\.kml$/i.test(file.name)) ?? entries[0];
  if (!chosen) return null;

  const uncompressed = await chosen.async('uint8array');
  if (uncompressed.byteLength > LIMITS.maxXmlBytes) {
    throw new Error(
      `The KMZ expands to ${uncompressed.byteLength} bytes, above the ${LIMITS.maxXmlBytes} byte limit.`,
    );
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(uncompressed);
}

/** Shared pagination + client-side search for whole-document providers. */
function paginate(all: FeatureRecord[], query: FeatureQuery): FeaturePage {
  let working = all;

  if (query.ids && query.ids.length > 0) {
    const wanted = new Set(query.ids);
    working = working.filter(
      (feature) => wanted.has(feature.id) || (feature.sourceFeatureId !== null && wanted.has(feature.sourceFeatureId)),
    );
  }

  if (query.search) {
    const needle = query.search.toLowerCase();
    working = working.filter((feature) => featureMatches(feature, needle));
  }

  const limit = Math.min(query.limit ?? LIMITS.featurePageSize, LIMITS.featurePageSize);
  const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
  const page = working.slice(offset, offset + limit);
  const hasMore = offset + limit < working.length;

  let bbox: BoundingBox | null = null;
  for (const feature of page) bbox = mergeBbox(bbox, feature.bbox);

  return {
    features: page,
    nextCursor: hasMore ? String(offset + limit) : null,
    total: working.length,
    truncated: false,
    notes: [],
  };
}
