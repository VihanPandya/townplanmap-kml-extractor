/**
 * Endpoint probing.
 *
 * Harvesting produces guesses; probing spends a request to find out what a URL
 * really serves. Only the first slice of a body is needed to classify it, so
 * probes are capped well below the global response limit — a probe should never
 * pull down a multi-megabyte dataset just to learn its type.
 */

import { safeFetch, asText } from '@/lib/net/safe-fetch';
import { classifyBody, classifyUrl } from '@/lib/geo/detect';
import type { RequestBudget } from '@/lib/net/budget';
import type { DiscoveredEndpoint, EndpointProbe } from './types';

/** Enough bytes to identify a format and read a service description. */
const PROBE_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

/** Pull the details worth showing in the data-source panel out of a payload. */
function describePayload(kind: string, body: Uint8Array): EndpointProbe['detail'] {
  const detail: EndpointProbe['detail'] = {};
  const head = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, PROBE_BYTES));

  if (kind === 'geojson') {
    try {
      const document = JSON.parse(head) as JsonRecord;
      if (Array.isArray(document.features)) {
        detail.featureCount = document.features.length;
        const types = new Set<string>();
        for (const entry of document.features.slice(0, 500)) {
          const geometry = (entry as JsonRecord).geometry as JsonRecord | null;
          if (geometry && typeof geometry.type === 'string') types.add(geometry.type);
        }
        if (types.size > 0) detail.geometryTypes = [...types].join(',');
      }
      const crs = document.crs as { properties?: { name?: string } } | undefined;
      if (crs?.properties?.name) detail.crs = crs.properties.name;
      if (typeof document.name === 'string') detail.documentName = document.name;
    } catch {
      // A truncated probe body will not parse; that is expected and harmless.
      detail.note = 'Only the first part of the document was read, so its feature count is not yet known.';
    }
    return detail;
  }

  if (kind === 'arcgis-rest-root' || kind === 'arcgis-feature-server' || kind === 'arcgis-map-server') {
    try {
      const document = JSON.parse(head) as JsonRecord;
      if (typeof document.currentVersion === 'number') detail.version = document.currentVersion;
      if (typeof document.serviceDescription === 'string') detail.description = document.serviceDescription;
      if (Array.isArray(document.layers)) detail.layerCount = document.layers.length;
      if (Array.isArray(document.services)) detail.serviceCount = document.services.length;
      if (Array.isArray(document.folders)) detail.folderCount = document.folders.length;
      if (typeof document.capabilities === 'string') detail.capabilities = document.capabilities;
      const spatial = document.spatialReference as { wkid?: number; latestWkid?: number } | undefined;
      const wkid = spatial?.latestWkid ?? spatial?.wkid;
      if (wkid) detail.crs = `EPSG:${wkid}`;
      if (typeof document.copyrightText === 'string' && document.copyrightText) {
        detail.attribution = document.copyrightText;
      }
    } catch {
      /* truncated or non-JSON */
    }
    return detail;
  }

  if (kind === 'maplibre-style' || kind === 'tilejson') {
    try {
      const document = JSON.parse(head) as JsonRecord;
      if (typeof document.name === 'string') detail.documentName = document.name;
      if (typeof document.attribution === 'string') detail.attribution = document.attribution;
      const sources = document.sources as Record<string, JsonRecord> | undefined;
      if (sources) {
        detail.sourceCount = Object.keys(sources).length;
        detail.sourceNames = Object.keys(sources).slice(0, 40).join(',');
      }
      if (Array.isArray(document.vector_layers)) {
        detail.vectorLayers = document.vector_layers
          .map((entry) => (entry as JsonRecord).id)
          .filter((id): id is string => typeof id === 'string')
          .join(',');
      }
      if (Array.isArray(document.tiles) && typeof document.tiles[0] === 'string') {
        detail.tileTemplate = document.tiles[0];
      }
    } catch {
      /* truncated or non-JSON */
    }
    return detail;
  }

  if (kind === 'kml') {
    const placemarks = head.match(/<Placemark[\s>]/gi)?.length ?? 0;
    if (placemarks > 0) detail.featureCount = placemarks;
    const name = /<name>([^<]{1,200})<\/name>/i.exec(head);
    if (name?.[1]) detail.documentName = name[1].trim();
    return detail;
  }

  if (kind === 'ogc-wfs' || kind === 'ogc-wms') {
    const title = /<Title>([^<]{1,200})<\/Title>/i.exec(head);
    if (title?.[1]) detail.documentName = title[1].trim();
    const version = /version=["']([\d.]+)["']/i.exec(head);
    if (version?.[1]) detail.version = version[1];
    const featureTypes = head.match(/<FeatureType>/gi)?.length ?? 0;
    if (featureTypes > 0) detail.layerCount = featureTypes;
    return detail;
  }

  return detail;
}

/**
 * Probe one endpoint and update it in place with what was learnt.
 *
 * An ArcGIS REST URL is probed with `f=json` appended, since the bare URL
 * returns an HTML console page that says nothing useful about the service.
 */
export async function probeEndpoint(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal?: AbortSignal,
): Promise<DiscoveredEndpoint> {
  let probeUrl = endpoint.url;
  if (endpoint.kind.startsWith('arcgis-') && !/[?&]f=/i.test(probeUrl)) {
    const url = new URL(probeUrl);
    url.searchParams.set('f', 'json');
    probeUrl = url.toString();
  }
  if (endpoint.kind === 'ogc-wfs' && !/request=/i.test(probeUrl)) {
    const url = new URL(probeUrl);
    url.searchParams.set('service', 'WFS');
    url.searchParams.set('request', 'GetCapabilities');
    probeUrl = url.toString();
  }
  if (endpoint.kind === 'vector-tiles' && /\{[zxy]\}/i.test(probeUrl)) {
    // A template cannot be fetched as-is, and guessing a populated tile would
    // spend a request on a likely miss. Report it as a template instead.
    return {
      ...endpoint,
      probe: {
        reachable: false,
        status: null,
        contentType: null,
        bytes: null,
        detail: { note: 'Tile URL template; tiles are fetched per map view rather than probed.' },
        failureKind: 'template',
        failureReason: 'This is a tile URL template, not a single fetchable document.',
      },
    };
  }

  const response = await safeFetch(probeUrl, {
    budget,
    signal,
    maxBytes: PROBE_BYTES,
    accept: 'application/json,application/geo+json,application/xml,text/xml,*/*;q=0.5',
  });

  if (!response.ok) {
    return {
      ...endpoint,
      probe: {
        reachable: false,
        status: response.status,
        contentType: null,
        bytes: null,
        detail: {},
        failureKind: response.kind,
        failureReason: response.reason,
      },
    };
  }

  const detection = classifyBody(response.body, response.contentType, classifyUrl(endpoint.url));
  const detail = describePayload(detection.kind, response.body);

  return {
    ...endpoint,
    kind: detection.kind,
    nature: detection.nature,
    evidence: [...new Set([...endpoint.evidence, ...detection.evidence])],
    probe: {
      reachable: true,
      status: response.status,
      contentType: response.contentType || null,
      bytes: response.bytes,
      detail,
    },
  };
}

/** Read a probed body back as text, for callers that need the document itself. */
export async function fetchDocument(
  url: string,
  budget: RequestBudget,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<{ ok: true; text: string; finalUrl: string } | { ok: false; reason: string; kind: string }> {
  const response = await safeFetch(url, { budget, signal, maxBytes, accept: '*/*' });
  if (!response.ok) return { ok: false, reason: response.reason, kind: response.kind };
  return { ok: true, text: asText(response), finalUrl: response.finalUrl };
}
