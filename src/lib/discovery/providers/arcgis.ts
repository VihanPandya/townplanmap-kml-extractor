/**
 * ArcGIS REST provider (FeatureServer / MapServer).
 *
 * ArcGIS Server is the most common back end behind Indian municipal planning
 * portals, so this is the provider that does most of the work. It reads the
 * service description to enumerate layers, and pages through `/query` to read
 * features, preferring `f=geojson` and falling back to Esri JSON when the
 * deployment is too old to offer it.
 */

import { LIMITS } from '@/lib/config';
import { safeFetch, asJson } from '@/lib/net/safe-fetch';
import { identifyCrs, normaliseCrsCode, geojsonDefaultCrs, type CrsIdentification } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import type { Geometry } from '@/lib/geo/types';
import type { DiscoveredEndpoint, FeatureRecord, LayerRecord } from '../types';
import { hash } from '../harvest';
import {
  categoriseLayer,
  deriveFeatureName,
  toLayerFields,
  type FeaturePage,
  type FeatureQuery,
  type GeoProvider,
  type ProviderContext,
} from './base';
import {
  esriGeometryToGeoJson,
  esriGeometryTypeToGeoJson,
  normaliseAttributes,
  type EsriFeature,
} from './esri-json';

type EsriLayerSummary = {
  id?: number;
  name?: string;
  type?: string;
  geometryType?: string;
  description?: string;
  defaultVisibility?: boolean;
  subLayerIds?: number[] | null;
};

type EsriServiceInfo = {
  currentVersion?: number;
  serviceDescription?: string;
  description?: string;
  copyrightText?: string;
  layers?: EsriLayerSummary[];
  tables?: EsriLayerSummary[];
  spatialReference?: { wkid?: number; latestWkid?: number };
  fullExtent?: EsriExtent;
  capabilities?: string;
  supportedQueryFormats?: string;
  maxRecordCount?: number;
  folders?: string[];
  services?: Array<{ name?: string; type?: string }>;
  error?: { code?: number; message?: string };
};

type EsriExtent = {
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  spatialReference?: { wkid?: number; latestWkid?: number };
};

type EsriLayerInfo = EsriLayerSummary & {
  fields?: Array<{ name?: string; alias?: string; type?: string }>;
  objectIdField?: string;
  displayField?: string;
  extent?: EsriExtent;
  maxRecordCount?: number;
  capabilities?: string;
  supportsPagination?: boolean;
  advancedQueryCapabilities?: { supportsPagination?: boolean };
  copyrightText?: string;
  error?: { code?: number; message?: string };
};

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Strip any trailing sub-layer index to get the service root. */
function serviceRootOf(url: string): { root: string; layerIndex: number | null } {
  const cleaned = url.split('?')[0]?.replace(/\/$/, '') ?? url;
  const match = /^(.*\/(?:FeatureServer|MapServer))(?:\/(\d+))?$/i.exec(cleaned);
  if (!match?.[1]) return { root: cleaned, layerIndex: null };
  return { root: match[1], layerIndex: match[2] ? Number.parseInt(match[2], 10) : null };
}

function extentToBbox(extent: EsriExtent | undefined): [number, number, number, number] | null {
  if (!extent) return null;
  const { xmin, ymin, xmax, ymax } = extent;
  if ([xmin, ymin, xmax, ymax].some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return null;
  }
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  // Only report a bbox when it is already in degrees; a projected extent would
  // be misleading in a field the UI labels as longitude/latitude.
  if (wkid !== 4326) return null;
  return [xmin as number, ymin as number, xmax as number, ymax as number];
}

function crsOfService(info: { spatialReference?: { wkid?: number; latestWkid?: number } } | undefined): CrsIdentification {
  const wkid = info?.spatialReference?.latestWkid ?? info?.spatialReference?.wkid;
  if (wkid === undefined) {
    return identifyCrs(null, 'The ArcGIS service did not report a spatial reference for this layer.');
  }
  return identifyCrs(wkid, `ArcGIS reported spatial reference WKID ${wkid}.`);
}

export class ArcGisProvider implements GeoProvider {
  readonly id = 'arcgis';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return (
      endpoint.kind === 'arcgis-feature-server' ||
      endpoint.kind === 'arcgis-map-server' ||
      endpoint.kind === 'arcgis-rest-root'
    );
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const { root } = serviceRootOf(endpoint.url);
    const infoUrl = withParams(root, { f: 'json' });
    const response = await safeFetch(infoUrl, {
      budget: context.budget,
      signal: context.signal,
      accept: 'application/json',
    });

    if (!response.ok) {
      if (response.kind === 'auth-required') {
        return [
          this.restrictedLayer(endpoint, root, 'This dataset requires authorised access through TownPlanMap.'),
        ];
      }
      return [];
    }

    const info = asJson<EsriServiceInfo>(response);
    if (!info || info.error) {
      return [];
    }

    const serviceCrs = crsOfService(info);
    const summaries = [...(info.layers ?? [])].filter(
      (layer) => typeof layer.id === 'number' && layer.type !== 'Group Layer',
    );

    if (summaries.length === 0) {
      return [];
    }

    const layers: LayerRecord[] = [];
    // Describing every sub-layer costs one request each; stay inside the budget
    // and fall back to the summary description for the rest.
    const describeBudget = Math.min(summaries.length, Math.max(0, context.budget.requestsRemaining - 4));

    for (const [index, summary] of summaries.entries()) {
      const sourceLayerId = String(summary.id);
      const layerUrl = `${root}/${sourceLayerId}`;
      let detail: EsriLayerInfo | null = null;

      if (index < describeBudget) {
        const detailResponse = await safeFetch(withParams(layerUrl, { f: 'json' }), {
          budget: context.budget,
          signal: context.signal,
          accept: 'application/json',
        });
        if (detailResponse.ok) detail = asJson<EsriLayerInfo>(detailResponse);
      }

      const name = detail?.name ?? summary.name ?? `Layer ${sourceLayerId}`;
      const esriGeometryType = detail?.geometryType ?? summary.geometryType ?? null;
      const geoJsonType = esriGeometryTypeToGeoJson(esriGeometryType);
      const capabilities = (detail?.capabilities ?? info.capabilities ?? '').toLowerCase();
      const queryable = capabilities.includes('query') || capabilities === '';
      const crs = detail?.extent ? crsOfService(detail.extent) : serviceCrs;

      const hasVector = Boolean(geoJsonType) && queryable;
      const isRasterService =
        endpoint.kind === 'arcgis-map-server' && !queryable && !geoJsonType;

      layers.push({
        id: `layer_arcgis_${hash(layerUrl)}`,
        sourceLayerId,
        name,
        description: detail?.description ?? summary.description ?? info.serviceDescription ?? null,
        category: categoriseLayer(name, detail?.description ?? summary.description ?? null),
        endpointId: endpoint.id,
        endpointKind: endpoint.kind,
        serviceUrl: layerUrl,
        availability: hasVector
          ? {
              status: 'vector',
              geometryTypes: geoJsonType ? [geoJsonType] : [],
              note: `ArcGIS reports geometry type ${esriGeometryType} and supports queries, so coordinates can be read directly.`,
            }
          : isRasterService
            ? {
                status: 'raster',
                note: 'This MapServer layer renders images and does not expose a queryable feature set.',
              }
            : {
                status: 'unknown',
                note: 'The service did not report a geometry type or query capability for this layer.',
              },
        crs,
        featureCount: null,
        fields: toLayerFields(detail?.fields),
        bbox: extentToBbox(detail?.extent ?? info.fullExtent),
        locationId: context.locationId ?? null,
        kmlExportable: hasVector && crs.transformable,
        kmlNote: !hasVector
          ? 'No vector geometry is exposed for this layer, so KML cannot be generated from it.'
          : crs.transformable
            ? crs.isWgs84
              ? 'Geometry is published in WGS84 and can be written to KML directly.'
              : `Geometry is published in ${crs.code} and will be transformed to WGS84 for KML.`
            : 'The layer’s coordinate reference system could not be resolved, so KML cannot be generated reliably.',
        attribution: detail?.copyrightText ?? info.copyrightText ?? null,
      });
    }

    return layers;
  }

  private restrictedLayer(endpoint: DiscoveredEndpoint, url: string, note: string): LayerRecord {
    return {
      id: `layer_arcgis_${hash(url)}`,
      sourceLayerId: '',
      name: 'Restricted service',
      description: note,
      category: 'other',
      endpointId: endpoint.id,
      endpointKind: endpoint.kind,
      serviceUrl: url,
      availability: { status: 'restricted', note },
      crs: identifyCrs(null, note),
      featureCount: null,
      fields: [],
      bbox: null,
      locationId: null,
      kmlExportable: false,
      kmlNote: note,
      attribution: null,
    };
  }

  /** Ask the service how many features match, without downloading them. */
  async countFeatures(layer: LayerRecord, context: ProviderContext, where = '1=1'): Promise<number | null> {
    const response = await safeFetch(
      withParams(`${layer.serviceUrl}/query`, { where, returnCountOnly: 'true', f: 'json' }),
      { budget: context.budget, signal: context.signal, accept: 'application/json' },
    );
    if (!response.ok) return null;
    const payload = asJson<{ count?: number }>(response);
    return typeof payload?.count === 'number' ? payload.count : null;
  }

  async listFeatures(
    layer: LayerRecord,
    query: FeatureQuery,
    context: ProviderContext,
  ): Promise<FeaturePage> {
    const notes: string[] = [];
    const limit = Math.min(query.limit ?? LIMITS.featurePageSize, LIMITS.featurePageSize);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const includeGeometry = query.includeGeometry !== false;

    const where = this.buildWhere(layer, query);
    if (query.search && where === '1=1') {
      notes.push(
        'No text attribute was available to filter on server-side, so the search was applied to the features returned.',
      );
    }

    const params: Record<string, string> = {
      where,
      outFields: '*',
      returnGeometry: includeGeometry ? 'true' : 'false',
      f: 'geojson',
      resultOffset: String(offset),
      resultRecordCount: String(limit),
      outSR: '4326',
    };
    if (query.ids && query.ids.length > 0) {
      params.objectIds = query.ids.join(',');
      params.where = '1=1';
      delete params.resultOffset;
    }
    if (query.bbox) {
      params.geometry = query.bbox.join(',');
      params.geometryType = 'esriGeometryEnvelope';
      params.inSR = '4326';
      params.spatialRel = 'esriSpatialRelIntersects';
    }

    let response = await safeFetch(withParams(`${layer.serviceUrl}/query`, params), {
      budget: context.budget,
      signal: context.signal,
      accept: 'application/json',
    });

    // `outSR=4326` makes the service do the projection, which is authoritative.
    // Record that so provenance reflects who did the transformation.
    let transformedUpstream = true;
    let payload = response.ok ? asJson<Record<string, unknown>>(response) : null;

    const geojsonUnsupported =
      !response.ok ||
      !payload ||
      (typeof payload === 'object' && 'error' in payload && payload.error !== undefined);

    if (geojsonUnsupported) {
      // Older ArcGIS: retry with the native Esri JSON format.
      const esriParams = { ...params, f: 'json' };
      response = await safeFetch(withParams(`${layer.serviceUrl}/query`, esriParams), {
        budget: context.budget,
        signal: context.signal,
        accept: 'application/json',
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
              : `The service could not be queried: ${response.reason}`,
          ],
        };
      }
      payload = asJson<Record<string, unknown>>(response);
      notes.push('The service does not support GeoJSON output; Esri JSON was read and converted.');
    }

    if (!payload) {
      return { features: [], nextCursor: null, total: null, truncated: false, notes: ['The service returned a response that was not valid JSON.'] };
    }

    if ('error' in payload && payload.error) {
      const message =
        typeof payload.error === 'object' && payload.error && 'message' in payload.error
          ? String((payload.error as Record<string, unknown>).message)
          : 'The service rejected the query.';
      return { features: [], nextCursor: null, total: null, truncated: false, notes: [message] };
    }

    const features: FeatureRecord[] = [];
    const isGeoJson = payload.type === 'FeatureCollection';

    if (isGeoJson) {
      const raw = Array.isArray(payload.features) ? payload.features : [];
      for (const [index, entry] of raw.entries()) {
        const record = this.geoJsonFeatureToRecord(
          entry as Record<string, unknown>,
          layer,
          offset + index,
          includeGeometry,
          transformedUpstream,
        );
        if (record) features.push(record);
      }
    } else {
      const raw = Array.isArray(payload.features) ? (payload.features as EsriFeature[]) : [];
      const declaredWkid =
        (payload.spatialReference as { latestWkid?: number; wkid?: number } | undefined)?.latestWkid ??
        (payload.spatialReference as { latestWkid?: number; wkid?: number } | undefined)?.wkid;
      const responseCrs =
        declaredWkid === undefined
          ? layer.crs
          : identifyCrs(declaredWkid, `The query response declared spatial reference WKID ${declaredWkid}.`);
      transformedUpstream = normaliseCrsCode(declaredWkid ?? null) === 'EPSG:4326';
      const objectIdField =
        typeof payload.objectIdFieldName === 'string' ? payload.objectIdFieldName : 'OBJECTID';

      for (const [index, entry] of raw.entries()) {
        const record = this.esriFeatureToRecord(
          entry,
          layer,
          responseCrs,
          objectIdField,
          offset + index,
          includeGeometry,
          transformedUpstream,
        );
        if (record) features.push(record);
      }
    }

    const exceeded = payload.exceededTransferLimit === true || (payload.properties as Record<string, unknown> | undefined)?.exceededTransferLimit === true;
    const hasMore = features.length >= limit || exceeded === true;

    let filtered = features;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = features.filter((feature) => featureMatches(feature, needle));
    }

    return {
      features: filtered,
      nextCursor: hasMore && !query.ids ? String(offset + limit) : null,
      total: layer.featureCount,
      truncated: exceeded === true,
      notes,
    };
  }

  /**
   * Build a server-side WHERE clause for a text search.
   *
   * Values are escaped by doubling single quotes — the SQL-92 escape ArcGIS
   * expects — and the search is only applied to fields the service told us
   * exist, so a caller cannot use it to smuggle arbitrary SQL into the query.
   */
  private buildWhere(layer: LayerRecord, query: FeatureQuery): string {
    if (!query.search) return '1=1';
    const needle = query.search.trim();
    if (!needle) return '1=1';

    const textFields = layer.fields.filter((field) => {
      const type = (field.type ?? '').toLowerCase();
      return type.includes('string') || type.includes('text');
    });
    if (textFields.length === 0) return '1=1';

    const escaped = needle.replace(/'/g, "''");
    const clauses = textFields
      .slice(0, 12)
      .map((field) => `UPPER(${sanitiseFieldName(field.name)}) LIKE UPPER('%${escaped}%')`);
    return clauses.length > 0 ? clauses.join(' OR ') : '1=1';
  }

  private geoJsonFeatureToRecord(
    entry: Record<string, unknown>,
    layer: LayerRecord,
    index: number,
    includeGeometry: boolean,
    transformedUpstream: boolean,
  ): FeatureRecord | null {
    const properties = normaliseAttributes(entry.properties as Record<string, unknown> | undefined);
    const geometry = includeGeometry ? ((entry.geometry as Geometry | null) ?? null) : null;
    const sourceId =
      entry.id !== undefined && entry.id !== null
        ? String(entry.id)
        : findObjectId(properties);
    const { name } = deriveFeatureName(properties, sourceId, layer.name);

    // The service was asked for outSR=4326 and answered in GeoJSON, which RFC
    // 7946 defines as WGS84.
    const crs = geojsonDefaultCrs();
    const stats = geometry ? describeGeometry(geometry) : null;

    return {
      id: `feat_${layer.id}_${sourceId ?? index}`,
      layerId: layer.id,
      sourceFeatureId: sourceId,
      name,
      geometryType: geometry?.type ?? null,
      properties,
      geometry,
      crs,
      provenance: transformedUpstream && !layer.crs.isWgs84 ? 'crs-converted' : 'source-geometry',
      provenanceNote:
        transformedUpstream && !layer.crs.isWgs84
          ? `The service reprojected this geometry from ${layer.crs.code ?? 'its native CRS'} to WGS84 on request (outSR=4326).`
          : 'Coordinates are exactly as the service published them.',
      areaSquareMetres: geometry ? areaSquareMetres(geometry) : null,
      bbox: stats?.bbox ?? null,
      kmlAvailable: Boolean(geometry) || layer.kmlExportable,
      kmlNote: layer.kmlNote,
      sourceUrl: layer.serviceUrl,
    };
  }

  private esriFeatureToRecord(
    entry: EsriFeature,
    layer: LayerRecord,
    crs: CrsIdentification,
    objectIdField: string,
    index: number,
    includeGeometry: boolean,
    transformedUpstream: boolean,
  ): FeatureRecord | null {
    const properties = normaliseAttributes(entry.attributes);
    const geometry = includeGeometry ? esriGeometryToGeoJson(entry.geometry) : null;
    const rawId = entry.attributes?.[objectIdField];
    const sourceId =
      rawId !== undefined && rawId !== null ? String(rawId) : findObjectId(properties);
    const { name } = deriveFeatureName(properties, sourceId, layer.name);
    const stats = geometry ? describeGeometry(geometry) : null;

    return {
      id: `feat_${layer.id}_${sourceId ?? index}`,
      layerId: layer.id,
      sourceFeatureId: sourceId,
      name,
      geometryType: geometry?.type ?? null,
      properties,
      geometry,
      crs,
      provenance: transformedUpstream && !layer.crs.isWgs84 ? 'crs-converted' : 'source-geometry',
      provenanceNote:
        transformedUpstream && !layer.crs.isWgs84
          ? `The service reprojected this geometry to ${crs.code ?? 'WGS84'} on request.`
          : `Coordinates are as published by the service in ${crs.code ?? 'an undeclared CRS'}.`,
      areaSquareMetres: geometry && crs.isWgs84 ? areaSquareMetres(geometry) : null,
      bbox: crs.isWgs84 ? (stats?.bbox ?? null) : null,
      kmlAvailable: Boolean(geometry) && crs.transformable,
      kmlNote: crs.transformable
        ? layer.kmlNote
        : 'The coordinate reference system of this feature is unknown, so KML cannot be generated reliably.',
      sourceUrl: layer.serviceUrl,
    };
  }
}

/** Only a plain identifier may be interpolated into a WHERE clause. */
function sanitiseFieldName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // Quote it the way ArcGIS/SQL expects and strip anything that could escape.
    return `"${name.replace(/[^A-Za-z0-9_ ]/g, '')}"`;
  }
  return name;
}

const OBJECT_ID_PATTERNS = [/^objectid$/i, /^fid$/i, /^oid$/i, /^gid$/i, /^id$/i, /^globalid$/i];

function findObjectId(properties: Record<string, string | number | boolean | null>): string | null {
  for (const pattern of OBJECT_ID_PATTERNS) {
    for (const [key, value] of Object.entries(properties)) {
      if (pattern.test(key) && value !== null && value !== '') return String(value);
    }
  }
  return null;
}

/** Client-side attribute match, used when the service cannot filter for us. */
export function featureMatches(feature: FeatureRecord, needle: string): boolean {
  if (feature.name.toLowerCase().includes(needle)) return true;
  if (feature.sourceFeatureId?.toLowerCase().includes(needle)) return true;
  for (const value of Object.values(feature.properties)) {
    if (value === null) continue;
    if (String(value).toLowerCase().includes(needle)) return true;
  }
  return false;
}
