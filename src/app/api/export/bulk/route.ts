/**
 * POST /api/export/bulk — start a bulk export.
 *
 * Produces the documented archive layout: a combined KML under KML/, one file
 * per feature under Individual/, and a metadata.json recording provenance.
 */

import { startExport } from '@/lib/exports/manager';
import { exportRequestSchema, handler, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = handler(async (request) => {
  const parsed = await readJson(request, exportRequestSchema);
  if (!parsed.ok) return parsed.response;

  const job = await startExport({ ...parsed.data, individualFiles: true });
  return ok({ exportId: job.id, status: job.status, label: job.label }, { status: 202 });
});
