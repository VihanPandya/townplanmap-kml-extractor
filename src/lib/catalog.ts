/**
 * Catalog service.
 *
 * Sits between the API routes and the discovery layer: it picks the right
 * provider for an endpoint, keeps the store up to date, and is the only place
 * that decides when a fresh upstream read is needed versus reusing what has
 * already been catalogued.
 */

import { LIMITS, SOURCE, FIXTURE_SOURCE_ENABLED } from '@/lib/config';
import { RequestBudget } from '@/lib/net/budget';
import { getStore } from '@/lib/db';
import { runDiscoveryScan } from '@/lib/discovery/engine';
import {
  areasFromLayerAttribute,
  discoverLocationsFromPage,
  locationsFromArcGisDirectory,
  mergeLocations,
} from '@/lib/discovery/locations';
import { ArcGisProvider } from '@/lib/discovery/providers/arcgis';
import { WfsProvider } from '@/lib/discovery/providers/wfs';
import { GeoJsonFileProvider, KmlFileProvider, TopoJsonFileProvider } from '@/lib/discovery/providers/file-data';
import { VectorTileProvider } from '@/lib/discovery/providers/vector-tiles';
import { FixtureProvider, fixtureEndpoint } from '@/lib/discovery/providers/fixture';
import {
  CapturedProvider,
  capturedId,
  setCapturedLookup,
  type CapturedResponse,
} from '@/lib/discovery/captured';
import type { FeaturePage, FeatureQuery, GeoProvider, ProviderContext } from '@/lib/discovery/providers/base';
import { runPreservationSweep, looksLikeKmlResource } from '@/lib/preservation/sweep';
import type { DiscoveryRoute, PreservationSweep, SourceFileRecord } from '@/lib/preservation/types';
import type {
  DiscoveredEndpoint,
  FeatureRecord,
  LayerRecord,
  LocationRecord,
  ScanResult,
} from '@/lib/discovery/types';

/**
 * Provider dispatch order.
 *
 * First match wins, so the most specific matcher goes first: the fixture
 * provider recognises endpoints by an exact URL scheme, and would otherwise be
 * shadowed by the GeoJSON provider, which matches every endpoint of kind
 * `geojson`.
 */
const PROVIDERS: GeoProvider[] = [
  // Bytes already in hand come first: they need no network at all, and for a
  // response returned to a signed-in session they are the only honest way to
  // read it.
  new CapturedProvider(),
  new FixtureProvider(),
  new ArcGisProvider(),
  new WfsProvider(),
  new GeoJsonFileProvider(),
  new TopoJsonFileProvider(),
  new KmlFileProvider(),
  new VectorTileProvider(),
];

/**
 * Let the captured-response provider reach the store without importing it,
 * which would make the discovery layer depend on storage.
 */
setCapturedLookup(async (url) => {
  const store = await getStore();
  return store.getCapturedPayload(url);
});

export function providerFor(endpoint: DiscoveredEndpoint): GeoProvider | null {
  return PROVIDERS.find((provider) => provider.supports(endpoint)) ?? null;
}

/** Reconstruct a minimal endpoint from a layer, for provider dispatch. */
function endpointOfLayer(layer: LayerRecord): DiscoveredEndpoint {
  return {
    id: layer.endpointId,
    url: layer.serviceUrl,
    kind: layer.endpointKind,
    nature: layer.availability.status === 'vector' ? 'vector' : 'unknown',
    discoveredIn: 'the catalog',
    evidence: [],
  };
}

export function providerForLayer(layer: LayerRecord): GeoProvider | null {
  return providerFor(endpointOfLayer(layer));
}

// --- connect -------------------------------------------------------------

export type ConnectResult = {
  scan: ScanResult;
  cities: LocationRecord[];
  layerCandidates: number;
  /** Geographic responses kept whole from the browser window. */
  capturedCount: number;
  /** How many of those the source returned to a signed-in session. */
  signedInCaptureCount: number;
  storeKind: string;
  storeDurable: boolean;
};

export type ConnectOptions = {
  signal?: AbortSignal;
  /**
   * URLs the person running the tool already knows about — typically read out
   * of their own browser's network panel. They skip pattern matching entirely
   * and go straight to the probe.
   */
  seeds?: string[];
  /** Watch the site load in a locally installed browser. */
  useBrowser?: boolean;
  browserSettleMs?: number;
  /** Open a visible window and record until the person closes it. */
  browserHeaded?: boolean;
};

/**
 * Connect to the source: run a discovery scan, persist it, and derive the city
 * list from everything the scan turned up.
 */
export async function connect(options: ConnectOptions = {}): Promise<ConnectResult> {
  const { signal } = options;
  const store = await getStore();
  const budget = new RequestBudget();

  let capturedCount = 0;
  let signedInCaptureCount = 0;

  const scan = await runDiscoveryScan({
    budget,
    signal,
    onCaptured: async (body) => {
      capturedCount += 1;
      if (body.carriedSession) signedInCaptureCount += 1;
      const record: CapturedResponse = {
        id: capturedId(body.url),
        url: body.url,
        contentType: body.contentType,
        kind: body.kind,
        byteLength: body.bytes.byteLength,
        capturedAt: new Date().toISOString(),
        carriedSession: body.carriedSession,
      };
      await store.saveCapturedResponse(record, body.bytes);
    },
    ...(options.seeds ? { seeds: options.seeds } : {}),
    ...(options.useBrowser === undefined ? {} : { useBrowser: options.useBrowser }),
    ...(options.browserSettleMs === undefined ? {} : { browserSettleMs: options.browserSettleMs }),
    ...(options.browserHeaded === undefined ? {} : { browserHeaded: options.browserHeaded }),
  });

  // The fixture source is opt-in. It is always announced, and when it is the
  // only thing available that is said loudly rather than letting an offline
  // demo look like a successful extraction from the real source.
  if (FIXTURE_SOURCE_ENABLED) {
    scan.endpoints = [...scan.endpoints, fixtureEndpoint()];
    scan.geographicLayersDetected = true;

    if (scan.connected) {
      scan.notes.push(
        'TPM_ENABLE_FIXTURE_SOURCE is set: a synthetic sample dataset is listed alongside what was discovered. ' +
          'It is not from TownPlanMap and everything derived from it is labelled as synthetic.',
      );
    } else {
      // Let the workflow proceed so the tool can be exercised offline, but make
      // the substitution unmistakable.
      scan.warnings.push(
        `${SOURCE.name} could not be reached (${scan.failure?.reason ?? 'unknown reason'}). ` +
          'Only the built-in synthetic sample dataset is available. Nothing you see or export in this state ' +
          'comes from TownPlanMap, and none of it is a real land record.',
      );
      scan.connected = true;
    }
  }

  let cities: LocationRecord[] = [];
  if (scan.connected) {
    cities = await discoverCities(scan, budget, signal);
    await store.saveLocations(cities);

    if (cities.length === 0) {
      scan.notes.push(
        'No city list could be read from the source. Layers can still be enumerated and exported without one; ' +
          'the city selector is a convenience, not a prerequisite.',
      );
    }
  }

  // Saved last, so the stored scan carries every note the connect step added.
  await store.saveScan(scan);
  await store.saveEndpoints(scan.id, scan.endpoints);

  return {
    scan,
    cities,
    layerCandidates: scan.endpoints.filter((endpoint) => endpoint.nature === 'vector').length,
    capturedCount,
    signedInCaptureCount,
    storeKind: store.kind,
    storeDurable: store.durable,
  };
}

/** Derive the city list from the page and from any ArcGIS service directory. */
async function discoverCities(
  scan: ScanResult,
  budget: RequestBudget,
  signal?: AbortSignal,
): Promise<LocationRecord[]> {
  const lists: LocationRecord[][] = [];

  if (budget.requestsRemaining > 4) {
    lists.push(await discoverLocationsFromPage(scan.baseUrl, budget, signal));
  }

  for (const endpoint of scan.endpoints) {
    if (budget.requestsRemaining <= 2) break;
    if (endpoint.kind !== 'arcgis-rest-root') continue;
    lists.push(await locationsFromArcGisDirectory(endpoint, budget, signal));
  }

  if (FIXTURE_SOURCE_ENABLED) {
    const { fixtureCities } = await import('@/lib/discovery/providers/fixture');
    lists.push(fixtureCities());
  }

  return mergeLocations(...lists);
}

// --- locations -----------------------------------------------------------

export async function listCities(): Promise<LocationRecord[]> {
  const store = await getStore();
  return store.listLocations('city');
}

/**
 * Areas inside a city.
 *
 * Derived from a boundary layer's own place-name attribute where one exists,
 * which is the only source-truthful way to enumerate villages.
 */
export async function listAreas(cityId: string): Promise<{ areas: LocationRecord[]; note: string }> {
  const store = await getStore();
  const existing = await store.listLocations('area', cityId);
  if (existing.length > 0) {
    return { areas: existing, note: 'Areas previously discovered for this city.' };
  }

  const layers = await store.listLayers();
  const boundaryLayers = layers.filter((layer) => layer.category === 'village-boundary');
  if (boundaryLayers.length === 0) {
    return {
      areas: [],
      note:
        'No administrative boundary layer has been discovered yet, so no village or locality list can be ' +
        'derived from the source. Explore the map layers for this city first.',
    };
  }

  const budget = new RequestBudget(12);
  const found: LocationRecord[][] = [];
  let fieldUsed: string | null = null;

  for (const layer of boundaryLayers.slice(0, 3)) {
    const result = await areasFromLayerAttribute(layer, cityId, budget);
    if (result.areas.length > 0) {
      fieldUsed = result.field;
      found.push(result.areas);
    }
  }

  const areas = mergeLocations(...found);
  if (areas.length > 0) await store.saveLocations(areas);

  return {
    areas,
    note:
      areas.length > 0
        ? `Derived from the "${fieldUsed}" attribute of the discovered boundary layer.`
        : 'The discovered boundary layers expose no place-name attribute to derive a locality list from.',
  };
}

// --- layers --------------------------------------------------------------

export type LayerDiscovery = {
  layers: LayerRecord[];
  notes: string[];
  rasterOnly: boolean;
};

/**
 * Enumerate layers for a location.
 *
 * Every vector endpoint the last scan found is asked for its layers. Results
 * are cached in the store so a second visit to the screen is free.
 */
export async function discoverLayers(
  locationId: string | null,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<LayerDiscovery> {
  const store = await getStore();

  if (!options.refresh) {
    const cached = await store.listLayers(locationId);
    if (cached.length > 0) {
      return { layers: cached, notes: [], rasterOnly: false };
    }
  }

  const scan = await store.getLatestScan();
  if (!scan) {
    return {
      layers: [],
      notes: ['No discovery scan has been run yet. Connect to the source first.'],
      rasterOnly: false,
    };
  }

  const location = locationId ? await store.getLocation(locationId) : null;
  const budget = new RequestBudget(Math.min(LIMITS.maxRequestsPerScan, 80));
  const context: ProviderContext = {
    budget,
    signal: options.signal,
    locationId,
    locationName: location?.name ?? null,
  };

  const notes: string[] = [];
  const collected: LayerRecord[] = [];

  // Probed vector endpoints first; unprobed ones only if budget allows.
  const ordered = [...scan.endpoints].sort((a, b) => {
    const score = (endpoint: DiscoveredEndpoint) =>
      endpoint.nature === 'vector' ? 0 : endpoint.nature === 'metadata' ? 1 : 2;
    return score(a) - score(b);
  });

  for (const endpoint of ordered) {
    if (budget.requestsRemaining <= 2) {
      notes.push('The request budget was reached before every endpoint could be enumerated.');
      break;
    }
    if (endpoint.nature === 'raster') continue;

    const provider = providerFor(endpoint);
    if (!provider) continue;

    try {
      const layers = await provider.listLayers(endpoint, context);
      collected.push(...layers);
    } catch (error) {
      notes.push(
        `Layer enumeration failed for ${endpoint.url}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const rasterEndpoints = scan.endpoints.filter((endpoint) => endpoint.nature === 'raster');
  if (collected.length === 0 && rasterEndpoints.length > 0) {
    notes.push(
      'Map image detected. Underlying vector geometry was not found. KML export cannot be generated reliably.',
    );
    return { layers: [], notes, rasterOnly: true };
  }

  // De-duplicate by service URL: the same layer can be reached by more than one
  // discovered path.
  const byUrl = new Map<string, LayerRecord>();
  for (const layer of collected) {
    if (!byUrl.has(layer.serviceUrl)) byUrl.set(layer.serviceUrl, layer);
  }
  const layers = [...byUrl.values()];

  if (layers.length > 0) await store.saveLayers(layers);

  return { layers, notes, rasterOnly: false };
}

export async function getLayer(id: string): Promise<LayerRecord | null> {
  const store = await getStore();
  return store.getLayer(id);
}

// --- features ------------------------------------------------------------

export type FeatureListing = {
  features: FeatureRecord[];
  nextCursor: string | null;
  total: number | null;
  notes: string[];
  truncated: boolean;
};

/**
 * Read a page of features for a layer, going upstream and caching the result.
 */
export async function listFeatures(
  layerId: string,
  query: FeatureQuery = {},
  signal?: AbortSignal,
): Promise<FeatureListing> {
  const store = await getStore();
  const layer = await store.getLayer(layerId);
  if (!layer) {
    return { features: [], nextCursor: null, total: null, notes: ['Unknown layer.'], truncated: false };
  }

  const provider = providerForLayer(layer);
  if (!provider) {
    return {
      features: [],
      nextCursor: null,
      total: null,
      notes: [`No reader is available for a ${layer.endpointKind} endpoint.`],
      truncated: false,
    };
  }

  if (layer.availability.status === 'raster') {
    return {
      features: [],
      nextCursor: null,
      total: null,
      notes: [
        'Map image detected. Underlying vector geometry was not found. KML export cannot be generated reliably.',
      ],
      truncated: false,
    };
  }
  if (layer.availability.status === 'restricted') {
    return {
      features: [],
      nextCursor: null,
      total: null,
      notes: ['This dataset requires authorised access through TownPlanMap.'],
      truncated: false,
    };
  }

  const budget = new RequestBudget(Math.min(LIMITS.maxRequestsPerScan, 40));
  const context: ProviderContext = { budget, signal, locationId: layer.locationId };

  let page: FeaturePage;
  try {
    page = await provider.listFeatures(layer, query, context);
  } catch (error) {
    return {
      features: [],
      nextCursor: null,
      total: null,
      notes: [error instanceof Error ? error.message : 'The layer could not be read.'],
      truncated: false,
    };
  }

  if (page.features.length > 0) {
    await store.saveFeatures(page.features);
  }

  // Ask the service for an authoritative count once, when it can give one.
  if (layer.featureCount === null && provider instanceof ArcGisProvider && budget.requestsRemaining > 1) {
    const count = await provider.countFeatures(layer, context);
    if (count !== null) {
      await store.updateLayerCount(layer.id, count);
      page.total = count;
    }
  }

  return {
    features: page.features,
    nextCursor: page.nextCursor,
    total: page.total ?? layer.featureCount,
    notes: page.notes,
    truncated: page.truncated,
  };
}

export async function getFeature(id: string): Promise<FeatureRecord | null> {
  const store = await getStore();
  return store.getFeature(id);
}

/**
 * Fetch a feature's geometry, going upstream if the catalog does not hold it.
 *
 * List views skip geometry to stay fast, so the detail view and every export
 * path funnel through here.
 */
export async function ensureGeometry(
  feature: FeatureRecord,
  signal?: AbortSignal,
): Promise<FeatureRecord> {
  if (feature.geometry) return feature;

  const store = await getStore();
  const layer = await store.getLayer(feature.layerId);
  if (!layer) return feature;

  const provider = providerForLayer(layer);
  if (!provider) return feature;

  const budget = new RequestBudget(6);
  const page = await provider.listFeatures(
    layer,
    {
      ids: feature.sourceFeatureId ? [feature.sourceFeatureId] : [feature.id],
      includeGeometry: true,
      limit: 1,
    },
    { budget, signal, locationId: layer.locationId },
  );

  const match =
    page.features.find((candidate) => candidate.id === feature.id) ??
    page.features.find((candidate) => candidate.sourceFeatureId === feature.sourceFeatureId) ??
    page.features[0];

  if (match?.geometry) {
    await store.saveFeatures([match]);
    return match;
  }
  return feature;
}

export const SOURCE_INFO = SOURCE;

// --- preservation of original files -------------------------------------

/**
 * Sweep the source for original KML/KMZ files and preserve them.
 *
 * Seeds come from the last discovery scan — every endpoint it classified as a
 * KML or KMZ resource, plus anything whose URL looks like one regardless of how
 * it was classified, since a `.kml` served with the wrong content type is
 * common. From there the sweep follows the documents' own NetworkLinks.
 */
export async function preserveSourceFiles(
  options: { signal?: AbortSignal; extraUrls?: string[] } = {},
): Promise<PreservationSweep> {
  const store = await getStore();
  const scan = await store.getLatestScan();

  const seeds: Array<{ url: string; route: DiscoveryRoute; discoveredIn: string }> = [];
  const seen = new Set<string>();

  const add = (url: string, route: DiscoveryRoute, discoveredIn: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    seeds.push({ url, route, discoveredIn });
  };

  for (const url of options.extraUrls ?? []) {
    add(url, 'seed', 'supplied with the request');
  }

  for (const endpoint of scan?.endpoints ?? []) {
    // Classification is a hint here, not a gate: the sweep re-checks what was
    // actually served, so a mislabelled .kml still gets its chance.
    if (endpoint.kind !== 'kml' && endpoint.kind !== 'kmz' && !looksLikeKmlResource(endpoint.url)) {
      continue;
    }
    add(endpoint.url, routeFromDiscovery(endpoint.discoveredIn), endpoint.discoveredIn);
  }

  const sweep = await runPreservationSweep({
    seeds,
    signal: options.signal,
    onFile: async (record, bytes) => {
      await store.saveSourceFile(record, bytes);
    },
  });

  if (scan === null) {
    sweep.notes.push(
      'No discovery scan has been run, so only URLs supplied with the request were considered. Connect to ' +
        'the source first for a full sweep.',
    );
  }

  return sweep;
}

/** Map the discovery engine's prose provenance onto a preservation route. */
function routeFromDiscovery(discoveredIn: string): DiscoveryRoute {
  const text = discoveredIn.toLowerCase();
  if (text.includes('style document')) return 'map-style';
  if (text.includes('services directory') || text.includes('catalog')) return 'service-catalog';
  if (text.includes('inline script')) return 'inline-script';
  if (text.includes('script')) return 'script-bundle';
  if (text.includes('landing page')) return 'page-markup';
  return 'seed';
}

export async function listSourceFiles(limit?: number): Promise<SourceFileRecord[]> {
  const store = await getStore();
  return store.listSourceFiles(limit);
}

export async function getSourceFile(id: string): Promise<SourceFileRecord | null> {
  const store = await getStore();
  return store.getSourceFile(id);
}

/** The preserved bytes, exactly as they were received. */
export async function getSourceFileBytes(id: string): Promise<Uint8Array | null> {
  const store = await getStore();
  return store.getSourceFileBytes(id);
}
