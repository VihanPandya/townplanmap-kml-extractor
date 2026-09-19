/**
 * Data captured inside the browser window, and how to read it back.
 *
 * When the deep scan runs with a visible window, the person using it can sign
 * in to the source themselves. Everything the site then returns is data they
 * are authorised to see, and the browser already holds every byte of it. This
 * module keeps those bytes and turns them into layers and features.
 *
 * The boundary this is built around:
 *
 *   - The person signs in. This tool never types, reads, stores or transmits a
 *     credential, never automates a login form, and never clicks through a
 *     captcha or consent wall. The window is theirs.
 *   - The session lives in an ephemeral browser profile that is discarded when
 *     the window closes. No cookie, token or storage state is written to disk
 *     or carried into any later request.
 *   - What is kept is the *response*: bytes the source deliberately sent to an
 *     authorised session. Reading them again here asks the source for nothing
 *     and presents no credential to anyone.
 *
 * That is the difference between using access you have and working around
 * access you do not. This tool does the first and refuses the second.
 */

import JSZip from 'jszip';

import { LIMITS } from '@/lib/config';
import { classifyBody, classifyUrl } from '@/lib/geo/detect';
import { identifyCrs, geojsonDefaultCrs, type CrsIdentification } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import type { Geometry } from '@/lib/geo/types';
import { parseKml, kmlToFeatureCollection } from '@/lib/kml/parse';
import { esriGeometryToGeoJson, normaliseAttributes } from './providers/esri-json';
import { isTopology, topologyToFeatures, topologyObjectNames } from './providers/topojson';
import { categoriseLayer, deriveFeatureName, type FeaturePage, type FeatureQuery, type GeoProvider, type ProviderContext } from './providers/base';
import { hash } from './harvest';
import type { DiscoveredEndpoint, EndpointKind, FeatureRecord, LayerRecord } from './types';

/** One response the browser received and this tool kept. */
export type CapturedResponse = {
  /** Stable id, derived from the URL. */
  id: string;
  url: string;
  contentType: string | null;
  kind: EndpointKind;
  byteLength: number;
  capturedAt: string;
  /**
   * True when the site's own request for this data carried a session cookie or
   * an Authorization header — that is, when it was made as a signed-in user.
   *
   * This is an observation, not an action. The person signs themselves in; the
   * tool records only that the request it watched was an authenticated one, so
   * the interface can say accurately where the data came from.
   */
  carriedSession: boolean;
};

/** A captured response together with its bytes. */
export type CapturedPayload = { record: CapturedResponse; bytes: Uint8Array };

export function capturedId(url: string): string {
  return `cap_${hash(url)}`;
}

/**
 * The id prefix a captured endpoint carries.
 *
 * This is the marker that survives the round trip. Once a layer is catalogued,
 * provider dispatch rebuilds a minimal endpoint from the layer record, and a
 * `LayerRecord` has no field for where the endpoint was discovered — so the
 * prose marker is gone by then and only the id remains. Matching on both means
 * a captured layer still reaches this provider on a second visit to the screen,
 * rather than falling through to a network provider that would try to fetch a
 * URL only a signed-in session could read.
 */
const CAPTURED_ID_PREFIX = 'ep_captured_';

/** The endpoint id a captured response is catalogued under. */
export function capturedEndpointId(url: string): string {
  return `${CAPTURED_ID_PREFIX}${hash(url)}`;
}

/** Whether this endpoint is served from bytes already in hand. */
export function isCapturedEndpoint(endpoint: DiscoveredEndpoint): boolean {
  return endpoint.discoveredIn === CAPTURED_SOURCE || endpoint.id.startsWith(CAPTURED_ID_PREFIX);
}

export const CAPTURED_SOURCE = 'data the site returned to your own browser session';

// --- reading a captured document ----------------------------------------

type Attributes = Record<string, string | number | boolean | null>;

type ReadResult =
  | { ok: true; features: Array<{ geometry: Geometry | null; properties: Attributes; id: string | null }>; crs: CrsIdentification; name: string | null; note: string }
  | { ok: false; reason: string };

/**
 * Turn a captured response into plain features, whatever format it arrived in.
 *
 * A map application fetches its geometry as GeoJSON, as an ArcGIS feature set,
 * as TopoJSON or as KML depending on what is behind it. All four are read here
 * with the same parsers the network providers use, so a captured document and
 * a fetched one produce identical records.
 */
export async function readCapturedDocument(payload: CapturedPayload): Promise<ReadResult> {
  const { bytes, record } = payload;
  const detection = classifyBody(bytes, record.contentType ?? '', classifyUrl(record.url));

  if (detection.nature === 'raster') {
    return { ok: false, reason: 'This response is rendered imagery, not geometry.' };
  }

  if (detection.kind === 'kmz') {
    const kml = await kmlFromKmz(bytes);
    if (!kml) return { ok: false, reason: 'The archive holds no readable KML document.' };
    return readKml(kml);
  }
  if (detection.kind === 'kml') {
    return readKml(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'The captured response is not a format this tool can read.' };
  }

  if (isTopology(document)) return readTopoJson(document);
  if (Array.isArray(document.features) && document.features.some((entry) => isEsriFeature(entry))) {
    return readEsriFeatureSet(document);
  }
  return readGeoJson(document);
}

function isEsriFeature(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && 'attributes' in (entry as object));
}

function readGeoJson(document: Record<string, unknown>): ReadResult {
  const crsMember = document.crs as { properties?: { name?: string; href?: string } } | undefined;
  const declared = crsMember?.properties?.name ?? crsMember?.properties?.href;
  const crs = declared
    ? identifyCrs(declared, `The document declares a legacy crs member naming ${declared}.`)
    : geojsonDefaultCrs();

  const entries = Array.isArray(document.features)
    ? (document.features as Array<Record<string, unknown>>)
    : document.type === 'Feature'
      ? [document]
      : [];

  if (entries.length === 0) return { ok: false, reason: 'The document contains no features.' };

  return {
    ok: true,
    crs,
    name: typeof document.name === 'string' ? document.name : null,
    note:
      crs.confidence === 'assumed-by-spec'
        ? 'Coordinates are exactly as the source returned them, which RFC 7946 defines as WGS84.'
        : `Coordinates are exactly as the source returned them, in ${crs.code}.`,
    features: entries.slice(0, LIMITS.maxFeaturesPerLayer).map((entry) => ({
      geometry: (entry.geometry as Geometry | null) ?? null,
      properties: normaliseAttributes(entry.properties as Record<string, unknown> | undefined),
      id: entry.id !== undefined && entry.id !== null ? String(entry.id) : null,
    })),
  };
}

function readEsriFeatureSet(document: Record<string, unknown>): ReadResult {
  const spatial = document.spatialReference as { wkid?: number; latestWkid?: number } | undefined;
  const wkid = spatial?.latestWkid ?? spatial?.wkid;
  const crs = wkid
    ? identifyCrs(`EPSG:${wkid}`, `The feature set declares spatial reference ${wkid}.`)
    : identifyCrs(null, 'The feature set declares no spatial reference.');

  const entries = document.features as Array<{ attributes?: Record<string, unknown>; geometry?: unknown }>;
  const idField = typeof document.objectIdFieldName === 'string' ? document.objectIdFieldName : null;

  return {
    ok: true,
    crs,
    name: typeof document.displayFieldName === 'string' && document.displayFieldName ? null : null,
    note: `Coordinates are exactly as the source returned them, in ${crs.code}.`,
    features: entries.slice(0, LIMITS.maxFeaturesPerLayer).map((entry) => {
      const properties = normaliseAttributes(entry.attributes);
      const raw = idField ? properties[idField] : null;
      return {
        geometry: esriGeometryToGeoJson(entry.geometry as never),
        properties,
        id: raw === null || raw === undefined ? null : String(raw),
      };
    }),
  };
}

function readTopoJson(document: Record<string, unknown>): ReadResult {
  const names = topologyObjectNames(document as never);
  const first = names[0];
  if (!first) return { ok: false, reason: 'The topology names no objects.' };

  const features = topologyToFeatures(document as never, first);
  return {
    ok: true,
    crs: geojsonDefaultCrs(),
    name: first,
    note: 'Coordinates were decoded from the TopoJSON the source returned, using its own quantisation transform.',
    features: features.slice(0, LIMITS.maxFeaturesPerLayer).map((feature, index) => ({
      geometry: feature.geometry,
      properties: normaliseAttributes(feature.properties),
      id: feature.id ?? String(index),
    })),
  };
}

function readKml(xml: string): ReadResult {
  const parsed = parseKml(xml);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const collection = kmlToFeatureCollection(parsed.kml);
  if (collection.features.length === 0) {
    return { ok: false, reason: 'The KML document holds no placemarks with geometry.' };
  }

  return {
    ok: true,
    crs: identifyCrs('EPSG:4326', 'KML coordinates are WGS84 by specification.'),
    name: parsed.kml.documentName,
    note: 'Coordinates are exactly as published in the KML the source returned.',
    features: collection.features.slice(0, LIMITS.maxFeaturesPerLayer).map((feature, index) => ({
      geometry: feature.geometry,
      properties: normaliseAttributes(feature.properties as Record<string, unknown>),
      id: String(index),
    })),
  };
}

async function kmlFromKmz(bytes: Uint8Array): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entry =
      zip.file(/^doc\.kml$/i)[0] ?? zip.file(/\.kml$/i).sort((a, b) => a.name.length - b.name.length)[0];
    return entry ? await entry.async('string') : null;
  } catch {
    return null;
  }
}

// --- the provider --------------------------------------------------------

/** Where the bytes come from. Injected so the provider stays free of the store. */
export type CapturedLookup = (url: string) => Promise<CapturedPayload | null>;

let lookup: CapturedLookup = async () => null;

export function setCapturedLookup(resolver: CapturedLookup): void {
  lookup = resolver;
}

/**
 * Serves layers and features from bytes already in hand.
 *
 * It issues no requests at all, which is the point: the data was returned to a
 * session that was entitled to it, and asking again from a context that is not
 * would be both wrong and useless.
 */
export class CapturedProvider implements GeoProvider {
  readonly id = 'captured';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return isCapturedEndpoint(endpoint);
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const payload = await lookup(endpoint.url);
    if (!payload) return [];

    const read = await readCapturedDocument(payload);
    if (!read.ok) return [];

    const name = read.name ?? nameFor(endpoint.url);
    const geometryTypes = [...new Set(read.features.map((f) => f.geometry?.type).filter(Boolean))] as string[];

    return [
      {
        id: `layer_captured_${hash(endpoint.url)}`,
        sourceLayerId: endpoint.url,
        name,
        description: payload.record.carriedSession
          ? 'Captured from the data TownPlanMap returned to your own signed-in browser session.'
          : 'Captured from the data TownPlanMap returned to your browser.',
        category: categoriseLayer(name),
        endpointId: endpoint.id,
        endpointKind: endpoint.kind,
        serviceUrl: endpoint.url,
        availability: {
          status: 'vector',
          geometryTypes,
          note: 'The source returned this geometry to your browser; the coordinates are its own.',
        },
        crs: read.crs,
        featureCount: read.features.length,
        fields: fieldsOf(read.features),
        bbox: null,
        locationId: context.locationId ?? null,
        kmlExportable: read.crs.transformable,
        kmlNote: read.crs.isWgs84
          ? 'Coordinates are WGS84 and can be written to KML directly.'
          : read.crs.transformable
            ? `Coordinates are in ${read.crs.code} and will be transformed to WGS84 for KML.`
            : 'The coordinate reference system is unknown, so KML cannot be generated reliably.',
        attribution: null,
      },
    ];
  }

  // The context carries a request budget this provider never spends: the bytes
  // are already here. It is accepted to satisfy the provider contract.
  async listFeatures(layer: LayerRecord, query: FeatureQuery, _context?: ProviderContext): Promise<FeaturePage> {
    const payload = await lookup(layer.serviceUrl);
    if (!payload) {
      return {
        features: [],
        nextCursor: null,
        total: null,
        truncated: false,
        notes: [
          'The captured response is no longer held. Captured data lives only for the life of the server ' +
            'process unless a database is configured; re-run the scan to capture it again.',
        ],
      };
    }

    const read = await readCapturedDocument(payload);
    if (!read.ok) {
      return { features: [], nextCursor: null, total: null, truncated: false, notes: [read.reason] };
    }

    const all = read.features.map((entry, index) => {
      const { name } = deriveFeatureName(entry.properties, entry.id ?? String(index + 1), layer.name);
      const stats = entry.geometry ? describeGeometry(entry.geometry) : null;
      return {
        id: `feat_${layer.id}_${entry.id ?? index}`,
        layerId: layer.id,
        sourceFeatureId: entry.id,
        name,
        geometryType: entry.geometry?.type ?? null,
        properties: entry.properties,
        geometry: entry.geometry,
        crs: read.crs,
        provenance: 'source-geometry',
        provenanceNote: read.note,
        areaSquareMetres: entry.geometry && read.crs.isWgs84 ? areaSquareMetres(entry.geometry) : null,
        bbox: read.crs.isWgs84 ? (stats?.bbox ?? null) : null,
        kmlAvailable: Boolean(entry.geometry) && read.crs.transformable,
        kmlNote: !entry.geometry
          ? 'This record carries no geometry.'
          : read.crs.transformable
            ? layer.kmlNote
            : 'The coordinate reference system is unknown, so KML cannot be generated reliably.',
        sourceUrl: layer.serviceUrl,
      } satisfies FeatureRecord;
    });

    const filtered = query.ids?.length
      ? all.filter((feature) => query.ids?.includes(feature.sourceFeatureId ?? feature.id))
      : query.search
        ? all.filter((feature) =>
            JSON.stringify(feature.properties).toLowerCase().includes(query.search!.toLowerCase()),
          )
        : all;

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const limit = Math.min(query.limit ?? 200, LIMITS.maxFeaturesPerLayer);
    const page = filtered.slice(offset, offset + limit);

    return {
      features: page,
      nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
      total: filtered.length,
      truncated: false,
      notes: [],
    };
  }
}

function nameFor(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname;
    return decodeURIComponent(last).replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').trim() || parsed.hostname;
  } catch {
    return 'Captured dataset';
  }
}

function fieldsOf(features: Array<{ properties: Attributes }>): LayerRecord['fields'] {
  const names = new Set<string>();
  for (const feature of features.slice(0, 200)) {
    for (const key of Object.keys(feature.properties)) names.add(key);
  }
  return [...names].slice(0, 200).map((name) => ({ name, alias: null, type: null }));
}
