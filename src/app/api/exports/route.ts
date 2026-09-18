/** GET /api/exports — export history. */

import { listJobs } from '@/lib/exports/manager';
import { formatBytes } from '@/lib/kml/validate';
import { handler, intParam, ok, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request) => {
  const limit = intParam(searchParams(request), 'limit', 50, 200);
  const jobs = await listJobs(limit);

  return ok({
    exports: jobs.map((job) => ({
      exportId: job.id,
      label: job.label,
      status: job.status,
      format: job.format,
      featureCount: job.featureCount,
      skippedCount: job.skipped.length,
      valid: job.validation?.valid ?? null,
      size: job.artifact ? formatBytes(job.artifact.bytes) : null,
      filename: job.artifact?.filename ?? null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      downloadUrl: job.status === 'complete' ? `/api/export/${job.id}/download` : null,
    })),
  });
});
