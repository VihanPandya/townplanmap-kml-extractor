/**
 * Catalog storage.
 *
 * Two implementations behind one interface:
 *
 *   - PostGIS, used when `DATABASE_URL` is set. Geometry lives in a real
 *     spatial column so PostGIS does the spatial work.
 *   - An in-process store, used otherwise, so the tool runs with no
 *     infrastructure at all. It is explicitly ephemeral and the Settings screen
 *     says so rather than letting a user assume their catalog is durable.
 *
 * The store holds the *catalog* — what was discovered and what has been read so
 * far. It is a cache of public upstream data, not a system of record, so losing
 * it costs a re-scan and nothing more.
 */

import type {
  DiscoveredEndpoint,
  FeatureRecord,
  LayerRecord,
  LocationRecord,
  ScanResult,
} from '@/lib/discovery/types';
import type { ExportJob } from '@/lib/exports/types';

export interface CatalogStore {
  readonly kind: 'postgis' | 'memory';
  readonly durable: boolean;
  /** A short description for the Settings screen. */
  describe(): string;

  saveScan(scan: ScanResult): Promise<void>;
  getLatestScan(): Promise<ScanResult | null>;
  getScan(id: string): Promise<ScanResult | null>;

  saveEndpoints(scanId: string, endpoints: DiscoveredEndpoint[]): Promise<void>;
  getEndpoint(id: string): Promise<DiscoveredEndpoint | null>;
  listEndpoints(): Promise<DiscoveredEndpoint[]>;

  saveLocations(locations: LocationRecord[]): Promise<void>;
  listLocations(kind: 'city' | 'area', parentId?: string | null): Promise<LocationRecord[]>;
  getLocation(id: string): Promise<LocationRecord | null>;

  saveLayers(layers: LayerRecord[]): Promise<void>;
  listLayers(locationId?: string | null): Promise<LayerRecord[]>;
  getLayer(id: string): Promise<LayerRecord | null>;
  updateLayerCount(id: string, count: number | null): Promise<void>;

  saveFeatures(features: FeatureRecord[]): Promise<void>;
  listFeatures(layerId: string, options?: { search?: string | null; limit?: number; offset?: number }): Promise<FeatureRecord[]>;
  countFeatures(layerId: string): Promise<number>;
  getFeature(id: string): Promise<FeatureRecord | null>;
  getFeatures(ids: string[]): Promise<FeatureRecord[]>;

  saveExport(job: ExportJob): Promise<void>;
  getExport(id: string): Promise<ExportJob | null>;
  listExports(limit?: number): Promise<ExportJob[]>;
}

let cached: CatalogStore | null = null;

/**
 * Resolve the store for this process.
 *
 * Chosen once and memoised: switching stores mid-run would split the catalog
 * across two backends.
 */
export async function getStore(): Promise<CatalogStore> {
  if (cached) return cached;

  if (process.env.DATABASE_URL) {
    const { PostgisStore } = await import('./postgis');
    const store = new PostgisStore(process.env.DATABASE_URL);
    const ready = await store.verify();
    if (ready.ok) {
      cached = store;
      return store;
    }
    // Fall through to memory, but make the reason visible rather than silently
    // pretending the database was never configured.
    console.warn(
      `[townplanmap-kml-extractor] DATABASE_URL is set but unusable (${ready.reason}). ` +
        'Falling back to the in-process catalog for this run.',
    );
  }

  const { MemoryStore } = await import('./memory');
  cached = new MemoryStore();
  return cached;
}

/** Reset the memoised store. Used by tests. */
export function resetStore(): void {
  cached = null;
}
