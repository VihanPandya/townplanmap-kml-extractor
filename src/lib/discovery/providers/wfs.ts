/**
 * OGC Web Feature Service provider.
 *
 * WFS is the open-standard counterpart to ArcGIS FeatureServer and is what
 * GeoServer/QGIS Server deployments expose. Capabilities are read as XML
 * through the hardened parser; features are requested as GeoJSON where the
 * server offers it, because parsing GML by hand is exactly the kind of
 * error-prone geometry work this project avoids.
 */

import { LIMITS } from '@/lib/config';
import { safeFetch, asJson, asText } from '@/lib/net/safe-fetch';
import { safeParseXml, asArray, pick, text } from '@/lib/xml/safe-parse';
import { identifyCrs, geojsonDefaultCrs } from '@/lib/geo/crs';
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

function serviceBase(url: string): string {
  const parsed = new URL(url);
  // Keep the path, drop query parameters that belong to a specific request.
  for (const key of [...parsed.searchParams.keys()]) {
    if (!/^(map|namespace)$/i.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export class WfsProvider implements GeoProvider {
  readonly id = 'wfs';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return endpoint.kind === 'ogc-wfs';
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const base = serviceBase(endpoint.url);
    const capabilitiesUrl = withParams(base, {
      service: 'WFS',
      request: 'GetCapabilities',
      version: '2.0.0',
    });

    const response = await safeFetch(capabilitiesUrl, {
      budget: context.budget,
      signal: context.signal,
      accept: 'application/xml,text/xml',
      maxBytes: LIMITS.maxXmlBytes,
    });
    if (!response.ok) return [];

    const parsed = safeParseXml(asText(response));
    if (!parsed.ok) return [];

    const root =
      (pick(parsed.doc, 'WFS_Capabilities') as Record<string, unknown> | undefined) ??
      (pick(parsed.doc, 'Capabilities') as Record<string, unknown> | undefined);
    if (!root) return [];

    const version = text(pick(root, '@version')) ?? '2.0.0';
    const serviceTitle =
      text(pick(root, 'ServiceIdentification', 'Title')) ?? text(pick(root, 'Service', 'Title')) ?? null;
    const attribution =
      text(pick(root, 'ServiceIdentification', 'Fees')) ??
      text(pick(root, 'ServiceProvider', 'ProviderName')) ??
      null;

    const featureTypes = asArray(
      pick(root, 'FeatureTypeList', 'FeatureType') as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );

    const layers: LayerRecord[] = [];
    for (const featureType of featureTypes) {
      const typeName = text(pick(featureType, 'Name'));
      if (!typeName) continue;
      const title = text(pick(featureType, 'Title')) ?? typeName;
      const abstract = text(pick(featureType, 'Abstract')) ?? null;
      const defaultCrs =
        text(pick(featureType, 'DefaultCRS')) ??
        text(pick(featureType, 'DefaultSRS')) ??
        text(pick(featureType, 'SRS')) ??
        null;
      const crs = identifyCrs(
        defaultCrs,
        defaultCrs
          ? `The WFS capabilities document declares ${defaultCrs} for this feature type.`
          : 'The WFS capabilities document did not declare a CRS for this feature type.',
      );

      const bboxNode = pick(featureType, 'WGS84BoundingBox');
      const lower = text(pick(bboxNode, 'LowerCorner'));
      const upper = text(pick(bboxNode, 'UpperCorner'));
      let bbox: [number, number, number, number] | null = null;
      if (lower && upper) {
        const [west, south] = lower.split(/\s+/).map(Number);
        const [east, north] = upper.split(/\s+/).map(Number);
        if ([west, south, east, north].every((value) => typeof value === 'number' && Number.isFinite(value))) {
          bbox = [west as number, south as number, east as number, north as number];
        }
      }

      const serviceUrl = withParams(base, { service: 'WFS', version, typeNames: typeName });

      layers.push({
        id: `layer_wfs_${hash(`${base}#${typeName}`)}`,
        sourceLayerId: typeName,
        name: title,
        description: abstract ?? serviceTitle,
        category: categoriseLayer(title, abstract),
        endpointId: endpoint.id,
        endpointKind: endpoint.kind,
        serviceUrl,
        availability: {
          status: 'vector',
          geometryTypes: [],
          note: 'A WFS feature type always carries vector geometry; its exact type is reported per feature.',
        },
        crs,
        featureCount: null,
        fields: [],
        bbox,
        locationId: context.locationId ?? null,
        kmlExportable: true,
        kmlNote: crs.isWgs84
          ? 'Features are published in WGS84 and can be written to KML directly.'
          : crs.transformable
            ? `Features are published in ${crs.code}; coordinates will be transformed to WGS84 for KML.`
            : 'Features will be requested in WGS84 (EPSG:4326) directly from the service.',
        attribution,
      });
    }

    return layers;
  }

  async listFeatures(
    layer: LayerRecord,
    query: FeatureQuery,
    context: ProviderContext,
  ): Promise<FeaturePage> {
    const notes: string[] = [];
    const limit = Math.min(query.limit ?? LIMITS.featurePageSize, LIMITS.featurePageSize);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const base = serviceBase(layer.serviceUrl);
    const version = new URL(layer.serviceUrl).searchParams.get('version') ?? '2.0.0';
    const isV2 = version.startsWith('2');

    const params: Record<string, string> = {
      service: 'WFS',
      version,
      request: 'GetFeature',
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
    };
    params[isV2 ? 'typeNames' : 'typeName'] = layer.sourceLayerId;
    params[isV2 ? 'count' : 'maxFeatures'] = String(limit);
    if (offset > 0 && isV2) params.startIndex = String(offset);
    if (query.bbox) params.bbox = `${query.bbox.join(',')},EPSG:4326`;

    const response = await safeFetch(withParams(base, params), {
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
            : `The WFS service could not be queried: ${response.reason}`,
        ],
      };
    }

    const payload = asJson<{
      type?: string;
      features?: Array<Record<string, unknown>>;
      numberMatched?: number;
      numberReturned?: number;
      totalFeatures?: number;
      crs?: unknown;
    }>(response);

    if (!payload || payload.type !== 'FeatureCollection') {
      return {
        features: [],
        nextCursor: null,
        total: null,
        truncated: false,
        notes: [
          'The service did not return GeoJSON. This deployment may only offer GML output, which this build does not parse.',
        ],
      };
    }

    // The request asked for EPSG:4326 and the response is GeoJSON.
    const crs = geojsonDefaultCrs();
    const features: FeatureRecord[] = [];

    for (const [index, entry] of (payload.features ?? []).entries()) {
      const properties = normaliseAttributes(entry.properties as Record<string, unknown> | undefined);
      const geometry = (entry.geometry as Geometry | null) ?? null;
      const sourceId = entry.id !== undefined && entry.id !== null ? String(entry.id) : null;
      const { name } = deriveFeatureName(properties, sourceId, layer.name);
      const stats = geometry ? describeGeometry(geometry) : null;

      features.push({
        id: `feat_${layer.id}_${sourceId ?? offset + index}`,
        layerId: layer.id,
        sourceFeatureId: sourceId,
        name,
        geometryType: geometry?.type ?? null,
        properties,
        geometry,
        crs,
        provenance: layer.crs.isWgs84 ? 'source-geometry' : 'crs-converted',
        provenanceNote: layer.crs.isWgs84
          ? 'Coordinates are exactly as the service published them.'
          : `The service reprojected this geometry from ${layer.crs.code ?? 'its native CRS'} to WGS84 on request (srsName=EPSG:4326).`,
        areaSquareMetres: geometry ? areaSquareMetres(geometry) : null,
        bbox: stats?.bbox ?? null,
        kmlAvailable: Boolean(geometry),
        kmlNote: layer.kmlNote,
        sourceUrl: layer.serviceUrl,
      });
    }

    const total =
      typeof payload.numberMatched === 'number'
        ? payload.numberMatched
        : typeof payload.totalFeatures === 'number'
          ? payload.totalFeatures
          : null;

    let filtered = features;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = features.filter((feature) => featureMatches(feature, needle));
      notes.push('WFS attribute filtering is applied to the features returned by this page.');
    }

    const hasMore = isV2 && features.length >= limit && (total === null || offset + limit < total);

    return {
      features: filtered,
      nextCursor: hasMore ? String(offset + limit) : null,
      total,
      truncated: false,
      notes,
    };
  }
}
