/**
 * In-process catalog store.
 *
 * The zero-infrastructure default. Everything lives in Maps that die with the
 * process, which is fine for a catalog of public upstream data but is stated
 * plainly in `describe()` so nobody mistakes it for durable storage.
 *
 * Feature counts are bounded so a very large layer cannot exhaust memory; the
 * export pipeline streams from the provider for anything bigger.
 */

import { LIMITS } from '@/lib/config';
import type {
  DiscoveredEndpoint,
  FeatureRecord,
  LayerRecord,
  LocationRecord,
  ScanResult,
} from '@/lib/discovery/types';
import type { ExportJob } from '@/lib/exports/types';
import type { SourceFileRecord } from '@/lib/preservation/types';
import type { CapturedPayload, CapturedResponse } from '@/lib/discovery/captured';
import type { CatalogStore } from './index';

export class MemoryStore implements CatalogStore {
  readonly kind = 'memory' as const;
  readonly durable = false;

  private scans = new Map<string, ScanResult>();
  private latestScanId: string | null = null;
  private endpoints = new Map<string, DiscoveredEndpoint>();
  private locations = new Map<string, LocationRecord>();
  private layers = new Map<string, LayerRecord>();
  private features = new Map<string, FeatureRecord>();
  private featuresByLayer = new Map<string, string[]>();
  private exports = new Map<string, ExportJob>();
  private sourceFiles = new Map<string, { record: SourceFileRecord; bytes: Uint8Array }>();
  private captured = new Map<string, { record: CapturedResponse; bytes: Uint8Array }>();

  describe(): string {
    return (
      'In-process catalog (no database configured). Discovered layers, features and export history are held ' +
      'in memory and are lost when the server restarts. Set DATABASE_URL to a PostGIS database for durable storage.'
    );
  }

  async saveScan(scan: ScanResult): Promise<void> {
    this.scans.set(scan.id, scan);
    this.latestScanId = scan.id;
    // Keep only the last few scans.
    if (this.scans.size > 10) {
      const oldest = [...this.scans.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (oldest) this.scans.delete(oldest.id);
    }
  }

  async getLatestScan(): Promise<ScanResult | null> {
    return this.latestScanId ? (this.scans.get(this.latestScanId) ?? null) : null;
  }

  async getScan(id: string): Promise<ScanResult | null> {
    return this.scans.get(id) ?? null;
  }

  async saveEndpoints(_scanId: string, endpoints: DiscoveredEndpoint[]): Promise<void> {
    for (const endpoint of endpoints) this.endpoints.set(endpoint.id, endpoint);
  }

  async getEndpoint(id: string): Promise<DiscoveredEndpoint | null> {
    return this.endpoints.get(id) ?? null;
  }

  async listEndpoints(): Promise<DiscoveredEndpoint[]> {
    return [...this.endpoints.values()];
  }

  async saveLocations(locations: LocationRecord[]): Promise<void> {
    for (const location of locations) this.locations.set(location.id, location);
  }

  async listLocations(kind: 'city' | 'area', parentId?: string | null): Promise<LocationRecord[]> {
    return [...this.locations.values()]
      .filter((location) => location.kind === kind)
      .filter((location) => (parentId === undefined ? true : location.parentId === parentId))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  async getLocation(id: string): Promise<LocationRecord | null> {
    return this.locations.get(id) ?? null;
  }

  async saveLayers(layers: LayerRecord[]): Promise<void> {
    for (const layer of layers) this.layers.set(layer.id, layer);
  }

  async listLayers(locationId?: string | null): Promise<LayerRecord[]> {
    const all = [...this.layers.values()];
    if (locationId === undefined) return all;
    return all.filter((layer) => layer.locationId === locationId);
  }

  async getLayer(id: string): Promise<LayerRecord | null> {
    return this.layers.get(id) ?? null;
  }

  async updateLayerCount(id: string, count: number | null): Promise<void> {
    const layer = this.layers.get(id);
    if (layer) this.layers.set(id, { ...layer, featureCount: count });
  }

  async saveFeatures(features: FeatureRecord[]): Promise<void> {
    for (const feature of features) {
      const existing = this.features.get(feature.id);
      // A later read that carries geometry should not be overwritten by an
      // earlier list-view read that omitted it.
      if (existing && existing.geometry && !feature.geometry) {
        this.features.set(feature.id, { ...feature, geometry: existing.geometry });
      } else {
        this.features.set(feature.id, feature);
      }

      const ids = this.featuresByLayer.get(feature.layerId) ?? [];
      if (!ids.includes(feature.id)) {
        if (ids.length >= LIMITS.maxFeaturesPerLayer) continue;
        ids.push(feature.id);
        this.featuresByLayer.set(feature.layerId, ids);
      }
    }
  }

  async listFeatures(
    layerId: string,
    options: { search?: string | null; limit?: number; offset?: number } = {},
  ): Promise<FeatureRecord[]> {
    const ids = this.featuresByLayer.get(layerId) ?? [];
    let records = ids
      .map((id) => this.features.get(id))
      .filter((feature): feature is FeatureRecord => feature !== undefined);

    if (options.search) {
      const needle = options.search.toLowerCase();
      records = records.filter(
        (feature) =>
          feature.name.toLowerCase().includes(needle) ||
          feature.sourceFeatureId?.toLowerCase().includes(needle) ||
          Object.values(feature.properties).some(
            (value) => value !== null && String(value).toLowerCase().includes(needle),
          ),
      );
    }

    const offset = options.offset ?? 0;
    const limit = options.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  async countFeatures(layerId: string): Promise<number> {
    return (this.featuresByLayer.get(layerId) ?? []).length;
  }

  async getFeature(id: string): Promise<FeatureRecord | null> {
    return this.features.get(id) ?? null;
  }

  async getFeatures(ids: string[]): Promise<FeatureRecord[]> {
    return ids
      .map((id) => this.features.get(id))
      .filter((feature): feature is FeatureRecord => feature !== undefined);
  }

  async saveCapturedResponse(record: CapturedResponse, bytes: Uint8Array): Promise<void> {
    this.captured.set(record.url, { record, bytes: new Uint8Array(bytes) });
  }

  async getCapturedPayload(url: string): Promise<CapturedPayload | null> {
    const entry = this.captured.get(url);
    return entry ? { record: entry.record, bytes: new Uint8Array(entry.bytes) } : null;
  }

  async listCapturedResponses(): Promise<CapturedResponse[]> {
    return [...this.captured.values()].map((entry) => entry.record);
  }

  async saveSourceFile(record: SourceFileRecord, bytes: Uint8Array): Promise<void> {
    // Copy the buffer so a caller reusing its own array cannot mutate what has
    // been preserved.
    this.sourceFiles.set(record.id, { record, bytes: new Uint8Array(bytes) });
  }

  async listSourceFiles(limit = 500): Promise<SourceFileRecord[]> {
    return [...this.sourceFiles.values()]
      .map((entry) => entry.record)
      .sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))
      .slice(0, limit);
  }

  async getSourceFile(id: string): Promise<SourceFileRecord | null> {
    return this.sourceFiles.get(id)?.record ?? null;
  }

  async getSourceFileBytes(id: string): Promise<Uint8Array | null> {
    const entry = this.sourceFiles.get(id);
    return entry ? new Uint8Array(entry.bytes) : null;
  }

  async countSourceFiles(): Promise<number> {
    return this.sourceFiles.size;
  }

  async saveExport(job: ExportJob): Promise<void> {
    this.exports.set(job.id, job);
  }

  async getExport(id: string): Promise<ExportJob | null> {
    return this.exports.get(id) ?? null;
  }

  async listExports(limit = 50): Promise<ExportJob[]> {
    return [...this.exports.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
