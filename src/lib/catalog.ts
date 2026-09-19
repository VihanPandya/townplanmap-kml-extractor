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
import type { FeaturePage, FeatureQuery, GeoProvider, ProviderContext } from '@/lib/discovery/providers/base';
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
  new FixtureProvider(),
  new ArcGisProvider(),
  new WfsProvider(),
  new GeoJsonFileProvider(),
  new TopoJsonFileProvider(),
  new KmlFileProvider(),
  new VectorTileProvider(),
];

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
  storeKind: string;
  storeDurable: boolean;
};

/**
 * Connect to the source: run a discovery scan, persist it, and derive the city
 * list from everything the scan turned up.
 */
export async function connect(signal?: AbortSignal): Promise<ConnectResult> {
  const store = await getStore();
  const budget = new RequestBudget();

  const scan = await runDiscoveryScan({ budget, signal });

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

  await store.saveScan(scan);
  await store.saveEndpoints(scan.id, scan.endpoints);

  let cities: LocationRecord[] = [];
  if (scan.connected) {
    cities = await discoverCities(scan, budget, signal);
    await store.saveLocations(cities);
  }

  return {
    scan,
    cities,
    layerCandidates: scan.endpoints.filter((endpoint) => endpoint.nature === 'vector').length,
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
