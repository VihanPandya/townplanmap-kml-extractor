/**
 * PostGIS-backed catalog store.
 *
 * Geometry goes into a `geometry(Geometry, 4326)` column via
 * `ST_GeomFromGeoJSON`, so PostGIS holds it as real spatial data rather than as
 * a JSON blob — spatial indexes, area and bounding boxes are then the
 * database's job. Every statement is parameterised; no value is ever
 * interpolated into SQL text.
 */

import { Pool, type PoolClient } from 'pg';
import type {
  DiscoveredEndpoint,
  FeatureRecord,
  LayerRecord,
  LocationRecord,
  ScanResult,
} from '@/lib/discovery/types';
import type { ExportJob } from '@/lib/exports/types';
import type { Geometry, BoundingBox } from '@/lib/geo/types';
import { identifyCrs, UNKNOWN_CRS } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import type { CatalogStore } from './index';

export class PostgisStore implements CatalogStore {
  readonly kind = 'postgis' as const;
  readonly durable = true;

  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
  }

  describe(): string {
    return 'PostGIS catalog. Discovered layers, features and export history persist across restarts.';
  }

  /** Confirm the database is reachable and that PostGIS and the tables exist. */
  async verify(): Promise<{ ok: true } | { ok: false; reason: string }> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'connection failed' };
    }
    try {
      const postgis = await client.query("SELECT extname FROM pg_extension WHERE extname = 'postgis'");
      if (postgis.rowCount === 0) {
        return { ok: false, reason: 'the postgis extension is not installed in this database' };
      }
      const tables = await client.query(
        "SELECT to_regclass('public.features') AS features, to_regclass('public.map_layers') AS layers",
      );
      const row = tables.rows[0] as { features: string | null; layers: string | null } | undefined;
      if (!row?.features || !row.layers) {
        return { ok: false, reason: 'the schema has not been applied; run npm run db:init' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'verification query failed' };
    } finally {
      client.release();
    }
  }

  // --- scans -------------------------------------------------------------

  async saveScan(scan: ScanResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_jobs (id, base_url, started_at, finished_at, connected, requests_spent, bytes_downloaded, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         finished_at = EXCLUDED.finished_at,
         connected = EXCLUDED.connected,
         requests_spent = EXCLUDED.requests_spent,
         bytes_downloaded = EXCLUDED.bytes_downloaded,
         result = EXCLUDED.result`,
      [
        scan.id,
        scan.baseUrl,
        scan.startedAt,
        scan.finishedAt,
        scan.connected,
        scan.requestsSpent,
        scan.bytesDownloaded,
        JSON.stringify(scan),
      ],
    );
  }

  async getLatestScan(): Promise<ScanResult | null> {
    const result = await this.pool.query('SELECT result FROM scan_jobs ORDER BY started_at DESC LIMIT 1');
    return (result.rows[0]?.result as ScanResult) ?? null;
  }

  async getScan(id: string): Promise<ScanResult | null> {
    const result = await this.pool.query('SELECT result FROM scan_jobs WHERE id = $1', [id]);
    return (result.rows[0]?.result as ScanResult) ?? null;
  }

  // --- endpoints ---------------------------------------------------------

  async saveEndpoints(scanId: string, endpoints: DiscoveredEndpoint[]): Promise<void> {
    if (endpoints.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const endpoint of endpoints) {
        await client.query(
          `INSERT INTO source_datasets (id, url, kind, nature, discovered_in, evidence, probe, scan_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (url) DO UPDATE SET
             kind = EXCLUDED.kind,
             nature = EXCLUDED.nature,
             evidence = EXCLUDED.evidence,
             probe = EXCLUDED.probe,
             scan_id = EXCLUDED.scan_id`,
          [
            endpoint.id,
            endpoint.url,
            endpoint.kind,
            endpoint.nature,
            endpoint.discoveredIn,
            JSON.stringify(endpoint.evidence),
            endpoint.probe ? JSON.stringify(endpoint.probe) : null,
            scanId,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getEndpoint(id: string): Promise<DiscoveredEndpoint | null> {
    const result = await this.pool.query('SELECT * FROM source_datasets WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? rowToEndpoint(row) : null;
  }

  async listEndpoints(): Promise<DiscoveredEndpoint[]> {
    const result = await this.pool.query('SELECT * FROM source_datasets ORDER BY created_at DESC LIMIT 500');
    return result.rows.map(rowToEndpoint);
  }

  // --- locations ---------------------------------------------------------

  async saveLocations(locations: LocationRecord[]): Promise<void> {
    if (locations.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Cities first, so an area's parent reference always resolves.
      const ordered = [...locations].sort((a, b) => (a.kind === 'city' ? -1 : 1) - (b.kind === 'city' ? -1 : 1));
      for (const location of ordered) {
        await client.query(
          `INSERT INTO locations (id, name, kind, parent_id, source_url, source_field, bbox, feature_count, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, ${bboxSql(7)}, $11, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             source_url = EXCLUDED.source_url,
             source_field = EXCLUDED.source_field,
             bbox = COALESCE(EXCLUDED.bbox, locations.bbox),
             feature_count = COALESCE(EXCLUDED.feature_count, locations.feature_count),
             updated_at = now()`,
          [
            location.id,
            location.name,
            location.kind,
            location.parentId,
            location.sourceUrl,
            location.sourceField ?? null,
            ...bboxParams(location.bbox ?? null),
            location.featureCount ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listLocations(kind: 'city' | 'area', parentId?: string | null): Promise<LocationRecord[]> {
    const conditions = ['kind = $1'];
    const params: unknown[] = [kind];
    if (parentId !== undefined) {
      if (parentId === null) {
        conditions.push('parent_id IS NULL');
      } else {
        params.push(parentId);
        conditions.push(`parent_id = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `SELECT id, name, kind, parent_id, source_url, source_field, feature_count,
              CASE WHEN bbox IS NULL THEN NULL ELSE ARRAY[ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox)] END AS bbox_array
       FROM locations WHERE ${conditions.join(' AND ')} ORDER BY name`,
      params,
    );
    return result.rows.map(rowToLocation);
  }

  async getLocation(id: string): Promise<LocationRecord | null> {
    const result = await this.pool.query(
      `SELECT id, name, kind, parent_id, source_url, source_field, feature_count,
              CASE WHEN bbox IS NULL THEN NULL ELSE ARRAY[ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox)] END AS bbox_array
       FROM locations WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToLocation(row) : null;
  }

  // --- layers ------------------------------------------------------------

  async saveLayers(layers: LayerRecord[]): Promise<void> {
    if (layers.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const layer of layers) {
        await client.query(
          `INSERT INTO map_layers (
             id, source_layer_id, name, description, category, dataset_id, endpoint_kind, service_url,
             availability, crs, feature_count, fields, bbox, location_id, kml_exportable, kml_note, attribution, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${bboxSql(13)},$17,$18,$19,$20, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             availability = EXCLUDED.availability,
             crs = EXCLUDED.crs,
             feature_count = COALESCE(EXCLUDED.feature_count, map_layers.feature_count),
             fields = EXCLUDED.fields,
             bbox = COALESCE(EXCLUDED.bbox, map_layers.bbox),
             location_id = COALESCE(EXCLUDED.location_id, map_layers.location_id),
             kml_exportable = EXCLUDED.kml_exportable,
             kml_note = EXCLUDED.kml_note,
             attribution = EXCLUDED.attribution,
             updated_at = now()`,
          [
            layer.id,
            layer.sourceLayerId,
            layer.name,
            layer.description,
            layer.category,
            // The endpoint may not have been persisted; keep the FK nullable.
            null,
            layer.endpointKind,
            layer.serviceUrl,
            JSON.stringify(layer.availability),
            JSON.stringify(layer.crs),
            layer.featureCount,
            JSON.stringify(layer.fields),
            ...bboxParams(layer.bbox),
            layer.locationId,
            layer.kmlExportable,
            layer.kmlNote,
            layer.attribution,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listLayers(locationId?: string | null): Promise<LayerRecord[]> {
    const params: unknown[] = [];
    let where = '';
    if (locationId !== undefined) {
      if (locationId === null) {
        where = 'WHERE location_id IS NULL';
      } else {
        params.push(locationId);
        where = 'WHERE location_id = $1';
      }
    }
    const result = await this.pool.query(
      `SELECT *, CASE WHEN bbox IS NULL THEN NULL ELSE ARRAY[ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox)] END AS bbox_array
       FROM map_layers ${where} ORDER BY name LIMIT 500`,
      params,
    );
    return result.rows.map(rowToLayer);
  }

  async getLayer(id: string): Promise<LayerRecord | null> {
    const result = await this.pool.query(
      `SELECT *, CASE WHEN bbox IS NULL THEN NULL ELSE ARRAY[ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox)] END AS bbox_array
       FROM map_layers WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToLayer(row) : null;
  }

  async updateLayerCount(id: string, count: number | null): Promise<void> {
    await this.pool.query('UPDATE map_layers SET feature_count = $2, updated_at = now() WHERE id = $1', [id, count]);
  }

  // --- features ----------------------------------------------------------

  async saveFeatures(features: FeatureRecord[]): Promise<void> {
    if (features.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const feature of features) {
        await client.query(
          `INSERT INTO features (
             id, layer_id, source_id, feature_name, feature_type, properties, geometry,
             provenance, provenance_note, source_crs, kml_available, kml_note, source_url
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             CASE WHEN $7::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($7::text), 4326) END,
             $8, $9, $10, $11, $12, $13
           )
           ON CONFLICT (id) DO UPDATE SET
             feature_name = EXCLUDED.feature_name,
             feature_type = EXCLUDED.feature_type,
             properties = EXCLUDED.properties,
             -- A list-view read carries no geometry; never let it erase geometry
             -- a previous detail read already stored.
             geometry = COALESCE(EXCLUDED.geometry, features.geometry),
             provenance = EXCLUDED.provenance,
             provenance_note = EXCLUDED.provenance_note,
             source_crs = EXCLUDED.source_crs,
             kml_available = EXCLUDED.kml_available,
             kml_note = EXCLUDED.kml_note`,
          [
            feature.id,
            feature.layerId,
            feature.sourceFeatureId,
            feature.name,
            feature.geometryType,
            JSON.stringify(feature.properties),
            // Only WGS84 geometry may enter a SRID-4326 column. Anything still
            // in a source projection is stored without geometry and rebuilt on
            // demand, rather than being mislabelled as 4326.
            feature.geometry && feature.crs.isWgs84 ? JSON.stringify(feature.geometry) : null,
            feature.provenance,
            feature.provenanceNote,
            feature.crs.code,
            feature.kmlAvailable,
            feature.kmlNote,
            feature.sourceUrl,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listFeatures(
    layerId: string,
    options: { search?: string | null; limit?: number; offset?: number } = {},
  ): Promise<FeatureRecord[]> {
    const params: unknown[] = [layerId];
    let where = 'layer_id = $1';

    if (options.search) {
      params.push(`%${options.search}%`);
      // Match the name, the source id, or any attribute value the source gave.
      where += ` AND (
        feature_name ILIKE $${params.length}
        OR source_id ILIKE $${params.length}
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(properties) AS kv(key, value)
          WHERE kv.value ILIKE $${params.length}
        )
      )`;
    }

    params.push(options.limit ?? 1000);
    const limitIndex = params.length;
    params.push(options.offset ?? 0);
    const offsetIndex = params.length;

    const result = await this.pool.query(
      `SELECT id, layer_id, source_id, feature_name, feature_type, properties,
              ST_AsGeoJSON(geometry) AS geometry_json,
              CASE WHEN geometry IS NULL THEN NULL
                   ELSE ARRAY[ST_XMin(geometry), ST_YMin(geometry), ST_XMax(geometry), ST_YMax(geometry)] END AS bbox_array,
              provenance, provenance_note, source_crs, kml_available, kml_note, source_url
       FROM features WHERE ${where} ORDER BY feature_name LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return result.rows.map(rowToFeature);
  }

  async countFeatures(layerId: string): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM features WHERE layer_id = $1', [layerId]);
    return (result.rows[0]?.count as number) ?? 0;
  }

  async getFeature(id: string): Promise<FeatureRecord | null> {
    const features = await this.getFeatures([id]);
    return features[0] ?? null;
  }

  async getFeatures(ids: string[]): Promise<FeatureRecord[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT id, layer_id, source_id, feature_name, feature_type, properties,
              ST_AsGeoJSON(geometry) AS geometry_json,
              CASE WHEN geometry IS NULL THEN NULL
                   ELSE ARRAY[ST_XMin(geometry), ST_YMin(geometry), ST_XMax(geometry), ST_YMax(geometry)] END AS bbox_array,
              provenance, provenance_note, source_crs, kml_available, kml_note, source_url
       FROM features WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rows.map(rowToFeature);
  }

  // --- exports -----------------------------------------------------------

  async saveExport(job: ExportJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO exports (id, status, format, label, filename, requested, progress, validation,
                            feature_count, skipped_count, byte_size, error, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         filename = EXCLUDED.filename,
         progress = EXCLUDED.progress,
         validation = EXCLUDED.validation,
         feature_count = EXCLUDED.feature_count,
         skipped_count = EXCLUDED.skipped_count,
         byte_size = EXCLUDED.byte_size,
         error = EXCLUDED.error,
         completed_at = EXCLUDED.completed_at`,
      [
        job.id,
        job.status,
        job.format,
        job.label,
        job.artifact?.filename ?? null,
        JSON.stringify({ request: job.request, notes: job.notes, skipped: job.skipped, artifact: job.artifact }),
        JSON.stringify(job.progress),
        job.validation ? JSON.stringify(job.validation) : null,
        job.featureCount,
        job.skipped.length,
        job.artifact?.bytes ?? null,
        job.error,
        job.completedAt,
      ],
    );
  }

  async getExport(id: string): Promise<ExportJob | null> {
    const result = await this.pool.query('SELECT * FROM exports WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? rowToExport(row) : null;
  }

  async listExports(limit = 50): Promise<ExportJob[]> {
    const result = await this.pool.query('SELECT * FROM exports ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows.map(rowToExport);
  }
}

// --- row mapping ---------------------------------------------------------

/** `ST_MakeEnvelope` placeholder for a bbox stored as four ordinates. */
function bboxSql(startIndex: number): string {
  return `CASE WHEN $${startIndex}::float8 IS NULL THEN NULL
          ELSE ST_MakeEnvelope($${startIndex}::float8, $${startIndex + 1}::float8, $${startIndex + 2}::float8, $${startIndex + 3}::float8, 4326) END`;
}

function bboxParams(bbox: BoundingBox | null): [number | null, number | null, number | null, number | null] {
  if (!bbox) return [null, null, null, null];
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

function toBbox(value: unknown): BoundingBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? (numbers as BoundingBox) : null;
}

type Row = Record<string, unknown>;

function rowToEndpoint(row: Row): DiscoveredEndpoint {
  return {
    id: String(row.id),
    url: String(row.url),
    kind: row.kind as DiscoveredEndpoint['kind'],
    nature: row.nature as DiscoveredEndpoint['nature'],
    discoveredIn: String(row.discovered_in),
    evidence: Array.isArray(row.evidence) ? (row.evidence as string[]) : [],
    probe: (row.probe as DiscoveredEndpoint['probe']) ?? undefined,
  };
}

function rowToLocation(row: Row): LocationRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as 'city' | 'area',
    parentId: (row.parent_id as string | null) ?? null,
    sourceUrl: String(row.source_url),
    sourceField: (row.source_field as string | null) ?? undefined,
    bbox: toBbox(row.bbox_array),
    featureCount: (row.feature_count as number | null) ?? null,
  };
}

function rowToLayer(row: Row): LayerRecord {
  return {
    id: String(row.id),
    sourceLayerId: String(row.source_layer_id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    category: row.category as LayerRecord['category'],
    endpointId: (row.dataset_id as string | null) ?? '',
    endpointKind: row.endpoint_kind as LayerRecord['endpointKind'],
    serviceUrl: String(row.service_url),
    availability: row.availability as LayerRecord['availability'],
    crs: row.crs as LayerRecord['crs'],
    featureCount: (row.feature_count as number | null) ?? null,
    fields: Array.isArray(row.fields) ? (row.fields as LayerRecord['fields']) : [],
    bbox: toBbox(row.bbox_array),
    locationId: (row.location_id as string | null) ?? null,
    kmlExportable: Boolean(row.kml_exportable),
    kmlNote: String(row.kml_note ?? ''),
    attribution: (row.attribution as string | null) ?? null,
  };
}

function rowToFeature(row: Row): FeatureRecord {
  let geometry: Geometry | null = null;
  if (typeof row.geometry_json === 'string') {
    try {
      geometry = JSON.parse(row.geometry_json) as Geometry;
    } catch {
      geometry = null;
    }
  }

  const crsCode = row.source_crs as string | null;
  const crs = crsCode ? identifyCrs(crsCode, 'Recorded when this feature was read from the source.') : UNKNOWN_CRS;

  return {
    id: String(row.id),
    layerId: String(row.layer_id),
    sourceFeatureId: (row.source_id as string | null) ?? null,
    name: String(row.feature_name),
    geometryType: (row.feature_type as string | null) ?? geometry?.type ?? null,
    properties: (row.properties as FeatureRecord['properties']) ?? {},
    geometry,
    crs,
    provenance: row.provenance as FeatureRecord['provenance'],
    provenanceNote: String(row.provenance_note ?? ''),
    areaSquareMetres: geometry ? areaSquareMetres(geometry) : null,
    bbox: toBbox(row.bbox_array) ?? (geometry ? describeGeometry(geometry).bbox : null),
    kmlAvailable: Boolean(row.kml_available),
    kmlNote: String(row.kml_note ?? ''),
    sourceUrl: String(row.source_url),
  };
}

function rowToExport(row: Row): ExportJob {
  const requested = (row.requested as { request?: unknown; notes?: string[]; skipped?: unknown; artifact?: unknown }) ?? {};
  return {
    id: String(row.id),
    label: String(row.label),
    status: row.status as ExportJob['status'],
    format: row.format as ExportJob['format'],
    request: requested.request as ExportJob['request'],
    progress: (row.progress as ExportJob['progress']) ?? {
      phase: 'done',
      featuresProcessed: 0,
      featuresTotal: null,
      geometryValidationPercent: 100,
      generationPercent: 100,
      message: '',
    },
    featureCount: (row.feature_count as number) ?? 0,
    skipped: Array.isArray(requested.skipped) ? (requested.skipped as ExportJob['skipped']) : [],
    validation: (row.validation as ExportJob['validation']) ?? null,
    artifact: (requested.artifact as ExportJob['artifact']) ?? null,
    error: (row.error as string | null) ?? null,
    notes: Array.isArray(requested.notes) ? requested.notes : [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}
