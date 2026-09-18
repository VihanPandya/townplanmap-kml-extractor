/**
 * POST /api/connect — run a discovery scan against the source.
 *
 * This is the only route that initiates a full crawl of the landing page and
 * its scripts, so it carries the scan's whole request budget.
 */

import { connect } from '@/lib/catalog';
import { getStore } from '@/lib/db';
import { LIMITS, SOURCE } from '@/lib/config';
import { fail, handler, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = handler(async (request) => {
  const result = await connect(request.signal);

  if (!result.scan.connected) {
    const failure = result.scan.failure;
    const detail =
      failure?.kind === 'auth-required'
        ? `${failure.reason} This can mean the site itself refused the request, or that something on the network ` +
          'path between this server and the site did. No attempt was made to work around it.'
        : failure?.kind === 'blocked'
          ? `The request was refused by this tool\u2019s own safety rules: ${failure.reason}`
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
    storage: { kind: result.storeKind, durable: result.storeDurable },
    limits: LIMITS,
  });
});

/** GET returns the last scan without spending any upstream requests. */
export const GET = handler(async () => {
  const store = await getStore();
  const scan = await store.getLatestScan();
  if (!scan) {
    return ok({ connected: false, scan: null, storage: { kind: store.kind, durable: store.durable } });
  }
  return ok({
    connected: scan.connected,
    sourceReachable: scan.failure === null,
    scan,
    storage: { kind: store.kind, durable: store.durable },
  });
});
