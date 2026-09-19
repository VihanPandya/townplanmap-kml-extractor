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
import { identifyCrs, geojsonDefaultCrs, UNKNOWN_CRS } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import { axisOrderLooksTransposed, parseGmlFeatureCollection } from './gml';
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
      // The deployment cannot emit GeoJSON. Ask for GML instead, which every
      // WFS must support, rather than giving up on an otherwise usable service.
      return this.readAsGml(layer, { base, params, offset, limit, isV2 }, query, context, notes);
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
  /**
   * Read a feature page as GML.
   *
   * Used when the deployment cannot emit GeoJSON. Every WFS must serve GML, so
   * this is the difference between an unusable service and a working one.
   *
   * `srsName` is requested as CRS84, whose axis order is unambiguous by
   * definition. If the server ignores that and answers in its own CRS, the
   * declared `srsName` on the response is honoured instead — and a feature
   * whose CRS the server never declared is marked as having an unknown CRS, so
   * the export pipeline refuses it rather than guessing at coordinate order.
   */
  private async readAsGml(
    layer: LayerRecord,
    request: { base: string; params: Record<string, string>; offset: number; limit: number; isV2: boolean },
    query: FeatureQuery,
    context: ProviderContext,
    notes: string[],
  ): Promise<FeaturePage> {
    const gmlParams: Record<string, string> = { ...request.params };
    delete gmlParams.outputFormat;
    // CRS84 is longitude/latitude by definition, which removes the axis-order
    // ambiguity entirely when the server honours it.
    gmlParams.srsName = 'urn:ogc:def:crs:OGC:1.3:CRS84';

    const response = await safeFetch(withParams(request.base, gmlParams), {
      budget: context.budget,
      signal: context.signal,
      accept: 'application/gml+xml,text/xml,application/xml',
      maxBytes: LIMITS.maxXmlBytes,
    });

    if (!response.ok) {
      return {
        features: [],
        nextCursor: null,
        total: null,
        truncated: false,
        notes: [
          ...notes,
          response.kind === 'auth-required'
            ? 'This dataset requires authorised access through TownPlanMap.'
            : `The service does not support GeoJSON, and the GML request also failed: ${response.reason}`,
        ],
      };
    }

    // Deliberately no fallback srsName. Asking for CRS84 is not the same as the
    // server confirming it: plenty of deployments ignore the parameter and
    // answer in their native CRS. Treating our own request as a declaration
    // would be claiming EPSG:4326 without verifying it, so an undeclared CRS
    // stays unknown and the export pipeline refuses the geometry.
    const parsed = parseGmlFeatureCollection(asText(response), null);
    if (!parsed.ok) {
      return {
        features: [],
        nextCursor: null,
        total: null,
        truncated: false,
        notes: [...notes, `The service does not support GeoJSON, and its GML could not be read: ${parsed.reason}`],
      };
    }

    notes.push('The service does not support GeoJSON output; GML was read and converted.');
    notes.push(...parsed.result.notes);

    const features: FeatureRecord[] = [];
    let transposedSuspected = 0;

    for (const [index, entry] of parsed.result.features.entries()) {
      const sourceId = entry.id;
      const { name } = deriveFeatureName(entry.properties, sourceId, layer.name);
      const stats = entry.geometry ? describeGeometry(entry.geometry) : null;

      // Without a declared CRS the coordinate order cannot be established, so
      // the feature is carried with an unknown CRS and the pipeline refuses to
      // export it. That is the honest outcome, not a silent assumption.
      const crs = entry.srs.declared
        ? identifyCrs(entry.srs.code, `${entry.srs.reason} Read from the service\u2019s GML output.`)
        : UNKNOWN_CRS;

      // A one-sided sanity check on the axis-order decision.
      if (entry.geometry && stats?.bbox) {
        const corners: Array<[number, number]> = [
          [stats.bbox[0], stats.bbox[1]],
          [stats.bbox[2], stats.bbox[3]],
        ];
        if (axisOrderLooksTransposed(corners)) transposedSuspected += 1;
      }

      features.push({
        id: `feat_${layer.id}_${sourceId ?? request.offset + index}`,
        layerId: layer.id,
        sourceFeatureId: sourceId,
        name,
        geometryType: entry.geometry?.type ?? null,
        properties: entry.properties,
        geometry: entry.geometry,
        crs,
        provenance: crs.code === null ? 'unverified' : 'source-geometry',
        provenanceNote:
          crs.code === null
            ? 'CRS84 was requested, but the service declared no coordinate reference system on its GML ' +
              'response, so neither the CRS nor the coordinate order could be confirmed. The geometry is ' +
              'shown as received and is not offered for KML export.'
            : `Coordinates are as published in the service\u2019s GML. ${entry.srs.reason}`,
        areaSquareMetres: entry.geometry && crs.isWgs84 ? areaSquareMetres(entry.geometry) : null,
        bbox: crs.isWgs84 ? (stats?.bbox ?? null) : null,
        kmlAvailable: Boolean(entry.geometry) && crs.transformable,
        kmlNote: crs.transformable
          ? layer.kmlNote
          : 'The coordinate reference system of this geometry is unknown, so KML cannot be generated reliably.',
        sourceUrl: layer.serviceUrl,
      });
    }

    if (transposedSuspected > 0) {
      notes.push(
        `${transposedSuspected} feature(s) fall outside the expected geographic area once the declared axis ` +
          'order is applied, but would fall inside it if longitude and latitude were swapped. The coordinates ' +
          'have been left exactly as the declared CRS dictates \u2014 they have not been silently corrected \u2014 but ' +
          'verify them against the source before use.',
      );
    }

    let filtered = features;
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = features.filter((feature) => featureMatches(feature, needle));
    }

    const total = parsed.result.numberMatched;
    const hasMore =
      request.isV2 && features.length >= request.limit && (total === null || request.offset + request.limit < total);

    return {
      features: filtered,
      nextCursor: hasMore ? String(request.offset + request.limit) : null,
      total,
      truncated: false,
      notes,
    };
  }
}
