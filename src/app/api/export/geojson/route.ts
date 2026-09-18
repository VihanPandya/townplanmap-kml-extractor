/** POST /api/export/geojson — start a GeoJSON export job. */

import { startExport } from '@/lib/exports/manager';
import { flexibleExportSchema, handler, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = handler(async (request) => {
  const parsed = await readJson(request, flexibleExportSchema);
  if (!parsed.ok) return parsed.response;

  const job = await startExport({ ...parsed.data, format: 'geojson' });
  return ok({ exportId: job.id, status: job.status, label: job.label }, { status: 202 });
});
