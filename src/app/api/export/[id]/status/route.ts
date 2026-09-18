/** GET /api/export/:id/status — progress and validation for an export job. */

import { getJob } from '@/lib/exports/manager';
import { formatBytes } from '@/lib/kml/validate';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const job = await getJob(id);
  if (!job) return fail(404, 'Unknown export.');

  return ok({
    exportId: job.id,
    status: job.status,
    label: job.label,
    format: job.format,
    progress: job.progress,
    featureCount: job.featureCount,
    skipped: job.skipped.slice(0, 200),
    skippedCount: job.skipped.length,
    validation: job.validation,
    notes: job.notes,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    artifact: job.artifact
      ? {
          filename: job.artifact.filename,
          bytes: job.artifact.bytes,
          size: formatBytes(job.artifact.bytes),
          contentType: job.artifact.contentType,
        }
      : null,
    downloadUrl: job.status === 'complete' ? `/api/export/${job.id}/download` : null,
  });
});
