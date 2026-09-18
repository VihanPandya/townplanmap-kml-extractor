/**
 * Mapbox Vector Tile provider.
 *
 * Vector tiles do carry real coordinates, but they are quantised to a tile's
 * integer grid (4096 units across by default) before being encoded, so what
 * comes back is the source geometry generalised for display at one zoom level,
 * not the surveyed boundary. That is a genuine loss of fidelity, so everything
 * this provider produces is marked `tile-decoded` and says so — it is offered
 * as a last resort when no feature service is available, never as an equal
 * substitute for one.
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { LIMITS } from '@/lib/config';
import { safeFetch } from '@/lib/net/safe-fetch';
import { identifyCrs } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import type { Geometry } from '@/lib/geo/types';
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

const TILE_NOTE =
  'Geometry decoded from vector tiles is quantised to the tile grid, so it is a generalised rendering of ' +
  'the source boundary rather than the surveyed geometry. Prefer a feature service for this layer where one exists.';

/** Longitude/latitude to the tile covering it at a zoom level. */
export function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale);
  return { x: Math.max(0, Math.min(scale - 1, x)), y: Math.max(0, Math.min(scale - 1, y)) };
}

/** Tiles covering a bounding box at a zoom level, capped to a sane count. */
export function tilesForBbox(
  bbox: [number, number, number, number],
  zoom: number,
  maxTiles: number,
): Array<{ x: number; y: number; z: number }> {
  const [west, south, east, north] = bbox;
  const topLeft = lonLatToTile(west, north, zoom);
  const bottomRight = lonLatToTile(east, south, zoom);
  const tiles: Array<{ x: number; y: number; z: number }> = [];
  for (let x = topLeft.x; x <= bottomRight.x && tiles.length < maxTiles; x += 1) {
    for (let y = topLeft.y; y <= bottomRight.y && tiles.length < maxTiles; y += 1) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

function fillTemplate(template: string, tile: { x: number; y: number; z: number }): string {
  return template
    .replace(/\{z\}/gi, String(tile.z))
    .replace(/\{x\}/gi, String(tile.x))
    .replace(/\{y\}/gi, String(tile.y));
}

export class VectorTileProvider implements GeoProvider {
  readonly id = 'vector-tiles';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return endpoint.kind === 'vector-tiles';
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const detail = endpoint.probe?.detail ?? {};
    const declared = typeof detail.vectorLayers === 'string' && detail.vectorLayers ? detail.vectorLayers.split(',') : [];
    const crs = identifyCrs(
      4326,
      'Vector tile geometry is decoded from the tile grid into WGS84 longitude/latitude.',
    );

    const source = declared.length > 0 ? declared : ['default'];
    return source.map((name) => ({
      id: `layer_mvt_${hash(`${endpoint.url}#${name}`)}`,
      sourceLayerId: name,
      name,
      description: 'Vector tile layer.',
      category: categoriseLayer(name),
      endpointId: endpoint.id,
      endpointKind: endpoint.kind,
      serviceUrl: endpoint.url,
      availability: {
        status: 'vector',
        geometryTypes: [],
        note: TILE_NOTE,
      },
      crs,
      featureCount: null,
      fields: [],
      bbox: null,
      locationId: context.locationId ?? null,
      kmlExportable: true,
      kmlNote: TILE_NOTE,
      attribution: typeof detail.attribution === 'string' ? detail.attribution : null,
    }));
  }

  async listFeatures(layer: LayerRecord, query: FeatureQuery, context: ProviderContext): Promise<FeaturePage> {
    if (!query.bbox) {
      return {
        features: [],
        nextCursor: null,
        total: null,
        truncated: false,
        notes: [
          'Vector tiles are read tile by tile, so a map area must be selected before features can be listed. ' +
            'Pan or zoom the map to choose one.',
        ],
      };
    }

    const zoom = Math.min(16, Math.max(10, Number.parseInt(query.cursor ?? '14', 10)));
    // Each tile is one request; stay well inside the budget.
    const maxTiles = Math.max(1, Math.min(9, context.budget.requestsRemaining - 2));
    const tiles = tilesForBbox(query.bbox, zoom, maxTiles);
    const features: FeatureRecord[] = [];
    const notes: string[] = [TILE_NOTE];
    let index = 0;

    for (const tile of tiles) {
      if (features.length >= LIMITS.maxFeaturesPerLayer) break;
      const url = fillTemplate(layer.serviceUrl, tile);
      const response = await safeFetch(url, {
        budget: context.budget,
        signal: context.signal,
        accept: 'application/vnd.mapbox-vector-tile,application/x-protobuf',
      });
      if (!response.ok) {
        if (response.kind === 'budget') {
          notes.push('The request budget for this operation was reached before every tile could be read.');
          break;
        }
        continue; // A missing tile just means no data there.
      }
      if (response.bytes === 0) continue;

      let decoded: VectorTile;
      try {
        decoded = new VectorTile(new PbfReader(response.body));
      } catch {
        notes.push(`A tile at ${tile.z}/${tile.x}/${tile.y} could not be decoded and was skipped.`);
        continue;
      }

      const tileLayer = decoded.layers[layer.sourceLayerId] ?? Object.values(decoded.layers)[0];
      if (!tileLayer) continue;

      for (let position = 0; position < tileLayer.length; position += 1) {
        const tileFeature = tileLayer.feature(position);
        const geoJson = tileFeature.toGeoJSON(tile.x, tile.y, tile.z);
        const geometry = (geoJson.geometry as Geometry | null) ?? null;
        if (!geometry) continue;

        const properties = normaliseAttributes(geoJson.properties as Record<string, unknown> | undefined);
        const sourceId = tileFeature.id !== undefined ? String(tileFeature.id) : null;
        const { name } = deriveFeatureName(properties, sourceId, layer.name);
        const stats = describeGeometry(geometry);

        features.push({
          id: `feat_${layer.id}_${tile.z}_${tile.x}_${tile.y}_${position}`,
          layerId: layer.id,
          sourceFeatureId: sourceId,
          name,
          geometryType: geometry.type,
          properties,
          geometry,
          crs: layer.crs,
          provenance: 'tile-decoded',
          provenanceNote: TILE_NOTE,
          areaSquareMetres: areaSquareMetres(geometry),
          bbox: stats.bbox,
          kmlAvailable: true,
          kmlNote: TILE_NOTE,
          sourceUrl: url,
        });
        index += 1;
      }
    }

    let filtered = features;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = features.filter((feature) => featureMatches(feature, needle));
    }

    // Vector tiles can repeat a feature across tile boundaries; de-duplicate by
    // source id where the encoder provided one.
    const seen = new Set<string>();
    const deduped = filtered.filter((feature) => {
      if (!feature.sourceFeatureId) return true;
      const key = `${feature.layerId}:${feature.sourceFeatureId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (deduped.length < filtered.length) {
      notes.push(
        `${filtered.length - deduped.length} feature(s) repeated across tile boundaries were de-duplicated by source id.`,
      );
    }

    return { features: deduped, nextCursor: null, total: deduped.length, truncated: index >= LIMITS.maxFeaturesPerLayer, notes };
  }
}
