/**
 * GET /api/source-files/:id/download — the preserved file, byte for byte.
 *
 * This route serves the exact bytes the source returned. It does not parse,
 * re-serialise or regenerate anything, and it is deliberately separate from
 * the export download route so there is no code path by which a reconstructed
 * document could be served as an original.
 */

import { getSourceFile, getSourceFileBytes } from '@/lib/catalog';
import { sanitiseFilename } from '@/lib/kml/sanitize';
import { fail, handler, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES = {
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
} as const;

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');

  const file = await getSourceFile(id);
  if (!file) return fail(404, 'Unknown source file.');

  const bytes = await getSourceFileBytes(id);
  if (!bytes) return fail(410, 'The preserved bytes are no longer available. Run the sweep again.');

  // Re-sanitised at the boundary: the filename came from the source and reaches
  // a Content-Disposition header, where a stray quote or newline is injection.
  const filename = sanitiseFilename(file.filename, `source.${file.kind}`);

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': file.contentType || CONTENT_TYPES[file.kind],
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Machine-readable statement of what this file is, so an automated
      // consumer has the distinction without reading the catalog.
      'x-artifact-origin': 'original',
      'x-source-url': file.url,
      'x-content-sha256': file.sha256,
    },
  });
});
