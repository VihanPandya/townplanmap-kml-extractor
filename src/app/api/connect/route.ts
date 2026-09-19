/**
 * POST /api/connect — run a discovery scan against the source.
 *
 * This is the only route that initiates a full crawl of the landing page and
 * its scripts, so it carries the scan's whole request budget. The body is
 * optional; it lets the caller widen the scan without changing any setting:
 *
 *   { "useBrowser": true }          watch the site load in a real browser
 *   { "extraUrls": ["https://…"] }  probe a URL the caller already knows
 */

import { connect } from '@/lib/catalog';
import { getStore } from '@/lib/db';
import { BROWSER, LIMITS, SOURCE } from '@/lib/config';
import { fail, handler, ok, readJson } from '@/lib/api';
import { assertSafeUrl } from '@/lib/net/ssrf';
import { findBrowser } from '@/lib/discovery/browser';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const connectSchema = z
  .object({
    useBrowser: z.boolean().optional(),
    browserHeaded: z.boolean().optional(),
    browserSettleMs: z.number().int().positive().max(1_800_000).optional(),
    extraUrls: z.array(z.string().min(1).max(2_000)).max(50).optional(),
  })
  .default({});

export const POST = handler(async (request) => {
  // An empty body is the common case, so a missing or unparseable one is
  // treated as "no options" rather than as an error.
  let options: z.infer<typeof connectSchema> = {};
  const contentLength = request.headers.get('content-length');
  if (contentLength && contentLength !== '0') {
    const parsed = await readJson(request, connectSchema);
    if (!parsed.ok) return parsed.response;
    options = parsed.data;
  }

  // Every URL supplied by hand is validated before it can reach the scan, so a
  // typed-in address cannot be used to reach inside this machine's network.
  const seeds: string[] = [];
  const rejectedSeeds: Array<{ url: string; reason: string }> = [];
  for (const candidate of options.extraUrls ?? []) {
    const verdict = await assertSafeUrl(candidate.trim());
    if (verdict.ok) seeds.push(verdict.url.toString());
    else rejectedSeeds.push({ url: candidate, reason: verdict.reason });
  }

  const result = await connect({
    signal: request.signal,
    ...(seeds.length > 0 ? { seeds } : {}),
    ...(options.useBrowser === undefined ? {} : { useBrowser: options.useBrowser }),
    ...(options.browserSettleMs === undefined ? {} : { browserSettleMs: options.browserSettleMs }),
    ...(options.browserHeaded === undefined ? {} : { browserHeaded: options.browserHeaded }),
  });

  if (!result.scan.connected) {
    const failure = result.scan.failure;
    const detail =
      failure?.kind === 'auth-required'
        ? `${failure.reason} This can mean the site itself refused the request, or that something on the network ` +
          'path between this server and the site did. No attempt was made to work around it.'
        : failure?.kind === 'blocked'
          ? `The request was refused by this tool’s own safety rules: ${failure.reason}`
          : (failure?.reason ?? 'Please check the website availability or try again later.');

    return fail(502, `Unable to connect to ${SOURCE.name}.`, detail);
  }

  return ok({
    connected: true,
    // `connected` can be true while the source itself was unreachable, when the
    // synthetic sample dataset is standing in for it. Keep the two distinct so
    // the interface never claims a connection it does not have.
    sourceReachable: result.scan.failure === null,
    scanId: result.scan.id,
    mapInterfaceDetected: result.scan.mapInterfaceDetected,
    geographicLayersDetected: result.scan.geographicLayersDetected,
    endpointCount: result.scan.endpoints.length,
    vectorEndpointCount: result.layerCandidates,
    rasterEndpointCount: result.scan.endpoints.filter((endpoint) => endpoint.nature === 'raster').length,
    cities: result.cities,
    documentsFetched: result.scan.documentsFetched,
    requestsSpent: result.scan.requestsSpent,
    bytesDownloaded: result.scan.bytesDownloaded,
    notes: result.scan.notes,
    warnings: result.scan.warnings,
    endpoints: result.scan.endpoints,
    diagnostics: result.scan.diagnostics ?? null,
    rejectedSeeds,
    storage: { kind: result.storeKind, durable: result.storeDurable },
    limits: LIMITS,
  });
});

/** GET returns the last scan without spending any upstream requests. */
export const GET = handler(async () => {
  const store = await getStore();
  const scan = await store.getLatestScan();
  const browserAvailable = findBrowser() !== null;

  if (!scan) {
    return ok({
      connected: false,
      scan: null,
      browser: { available: browserAvailable, defaultOn: BROWSER.enabledByDefault },
      storage: { kind: store.kind, durable: store.durable },
    });
  }
  return ok({
    connected: scan.connected,
    sourceReachable: scan.failure === null,
    scan,
    browser: { available: browserAvailable, defaultOn: BROWSER.enabledByDefault },
    storage: { kind: store.kind, durable: store.durable },
  });
});
