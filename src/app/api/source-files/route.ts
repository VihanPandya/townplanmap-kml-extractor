/** GET /api/source-files — the preserved original KML/KMZ files. */

import { listSourceFiles } from '@/lib/catalog';
import { formatBytes } from '@/lib/kml/validate';
import {
  ORIGIN_DESCRIPTIONS,
  ORIGIN_LABELS,
  ROUTE_LABELS,
  UNEXPOSED_ROUTES,
  summariseRoutes,
} from '@/lib/preservation/types';
import { handler, intParam, ok, searchParams } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request) => {
  const limit = intParam(searchParams(request), 'limit', 200, 1000);
  const files = await listSourceFiles(limit);

  return ok({
    // Stated on every response so a consumer of this API cannot mistake these
    // for generated documents.
    origin: 'original' as const,
    originLabel: ORIGIN_LABELS.original,
    originDescription: ORIGIN_DESCRIPTIONS.original,
    count: files.length,
    files: files.map((file) => ({
      ...file,
      size: formatBytes(file.byteSize),
      routeLabel: ROUTE_LABELS[file.route],
      /** True when the visible interface offers no way to reach this file. */
      unexposed: UNEXPOSED_ROUTES.has(file.route),
      downloadUrl: `/api/source-files/${file.id}/download`,
    })),
    routes: summariseRoutes(files).map((entry) => ({
      route: entry.route,
      label: ROUTE_LABELS[entry.route],
      count: entry.count,
    })),
  });
});
