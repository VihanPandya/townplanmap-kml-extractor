/**
 * GET /api/diagnostics — what the last scan actually saw.
 *
 * A scan that finds nothing is only useful if it can say why. This route
 * returns the whole record: every document fetched and its status, every URL
 * harvested and rejected with the reason, every request a browser watched the
 * site make, and the next steps that follow from all of it.
 *
 * It spends no upstream requests; it reads the stored scan.
 */

import { getStore } from '@/lib/db';
import { BROWSER, LIMITS, SOURCE } from '@/lib/config';
import { handler, ok } from '@/lib/api';
import { findBrowser } from '@/lib/discovery/browser';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = await getStore();
  const scan = await store.getLatestScan();
  const executablePath = findBrowser();

  const environment = {
    baseUrl: SOURCE.baseUrl,
    browserAvailable: executablePath !== null,
    browserExecutablePath: executablePath,
    browserDefaultOn: BROWSER.enabledByDefault,
    browserSettleMs: BROWSER.settleMs,
    maxScriptsRead: LIMITS.maxScriptsRead,
    maxProbes: LIMITS.maxProbes,
    maxRequestsPerScan: LIMITS.maxRequestsPerScan,
  };

  if (!scan) {
    return ok({
      scan: null,
      diagnostics: null,
      environment,
      note: 'No discovery scan has been run yet. Connect to the source first.',
    });
  }

  return ok({
    scan: {
      id: scan.id,
      baseUrl: scan.baseUrl,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      connected: scan.connected,
      failure: scan.failure,
      requestsSpent: scan.requestsSpent,
      bytesDownloaded: scan.bytesDownloaded,
      mapInterfaceDetected: scan.mapInterfaceDetected,
      geographicLayersDetected: scan.geographicLayersDetected,
      notes: scan.notes,
      warnings: scan.warnings,
      endpoints: scan.endpoints,
    },
    diagnostics: scan.diagnostics ?? null,
    environment,
    ...(scan.diagnostics
      ? {}
      : { note: 'This scan was recorded before diagnostics existed. Re-scan the source to collect them.' }),
  });
});
