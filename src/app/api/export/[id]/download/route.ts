/**
 * GET /api/export/:id/download — download a completed export.
 *
 * A download is refused unless the KML validation attached to the job passed,
 * so an invalid document cannot leave the tool. `?force=1` allows a deliberate
 * override for inspection, and the response says so in a header.
 */

import { getJob, readArtifact } from '@/lib/exports/manager';
import { sanitiseFilename } from '@/lib/kml/sanitize';
import { fail, handler, pathParam, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');
  const job = await getJob(id);
  if (!job) return fail(404, 'Unknown export.');

  if (job.status !== 'complete') {
    return fail(409, `This export is ${job.status}.`, job.error ?? undefined);
  }
  if (!job.artifact) return fail(410, 'This export produced no file.');

  const force = searchParams(request).get('force') === '1';
  if (job.validation && !job.validation.valid && !force) {
    const failures = job.validation.checks.filter((check) => !check.passed).map((check) => check.detail);
    return fail(
      409,
      'The generated document did not pass validation, so it was not offered for download.',
      failures.join(' '),
    );
  }

  const bytes = await readArtifact(job);
  if (!bytes) return fail(410, 'The generated file is no longer available. Run the export again.');

  // The filename is re-sanitised at the boundary: it reaches a Content-Disposition
  // header, where a stray quote or newline would be a header-injection vector.
  const filename = sanitiseFilename(job.artifact.filename, 'export');

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': job.artifact.contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // The counterpart of the header on /api/source-files/:id/download. An
      // automated consumer can tell a generated document from a preserved
      // original without reading either catalog.
      'x-artifact-origin': 'reconstructed',
      ...(job.validation && !job.validation.valid ? { 'x-kml-validation': 'failed-override' } : {}),
    },
  });
});
