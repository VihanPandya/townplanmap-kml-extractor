/**
 * The Geospatial Data Discovery Engine.
 *
 * Given the source's base URL it:
 *   1. optionally opens the page in a locally installed browser and records
 *      every request the site's own code makes,
 *   2. reads the landing page,
 *   3. reads the bundled and inline JavaScript that configures the map,
 *   4. harvests every URL that could plausibly serve geographic data,
 *   5. probes the best candidates to learn what each one really is,
 *   6. expands map style documents, TileJSON, configuration payloads and
 *      ArcGIS service directories,
 *   7. reports what was found and — just as importantly — what was not, with
 *      enough detail to act on when the answer is "nothing".
 *
 * Fetched JavaScript is only ever read as text by the server-side passes.
 * Nothing discovered here is executed by this process, and every request this
 * process makes goes through the SSRF-guarded fetcher under a shared budget.
 * Step 1 is the exception by design: there the *site's* code runs inside a
 * real browser, under the same address restrictions, purely to be watched.
 */

import { BROWSER, LIMITS, SOURCE } from '@/lib/config';
import { RequestBudget } from '@/lib/net/budget';
import { safeFetch, asText, asJson } from '@/lib/net/safe-fetch';
import { classifyUrl } from '@/lib/geo/detect';
import {
  candidatesFromObservations,
  extractInlineScripts,
  extractScriptUrls,
  harvestCandidates,
  hash,
  looksLikeConfigDocument,
  toEndpoints,
  type Candidate,
} from './harvest';
import { observeInBrowser, worthPursuing, type CapturedBody } from './browser';
import { CAPTURED_SOURCE, capturedEndpointId } from './captured';
import { probeEndpoint } from './probe';
import type {
  BrowserDiagnostics,
  DiscoveredEndpoint,
  RejectedCandidate,
  ScanDiagnostics,
  ScanDocument,
  ScanResult,
} from './types';

export type ScanOptions = {
  baseUrl?: string;
  signal?: AbortSignal;
  budget?: RequestBudget;
  /** Extra URLs the caller already knows about, or supplied by hand. */
  seeds?: string[];
  /** Watch the site in a locally installed browser. Defaults to the setting. */
  useBrowser?: boolean;
  /** Override how long the browser listens after the page loads. */
  browserSettleMs?: number;
  /**
   * Open a visible window and keep recording until it is closed. The way to
   * reach data a map loads only in response to a person using it — including
   * after they have signed themselves in.
   */
  browserHeaded?: boolean;
  /**
   * Called with each geographic response the browser kept whole, so the caller
   * can store it. Bytes never travel inside the scan result, which is
   * persisted as JSON.
   */
  onCaptured?: (captured: CapturedBody) => Promise<void> | void;
};

export async function runDiscoveryScan(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const baseUrl = options.baseUrl ?? SOURCE.baseUrl;
  const budget = options.budget ?? new RequestBudget();
  const notes: string[] = [];
  const warnings: string[] = [];
  const documentsFetched: string[] = [];
  const seeds = [...new Set(options.seeds ?? [])];

  const documents: ScanDocument[] = [];
  const rejected: RejectedCandidate[] = [];
  const rejectedSeen = new Set<string>();

  const noteRejection = (rejection: RejectedCandidate) => {
    if (rejected.length >= LIMITS.maxDiagnosticEntries) return;
    if (rejectedSeen.has(rejection.url)) return;
    rejectedSeen.add(rejection.url);
    rejected.push(rejection);
  };

  const recordDocument = (document: ScanDocument) => {
    if (documents.length >= LIMITS.maxDiagnosticEntries) return;
    documents.push(document);
    if (document.ok) documentsFetched.push(document.url);
  };

  const useBrowser = options.useBrowser ?? BROWSER.enabledByDefault;
  let browserDiagnostics: BrowserDiagnostics | null = useBrowser
    ? { attempted: true, used: false, executablePath: null, requestsObserved: 0, requestsBlocked: 0, observed: [] }
    : null;

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

  let scriptsSeen = 0;
  let scriptsRead = 0;
  let candidatesProbed = 0;
  const capturedEndpoints: DiscoveredEndpoint[] = [];

  const finish = (
    endpoints: DiscoveredEndpoint[],
    failure: ScanResult['failure'],
    connected: boolean,
  ): ScanResult => {
    const diagnostics: ScanDiagnostics = {
      mode: browserDiagnostics?.used ? 'browser' : 'text',
      documents,
      scriptsSeen,
      scriptsRead,
      candidatesHarvested: candidates.size,
      candidatesProbed,
      rejected,
      seeds,
      browser: browserDiagnostics,
      advice: [],
    };
    diagnostics.advice = buildAdvice({ endpoints, diagnostics, failure, baseUrl });

    return {
      id: `scan_${hash(`${baseUrl}:${startedAt}`)}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      connected,
      mapInterfaceDetected: endpoints.some((endpoint) =>
        [
          'maplibre-style',
          'tilejson',
          'vector-tiles',
          'raster-tiles',
          'ogc-wms',
          'ogc-wmts',
          'arcgis-map-server',
        ].includes(endpoint.kind),
      ),
      geographicLayersDetected: endpoints.some((endpoint) => endpoint.nature === 'vector'),
      endpoints,
      documentsFetched,
      requestsSpent: budget.requestsSpent,
      bytesDownloaded: budget.bytesDownloaded,
      notes,
      warnings,
      failure,
      diagnostics,
    };
  };

  // --- 1. Watch the site in a browser -------------------------------------
  //
  // Done first, because it is the pass most likely to succeed on an
  // application that builds its data URLs at runtime — and because its result
  // is still worth having if the plain server-side read is refused.
  if (useBrowser) {
    const observation = await observeInBrowser({
      url: baseUrl,
      signal: options.signal,
      settleMs: options.browserSettleMs,
      ...(options.browserHeaded === undefined ? {} : { headless: !options.browserHeaded }),
    });

    if (observation.ok) {
      const pursued = observation.requests.filter(worthPursuing);
      browserDiagnostics = {
        attempted: true,
        used: true,
        executablePath: observation.executablePath,
        requestsObserved: observation.requests.length,
        requestsBlocked: observation.blockedCount,
        observed: observation.requests.slice(0, LIMITS.maxDiagnosticEntries),
      };
      for (const line of observation.notes) notes.push(line);
      notes.push(
        `A browser visit recorded ${observation.requests.length} request(s) the site made for itself; ` +
          `${pursued.length} of them were carried forward as candidates.`,
      );
      addAll(candidatesFromObservations(pursued, { onReject: noteRejection }));

      // Geometry the browser kept is already in hand, so it becomes an endpoint
      // outright: nothing needs to be asked of the source a second time, and a
      // response returned to a signed-in session cannot be asked for again from
      // a context that was never signed in.
      for (const body of observation.captured ?? []) {
        if (options.onCaptured) await options.onCaptured(body);
        capturedEndpoints.push({
          id: capturedEndpointId(body.url),
          url: body.url,
          kind: body.kind,
          nature: 'vector',
          discoveredIn: CAPTURED_SOURCE,
          bodyVerified: true,
          evidence: [
            body.carriedSession
              ? 'The site returned this to your own signed-in session while the window was open, and the ' +
                'response was kept. Nothing that authenticated that session was stored or reused.'
              : 'The site returned this to your browser while the window was open, and the response was kept.',
            `Read as ${body.kind} from the bytes themselves.`,
          ],
          probe: {
            reachable: true,
            status: 200,
            contentType: body.contentType,
            bytes: body.bytes.byteLength,
            detail: { capturedBytes: body.bytes.byteLength },
          },
        });
      }
      if (capturedEndpoints.length > 0) {
        notes.push(
          `${capturedEndpoints.length} geographic response(s) were captured whole and can be read without ` +
            'asking the source again.',
        );
      }
      for (const skipped of observation.requests.filter((request) => !worthPursuing(request))) {
        noteRejection({
          url: skipped.url,
          reason: skipped.blockedReason
            ? `Stopped by this tool’s safety rules: ${skipped.blockedReason}`
            : skipped.failureReason
              ? `The request failed on the network: ${skipped.failureReason}`
              : `Observed as a ${skipped.resourceType} request; not a data resource.`,
        });
      }
    } else {
      browserDiagnostics = {
        attempted: true,
        used: false,
        executablePath: null,
        requestsObserved: 0,
        requestsBlocked: 0,
        reason: observation.reason,
        hint: observation.hint,
        observed: [],
      };
      warnings.push(`Browser-assisted discovery was requested but could not run: ${observation.reason}`);
    }
  }

  // --- 2. Landing page -----------------------------------------------------
  const landing = await safeFetch(baseUrl, {
    budget,
    signal: options.signal,
    accept: 'text/html,application/xhtml+xml',
  });

  if (!landing.ok) {
    recordDocument({
      url: baseUrl,
      role: 'landing',
      status: landing.status,
      bytes: null,
      ok: false,
      reason: landing.reason,
    });

    // A browser visit that worked is enough to carry on with, even when the
    // plain server-side read was refused. Otherwise there is nothing to go on.
    if (candidates.size === 0) {
      // Report what actually happened. A refusal on the landing page is not the
      // same thing as a restricted dataset, so the fetcher's factual reason is
      // passed through rather than being relabelled.
      return finish([], { kind: landing.kind, reason: landing.reason }, false);
    }
    warnings.push(
      `A direct read of ${baseUrl} was refused (${landing.reason}), so only what the browser observed was used.`,
    );
  }

  if (landing.ok) {
    recordDocument({
      url: landing.finalUrl,
      role: 'landing',
      status: landing.status,
      bytes: landing.bytes,
      ok: true,
    });

    const html = asText(landing);
    addAll(
      harvestCandidates({ url: landing.finalUrl, text: html, label: 'the landing page' }, { onReject: noteRejection }),
    );

    for (const [index, inline] of extractInlineScripts(html).entries()) {
      addAll(
        harvestCandidates(
          { url: landing.finalUrl, text: inline, label: `inline script #${index + 1} on the landing page` },
          { onReject: noteRejection },
        ),
      );
    }

    // --- 3. JavaScript bundles ---------------------------------------------
    const allScripts = extractScriptUrls(html, landing.finalUrl);
    scriptsSeen = allScripts.length;
    const scriptUrls = allScripts.slice(0, LIMITS.maxScriptsRead);
    if (allScripts.length > scriptUrls.length) {
      notes.push(
        `The page links ${allScripts.length} scripts; the first ${scriptUrls.length} were read. ` +
          'Raise TPM_MAX_SCRIPTS_READ to read more.',
      );
    }
    if (scriptUrls.length === 0) {
      notes.push('The landing page linked no external scripts; only its own markup was searched.');
    }

    for (const scriptUrl of scriptUrls) {
      if (budget.requestsRemaining <= LIMITS.maxProbes / 2) {
        warnings.push('The request budget was reaching its limit, so not every script bundle was read.');
        break;
      }
      const script = await safeFetch(scriptUrl, {
        budget,
        signal: options.signal,
        accept: 'application/javascript,text/javascript,*/*;q=0.5',
        maxBytes: Math.min(LIMITS.maxResponseBytes, 8 * 1024 * 1024),
      });
      if (!script.ok) {
        recordDocument({ url: scriptUrl, role: 'script', status: script.status, bytes: null, ok: false, reason: script.reason });
        continue;
      }
      scriptsRead += 1;
      recordDocument({ url: script.finalUrl, role: 'script', status: script.status, bytes: script.bytes, ok: true });
      addAll(
        harvestCandidates(
          {
            url: script.finalUrl,
            text: asText(script),
            label: `the script ${new URL(script.finalUrl).pathname.split('/').pop() ?? scriptUrl}`,
          },
          { onReject: noteRejection },
        ),
      );
    }
  }

  // --- 4. Seeds supplied by the caller ------------------------------------
  for (const seed of seeds) {
    const detection = classifyUrl(seed);
    candidates.set(seed, {
      url: seed,
      discoveredIn: 'supplied by hand',
      evidence: ['Entered directly rather than discovered.', ...detection.evidence],
    });
  }

  // --- 5. Probe ------------------------------------------------------------
  let endpoints = dedupe([...capturedEndpoints, ...toEndpoints([...candidates.values()])]);

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
    // Captured geometry arrives already read. Spending a request to ask the
    // source for it again would learn nothing and, for data returned to a
    // signed-in session, would be asking from a context with no standing.
    if (endpoint.probe) {
      probed.push(endpoint);
      continue;
    }
    if (index >= LIMITS.maxProbes || budget.requestsRemaining <= 2) {
      probed.push(endpoint); // Keep it listed, unprobed and honestly marked so.
      continue;
    }
    const result = keepBodyVerdict(endpoint, await probeEndpoint(endpoint, budget, options.signal));
    candidatesProbed += 1;
    recordDocument({
      url: endpoint.url,
      role: 'probe',
      status: result.probe?.status ?? null,
      bytes: result.probe?.bytes ?? null,
      ok: result.probe?.reachable ?? false,
      ...(result.probe?.failureReason ? { reason: result.probe.failureReason } : {}),
    });
    if (result.probe && !result.probe.reachable && result.probe.failureKind !== 'template') {
      noteRejection({
        url: endpoint.url,
        reason: `Probed and refused: ${result.probe.failureReason ?? 'no reason given'}`,
      });
    }
    probed.push(result);
  }
  endpoints = probed;

  // --- 6. Expand signposts into data -------------------------------------
  const expanded = await expandEndpoints(endpoints, budget, options.signal, recordDocument);
  if (expanded.length > 0) {
    notes.push(`${expanded.length} further endpoint(s) were named by style, catalog or configuration documents.`);
  }
  endpoints = dedupe([...endpoints, ...expanded]);

  // Anything new and promising deserves a probe of its own; an expanded
  // endpoint is only a name until something reads it.
  const secondRound: DiscoveredEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.probe || budget.requestsRemaining <= 2 || candidatesProbed >= LIMITS.maxProbes * 2) {
      secondRound.push(endpoint);
      continue;
    }
    if (endpoint.nature === 'raster' || endpoint.kind === 'unknown') {
      secondRound.push(endpoint);
      continue;
    }
    const result = keepBodyVerdict(endpoint, await probeEndpoint(endpoint, budget, options.signal));
    candidatesProbed += 1;
    recordDocument({
      url: endpoint.url,
      role: 'probe',
      status: result.probe?.status ?? null,
      bytes: result.probe?.bytes ?? null,
      ok: result.probe?.reachable ?? false,
      ...(result.probe?.failureReason ? { reason: result.probe.failureReason } : {}),
    });
    secondRound.push(result);
  }
  endpoints = secondRound;

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

/**
 * Turn an empty or thin result into something the person looking at it can act
 * on. Each line names a concrete next step rather than restating the outcome.
 */
function buildAdvice(input: {
  endpoints: DiscoveredEndpoint[];
  diagnostics: ScanDiagnostics;
  failure: ScanResult['failure'];
  baseUrl: string;
}): string[] {
  const { endpoints, diagnostics, failure, baseUrl } = input;
  const advice: string[] = [];
  const vector = endpoints.filter((endpoint) => endpoint.nature === 'vector').length;
  const browser = diagnostics.browser;

  if (failure) {
    advice.push(
      `Nothing could be read from ${baseUrl}: ${failure.reason} Check that the address is right and that this ` +
        'machine can reach it — a proxy or firewall between the two will produce exactly this result.',
    );
    return advice;
  }

  if (browser?.attempted && !browser.used) {
    advice.push(
      `The browser pass could not run: ${browser.reason ?? 'no reason given'} ${browser.hint ?? ''}`.trim(),
    );
  }

  if (vector === 0) {
    if (!browser?.used) {
      advice.push(
        'Run the scan again with “Watch the site in a browser” switched on. Most map applications build their ' +
          'data URLs while they run, so those URLs never appear in the page source a plain read can see. ' +
          'Watching the site load is the only way to catch them.',
      );
    } else {
      const read = browser.observed.filter((request) => request.detected).length;
      const kinds = [
        ...new Set(
          browser.observed
            .map((request) => request.detected?.kind)
            .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind) && kind !== 'unknown'),
        ),
      ];
      advice.push(
        `The browser watched the site make ${browser.requestsObserved} request(s) and read ${read} of the ` +
          `responses. None of them carried vector geometry${
            kinds.length > 0 ? `; what they did carry was: ${kinds.join(', ')}` : ''
          }. Give the page longer to settle (raise TPM_BROWSER_SETTLE_MS), and pan or zoom the map once the ` +
          'window opens — with TPM_BROWSER_HEADED=1 you can watch it and interact with it while it records.',
      );
    }

    advice.push(
      `Find the data URL yourself: open ${baseUrl} in your browser, press F12, choose the Network tab, tick ` +
        '“Fetch/XHR”, reload the page and click around the map. Any row that returns map data — GeoJSON, an ' +
        'ArcGIS query, a WFS response — is the URL to paste into “Add an endpoint” on the dashboard.',
    );
  }

  if (diagnostics.candidatesHarvested > 0 && diagnostics.candidatesProbed === 0) {
    advice.push(
      'Candidates were found but none could be probed, which normally means the request budget ran out. ' +
        'Raise TPM_MAX_REQUESTS_PER_SCAN and scan again.',
    );
  }

  const authRefused = endpoints.filter((endpoint) => endpoint.probe?.failureKind === 'auth-required').length;
  if (authRefused > 0) {
    advice.push(
      `${authRefused} endpoint(s) answered that authorisation is required. This dataset requires authorised ` +
        'access through TownPlanMap; the tool will not try to work around that.',
    );
  }

  if (vector > 0) {
    advice.push(`${vector} endpoint(s) serve vector geometry. Open Map Layers to enumerate what they hold.`);
  }

  return advice;
}

/**
 * A probe never overturns a verdict already reached from real bytes.
 *
 * An endpoint the browser watched the site fetch, and whose response the
 * browser read, is known data. A server-side probe of the same URL can answer
 * differently — an application shell, a redirect to a sign-in page, an error
 * document — because it arrives without the context the site's own request
 * had. That tells us something useful about whether the endpoint can be read
 * from here, and nothing at all about what it serves. Both facts are kept, and
 * neither is allowed to erase the other.
 */
function keepBodyVerdict(before: DiscoveredEndpoint, after: DiscoveredEndpoint): DiscoveredEndpoint {
  if (!before.bodyVerified || after.nature === before.nature) return after;

  return {
    ...after,
    kind: before.kind,
    nature: before.nature,
    bodyVerified: true,
    evidence: [
      ...after.evidence,
      `A direct read of this URL from the server answered differently (${after.nature}). The classification ` +
        'above stands: it came from the bytes the site itself received. The difference is recorded because it ' +
        'may mean this endpoint cannot be read from here without the context the site\u2019s own request had.',
    ],
  };
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

type RecordDocument = (document: ScanDocument) => void;

/**
 * Follow the signposts.
 *
 * A map style document names the tile and GeoJSON sources the map draws from,
 * a TileJSON names its tiles, an ArcGIS services directory names the services
 * and folders under it, and an application's configuration payload names all
 * of the above. None of them are data; all of them say where the data is.
 */
async function expandEndpoints(
  endpoints: DiscoveredEndpoint[],
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  recordDocument: RecordDocument,
): Promise<DiscoveredEndpoint[]> {
  const discovered: DiscoveredEndpoint[] = [];
  let configsRead = 0;

  for (const endpoint of endpoints) {
    if (budget.requestsRemaining <= 2) break;

    if (!endpoint.probe?.reachable) continue;

    // A JSON payload that is not itself geographic data, but is shaped like an
    // application's configuration, is worth reading for the URLs inside it.
    // Checked first: a configuration document and a service catalog can look
    // alike from the outside, and the configuration reading is the general one.
    const isJson = (endpoint.probe.contentType ?? '').includes('json');
    if (
      isJson &&
      endpoint.nature !== 'vector' &&
      looksLikeConfigDocument(endpoint.url) &&
      configsRead < LIMITS.maxConfigDocuments
    ) {
      configsRead += 1;
      discovered.push(...(await expandConfigDocument(endpoint, budget, signal, recordDocument)));
      continue;
    }

    if (endpoint.kind === 'maplibre-style' || endpoint.kind === 'tilejson') {
      discovered.push(...(await expandStyle(endpoint, budget, signal, recordDocument)));
      continue;
    }

    if (endpoint.kind === 'arcgis-rest-root') {
      discovered.push(...(await expandArcGisDirectory(endpoint, budget, signal, recordDocument)));
    }
  }

  return discovered;
}

async function expandStyle(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  recordDocument: RecordDocument,
): Promise<DiscoveredEndpoint[]> {
  const response = await safeFetch(endpoint.url, { budget, signal, accept: 'application/json' });
  if (!response.ok) {
    recordDocument({ url: endpoint.url, role: 'style', status: response.status, bytes: null, ok: false, reason: response.reason });
    return [];
  }
  recordDocument({ url: response.finalUrl, role: 'style', status: response.status, bytes: response.bytes, ok: true });

  const style = asJson<{
    sources?: Record<string, { type?: string; url?: string; tiles?: string[]; data?: unknown; attribution?: string }>;
    tiles?: string[];
  }>(response);
  if (!style) return [];

  const out: DiscoveredEndpoint[] = [];

  const push = (raw: string, described: string, natureHint: DiscoveredEndpoint['nature'] | null) => {
    let resolved: string;
    try {
      resolved = new URL(raw, response.finalUrl).toString();
    } catch {
      return;
    }
    const detection = classifyUrl(resolved);
    out.push({
      id: `ep_style_${hash(resolved)}`,
      url: resolved,
      kind: detection.kind,
      nature: natureHint ?? detection.nature,
      discoveredIn: `the map style document (${described})`,
      evidence: [`Named by the map style the site loads: ${described}.`, ...detection.evidence],
    });
  };

  // A TileJSON names its own tiles at the top level.
  for (const tile of style.tiles ?? []) {
    if (typeof tile === 'string') push(tile, 'top-level tile template', null);
  }

  for (const [name, source] of Object.entries(style.sources ?? {})) {
    const nature =
      source.type === 'vector' || source.type === 'geojson'
        ? 'vector'
        : source.type === 'raster' || source.type === 'raster-dem'
          ? 'raster'
          : null;

    const urls: string[] = [];
    if (typeof source.url === 'string') urls.push(source.url);
    if (Array.isArray(source.tiles)) {
      urls.push(...source.tiles.filter((tile): tile is string => typeof tile === 'string'));
    }
    if (typeof source.data === 'string') urls.push(source.data);

    for (const raw of urls) {
      const before = out.length;
      push(raw, `source "${name}" of type "${source.type ?? 'unspecified'}"`, nature);
      const added = out[before];
      if (added && source.type === 'geojson') added.kind = 'geojson';
    }
  }

  return out;
}

async function expandArcGisDirectory(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  recordDocument: RecordDocument,
): Promise<DiscoveredEndpoint[]> {
  const out: DiscoveredEndpoint[] = [];
  const root = endpoint.url.split('?')[0]?.replace(/\/$/, '') ?? endpoint.url;

  const read = async (directoryUrl: string): Promise<{ services: Array<{ name?: string; type?: string }>; folders: string[] }> => {
    const url = new URL(directoryUrl);
    url.searchParams.set('f', 'json');
    const response = await safeFetch(url.toString(), { budget, signal, accept: 'application/json' });
    if (!response.ok) {
      recordDocument({
        url: directoryUrl,
        role: 'service-directory',
        status: response.status,
        bytes: null,
        ok: false,
        reason: response.reason,
      });
      return { services: [], folders: [] };
    }
    recordDocument({
      url: response.finalUrl,
      role: 'service-directory',
      status: response.status,
      bytes: response.bytes,
      ok: true,
    });
    const directory = asJson<{ services?: Array<{ name?: string; type?: string }>; folders?: string[] }>(response);
    return {
      services: directory?.services ?? [],
      folders: (directory?.folders ?? []).filter((folder): folder is string => typeof folder === 'string'),
    };
  };

  const collect = (services: Array<{ name?: string; type?: string }>, directoryRoot: string, where: string) => {
    for (const service of services.slice(0, 60)) {
      if (!service.name || !service.type) continue;
      // `name` can carry a folder prefix already; keep only the last segment.
      const leaf = service.name.split('/').pop() ?? service.name;
      const serviceUrl = `${directoryRoot}/${leaf}/${service.type}`;
      const detection = classifyUrl(serviceUrl);
      out.push({
        id: `ep_arcgis_${hash(serviceUrl)}`,
        url: serviceUrl,
        kind: detection.kind,
        nature: detection.nature,
        discoveredIn: where,
        evidence: [`Listed as service "${service.name}" of type ${service.type} in ${where}.`, ...detection.evidence],
      });
    }
  };

  const top = await read(root);
  collect(top.services, root, 'the ArcGIS services directory');

  // A tidy ArcGIS deployment keeps everything in folders, so the root lists no
  // services at all. One level of folders is read; deeper nesting is rare.
  for (const folder of top.folders.slice(0, 12)) {
    if (budget.requestsRemaining <= 2) break;
    const folderRoot = `${root}/${folder}`;
    const nested = await read(folderRoot);
    collect(nested.services, folderRoot, `the ArcGIS services folder "${folder}"`);
  }

  return out;
}

/**
 * Read an application configuration payload for the URLs it names.
 *
 * This is text harvesting again, applied to JSON rather than to a bundle: a
 * configuration document is exactly where an SPA keeps the service addresses
 * it will later assemble into requests.
 */
async function expandConfigDocument(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal: AbortSignal | undefined,
  recordDocument: RecordDocument,
): Promise<DiscoveredEndpoint[]> {
  const response = await safeFetch(endpoint.url, {
    budget,
    signal,
    accept: 'application/json',
    maxBytes: Math.min(LIMITS.maxResponseBytes, 4 * 1024 * 1024),
  });
  if (!response.ok) {
    recordDocument({ url: endpoint.url, role: 'config', status: response.status, bytes: null, ok: false, reason: response.reason });
    return [];
  }
  recordDocument({ url: response.finalUrl, role: 'config', status: response.status, bytes: response.bytes, ok: true });

  const harvested = harvestCandidates({
    url: response.finalUrl,
    text: asText(response),
    label: `the configuration document ${new URL(response.finalUrl).pathname}`,
  });

  return toEndpoints(harvested).map((found) => ({
    ...found,
    id: `ep_config_${hash(found.url)}`,
    discoveredIn: 'an application configuration document',
  }));
}
