/** GET /api/source-files/:id — one preserved original file's record. */

import { getSourceFile, listSourceFiles } from '@/lib/catalog';
import { formatBytes } from '@/lib/kml/validate';
import { ORIGIN_DESCRIPTIONS, ORIGIN_LABELS, ROUTE_LABELS, UNEXPOSED_ROUTES } from '@/lib/preservation/types';
import { fail, handler, ok, pathParam } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, context) => {
  const id = await pathParam(context, 'id');
  if (!id) return fail(400, 'A resource id is required.');

  const file = await getSourceFile(id);
  if (!file) return fail(404, 'Unknown source file.');

  // Files this one reached through its own NetworkLinks.
  const all = await listSourceFiles(1000);
  const children = all.filter((candidate) => candidate.parentId === file.id);
  const parent = file.parentId ? (all.find((candidate) => candidate.id === file.parentId) ?? null) : null;

  return ok({
    file: {
      ...file,
      size: formatBytes(file.byteSize),
      routeLabel: ROUTE_LABELS[file.route],
      unexposed: UNEXPOSED_ROUTES.has(file.route),
      downloadUrl: `/api/source-files/${file.id}/download`,
    },
    originLabel: ORIGIN_LABELS.original,
    originDescription: ORIGIN_DESCRIPTIONS.original,
    parent: parent ? { id: parent.id, filename: parent.filename, url: parent.url } : null,
    children: children.map((child) => ({
      id: child.id,
      filename: child.filename,
      url: child.url,
      routeLabel: ROUTE_LABELS[child.route],
    })),
  });
});
