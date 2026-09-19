/**
 * POST /api/preserve — sweep the source for original KML/KMZ files and keep them.
 *
 * Preserves what the source serves to an ordinary unauthenticated request,
 * following references the visible interface never surfaces. A 401 or 403 is
 * recorded as a refusal, never worked around.
 */

import { z } from 'zod';
import { preserveSourceFiles } from '@/lib/catalog';
import { LIMITS } from '@/lib/config';
import { summariseRoutes, unexposedFiles, ROUTE_LABELS } from '@/lib/preservation/types';
import { handler, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z
  .object({
    /** Extra URLs to try, beyond what the last scan discovered. */
    urls: z.array(z.string().url().max(2048)).max(100).optional(),
  })
  .optional();

export const POST = handler(async (request) => {
  const parsed = await readJson(request, schema);
  // An empty body is a valid request: sweep whatever the last scan found.
  const extraUrls = parsed.ok ? (parsed.data?.urls ?? []) : [];

  const sweep = await preserveSourceFiles({ signal: request.signal, extraUrls });
  const unexposed = unexposedFiles(sweep.preserved);

  return ok({
    sweepId: sweep.id,
    startedAt: sweep.startedAt,
    finishedAt: sweep.finishedAt,
    candidates: sweep.candidates,
    preservedCount: sweep.preserved.length,
    preserved: sweep.preserved,
    /** Files that exist but are not offered anywhere in the visible interface. */
    unexposedCount: unexposed.length,
    routes: summariseRoutes(sweep.preserved).map((entry) => ({
      route: entry.route,
      label: ROUTE_LABELS[entry.route],
      count: entry.count,
    })),
    failures: sweep.failures,
    requestsSpent: sweep.requestsSpent,
    bytesDownloaded: sweep.bytesDownloaded,
    notes: sweep.notes,
    warnings: sweep.warnings,
    limits: {
      maxPreservedFiles: LIMITS.maxPreservedFiles,
      maxPreservedFileBytes: LIMITS.maxPreservedFileBytes,
      maxNetworkLinkDepth: LIMITS.maxNetworkLinkDepth,
      maxRequestsPerSweep: LIMITS.maxRequestsPerSweep,
    },
  });
});
