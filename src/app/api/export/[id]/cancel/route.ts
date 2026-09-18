/** POST /api/export/:id/cancel — stop a running export. */

import { cancelJob, getJob } from '@/lib/exports/manager';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const job = await getJob(id);
  if (!job) return fail(404, 'Unknown export.');

  const cancelled = await cancelJob(id);
  return ok({
    exportId: id,
    cancelled,
    note: cancelled ? 'Cancellation requested.' : `This export is already ${job.status}.`,
  });
});
