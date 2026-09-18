/**
 * The Geospatial Data Discovery Engine.
 *
 * Given the source's base URL it:
 *   1. reads the landing page,
 *   2. reads the bundled and inline JavaScript that configures the map,
 *   3. harvests every URL that could plausibly serve geographic data,
 *   4. probes the best candidates to learn what each one really is,
 *   5. expands map style documents and ArcGIS service directories one level,
 *   6. reports what was found and — just as importantly — what was not.
 *
 * Fetched JavaScript is only ever read as text. Nothing discovered here is
 * executed, and every request goes through the SSRF-guarded fetcher under a
 * shared request budget.
 */

import { LIMITS, SOURCE } from '@/lib/config';
import { RequestBudget } from '@/lib/net/budget';
import { safeFetch, asText, asJson } from '@/lib/net/safe-fetch';
import { classifyUrl } from '@/lib/geo/detect';
import {
  extractInlineScripts,
  extractScriptUrls,
  harvestCandidates,
  hash,
  toEndpoints,
  type Candidate,
} from './harvest';
import { probeEndpoint } from './probe';
import type { DiscoveredEndpoint, ScanResult } from './types';

/** How many JavaScript bundles to read. Bundles are large; a few is plenty. */
const MAX_SCRIPTS = 6;
/** How many candidates to spend a probe request on. */
const MAX_PROBES = 24;

export type ScanOptions = {
  baseUrl?: string;
  signal?: AbortSignal;
  budget?: RequestBudget;
  /** Extra URLs the caller already knows about (e.g. a city-specific page). */
  seeds?: string[];
};

export async function runDiscoveryScan(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const baseUrl = options.baseUrl ?? SOURCE.baseUrl;
  const budget = options.budget ?? new RequestBudget();
  const notes: string[] = [];
  const warnings: string[] = [];
  const documentsFetched: string[] = [];

  const finish = (
    endpoints: DiscoveredEndpoint[],
    failure: ScanResult['failure'],
    connected: boolean,
  ): ScanResult => ({
    id: `scan_${hash(`${baseUrl}:${startedAt}`)}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl,
    connected,
    mapInterfaceDetected: endpoints.some((endpoint) =>
      ['maplibre-style', 'tilejson', 'vector-tiles', 'raster-tiles', 'ogc-wms', 'ogc-wmts', 'arcgis-map-server'].includes(
        endpoint.kind,
      ),
    ),
    geographicLayersDetected: endpoints.some((endpoint) => endpoint.nature === 'vector'),
    endpoints,
    documentsFetched,
    requestsSpent: budget.requestsSpent,
    bytesDownloaded: budget.bytesDownloaded,
    notes,
    warnings,
    failure,
  });

  // --- 1. Landing page -----------------------------------------------------
  const landing = await safeFetch(baseUrl, {
    budget,
    signal: options.signal,
    accept: 'text/html,application/xhtml+xml',
  });

  if (!landing.ok) {
    // Report what actually happened. A refusal on the landing page is not the
    // same thing as a restricted dataset, so the fetcher's factual reason is
    // passed through rather than being relabelled.
    return finish([], { kind: landing.kind, reason: landing.reason }, false);
  }

  documentsFetched.push(landing.finalUrl);
  const html = asText(landing);
  const candidates = new Map<string, Candidate>();

  const addAll = (found: Candidate[]) => {
    for (const candidate of found) {
      const existing = candidates.get(candidate.url);
      if (existing) {
        for (const line of candidate.evidence) {
          if (!existing.evidence.includes(line)) existing.evidence.push(line);
        }
      } else {
        candidates.set(candidate.url, candidate);
      }
    }
  };

  addAll(harvestCandidates({ url: landing.finalUrl, text: html, label: 'the landing page' }));

  for (const [index, inline] of extractInlineScripts(html).entries()) {
    addAll(
      harvestCandidates({
        url: landing.finalUrl,
        text: inline,
        label: `inline script #${index + 1} on the landing page`,
      }),
    );
  }

  for (const seed of options.seeds ?? []) {
    const detection = classifyUrl(seed);
    candidates.set(seed, {
      url: seed,
      discoveredIn: 'the selected location',
      evidence: ['Supplied as a starting point for this location.', ...detection.evidence],
    });
  }

  // --- 2. JavaScript bundles ----------------------------------------------
  const scriptUrls = extractScriptUrls(html, landing.finalUrl).slice(0, MAX_SCRIPTS);
  if (scriptUrls.length === 0) {
    notes.push('The landing page linked no external scripts; only its own markup was searched.');
  }

  for (const scriptUrl of scriptUrls) {
    if (budget.requestsRemaining <= MAX_PROBES / 2) {
      warnings.push('The request budget was reaching its limit, so not every script bundle was read.');
      break;
    }
    const script = await safeFetch(scriptUrl, {
      budget,
      signal: options.signal,
      accept: 'application/javascript,text/javascript,*/*;q=0.5',
      maxBytes: Math.min(LIMITS.maxResponseBytes, 8 * 1024 * 1024),
    });
    if (!script.ok) continue;
    documentsFetched.push(script.finalUrl);
    addAll(
      harvestCandidates({
        url: script.finalUrl,
        text: asText(script),
        label: `the script ${new URL(script.finalUrl).pathname.split('/').pop() ?? scriptUrl}`,
      }),
    );
  }

  // --- 3. Probe ------------------------------------------------------------
  let endpoints = toEndpoints([...candidates.values()]);

  if (endpoints.length === 0) {
    notes.push(
      'No URL on the page or in its scripts matched a known geospatial service pattern. The map may load ' +
        'its data from an endpoint this build does not recognise, or only after a user interaction that a ' +
        'server-side read cannot reproduce.',
    );
    return finish(endpoints, null, true);
  }

  const probed: DiscoveredEndpoint[] = [];
  for (const [index, endpoint] of endpoints.entries()) {
    if (index >= MAX_PROBES || budget.requestsRemaining <= 2) {
      probed.push(endpoint); // Keep it listed, unprobed and honestly marked so.
      continue;
    }
    probed.push(await probeEndpoint(endpoint, budget, options.signal));
  }
  endpoints = probed;

  // --- 4. Expand style documents and ArcGIS directories --------------------
  const expanded = await expandEndpoints(endpoints, budget, options.signal, documentsFetched);
  endpoints = dedupe([...endpoints, ...expanded]);

  const restricted = endpoints.filter((endpoint) => endpoint.probe?.failureKind === 'auth-required');
  if (restricted.length > 0) {
    warnings.push(
      `${restricted.length} endpoint(s) responded that authorisation is required. Those datasets require ` +
        'authorised access through TownPlanMap and were not read.',
    );
  }

  const vector = endpoints.filter((endpoint) => endpoint.nature === 'vector');
  const raster = endpoints.filter((endpoint) => endpoint.nature === 'raster');

  if (vector.length === 0 && raster.length > 0) {
    warnings.push(
      'Only rendered map imagery was found. KML cannot be generated reliably from imagery, so no export is ' +
        'offered for those layers.',
    );
  }
  if (vector.length > 0) {
    notes.push(`${vector.length} endpoint(s) serve vector geometry and are eligible for KML export.`);
  }

  return finish(endpoints, null, true);
}

function dedupe(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  const byUrl = new Map<string, DiscoveredEndpoint>();
  for (const endpoint of endpoints) {
    const existing = byUrl.get(endpoint.url);
    // Prefer the record that has actually been probed.
    if (!existing || (!existing.probe && endpoint.probe)) byUrl.set(endpoint.url, endpoint);
  }
  return [...byUrl.values()];
}

/**
 * Follow one level of indirection.
 *
 * A map style document names the tile and GeoJSON sources the map draws from,
 * and an ArcGIS services directory names the services under it. Both are
 * signposts rather than data, so following them once turns metadata into real
 * candidates. Only one level is followed, deliberately: this is a targeted
 * expansion, not a crawl.
 */
async function expandEndpoints(
  endpoints: DiscoveredEndpoint[],
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  documentsFetched: string[],
): Promise<DiscoveredEndpoint[]> {
  const discovered: DiscoveredEndpoint[] = [];

  for (const endpoint of endpoints) {
    if (budget.requestsRemaining <= 2) break;

    if (endpoint.kind === 'maplibre-style' && endpoint.probe?.reachable) {
      discovered.push(...(await expandStyle(endpoint, budget, signal, documentsFetched)));
      continue;
    }

    if (endpoint.kind === 'arcgis-rest-root' && endpoint.probe?.reachable) {
      discovered.push(...(await expandArcGisDirectory(endpoint, budget, signal, documentsFetched)));
    }
  }

  return discovered;
}

async function expandStyle(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  documentsFetched: string[],
): Promise<DiscoveredEndpoint[]> {
  const response = await safeFetch(endpoint.url, { budget, signal, accept: 'application/json' });
  if (!response.ok) return [];
  documentsFetched.push(response.finalUrl);

  const style = asJson<{
    sources?: Record<string, { type?: string; url?: string; tiles?: string[]; data?: unknown; attribution?: string }>;
  }>(response);
  if (!style?.sources) return [];

  const out: DiscoveredEndpoint[] = [];
  for (const [name, source] of Object.entries(style.sources)) {
    const urls: string[] = [];
    if (typeof source.url === 'string') urls.push(source.url);
    if (Array.isArray(source.tiles)) urls.push(...source.tiles.filter((tile): tile is string => typeof tile === 'string'));
    if (typeof source.data === 'string') urls.push(source.data);

    for (const raw of urls) {
      let resolved: string;
      try {
        resolved = new URL(raw, response.finalUrl).toString();
      } catch {
        continue;
      }
      const detection = classifyUrl(resolved);
      const nature =
        source.type === 'vector'
          ? 'vector'
          : source.type === 'raster' || source.type === 'raster-dem'
            ? 'raster'
            : source.type === 'geojson'
              ? 'vector'
              : detection.nature;

      out.push({
        id: `ep_style_${hash(resolved)}`,
        url: resolved,
        kind: source.type === 'geojson' ? 'geojson' : detection.kind,
        nature,
        discoveredIn: `the map style document (source "${name}")`,
        evidence: [
          `Listed as source "${name}" of type "${source.type ?? 'unspecified'}" in the map style the site loads.`,
          ...detection.evidence,
        ],
      });
    }
  }
  return out;
}

async function expandArcGisDirectory(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  documentsFetched: string[],
): Promise<DiscoveredEndpoint[]> {
  const url = new URL(endpoint.url);
  url.searchParams.set('f', 'json');
  const response = await safeFetch(url.toString(), { budget, signal, accept: 'application/json' });
  if (!response.ok) return [];
  documentsFetched.push(response.finalUrl);

  const directory = asJson<{ services?: Array<{ name?: string; type?: string }>; folders?: string[] }>(response);
  if (!directory?.services) return [];

  const root = endpoint.url.split('?')[0]?.replace(/\/$/, '') ?? endpoint.url;
  const out: DiscoveredEndpoint[] = [];

  for (const service of directory.services.slice(0, 40)) {
    if (!service.name || !service.type) continue;
    // `name` can carry a folder prefix already; keep only the last segment.
    const leaf = service.name.split('/').pop() ?? service.name;
    const serviceUrl = `${root}/${leaf}/${service.type}`;
    const detection = classifyUrl(serviceUrl);
    out.push({
      id: `ep_arcgis_${hash(serviceUrl)}`,
      url: serviceUrl,
      kind: detection.kind,
      nature: detection.nature,
      discoveredIn: 'the ArcGIS services directory',
      evidence: [`Listed as service "${service.name}" of type ${service.type} in the services directory.`, ...detection.evidence],
    });
  }

  return out;
}
