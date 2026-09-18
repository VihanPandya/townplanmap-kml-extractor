/**
 * POST /api/kml/preview — parse a generated KML back into GeoJSON.
 *
 * Powers the built-in viewer: the user sees the actual generated document
 * rendered on the map, not the in-memory features it was built from, so the
 * check is a real verification rather than a restatement.
 */

import { z } from 'zod';
import { getJob, readArtifact } from '@/lib/exports/manager';
import { parseKml, kmlToFeatureCollection } from '@/lib/kml/parse';
import { extractKmlFromKmz } from '@/lib/discovery/providers/file-data';
import { validateKml } from '@/lib/kml/validate';
import { fail, handler, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({ exportId: z.string().min(1).max(200) });

export const POST = handler(async (request) => {
  const parsed = await readJson(request, schema);
  if (!parsed.ok) return parsed.response;

  const job = await getJob(parsed.data.exportId);
  if (!job) return fail(404, 'Unknown export.');
  if (job.status !== 'complete') return fail(409, `This export is ${job.status}.`);
  if (job.format === 'geojson') {
    return fail(400, 'This export is GeoJSON; download it directly rather than previewing it as KML.');
  }

  const bytes = await readArtifact(job);
  if (!bytes) return fail(410, 'The generated file is no longer available.');

  let xml: string;
  if (job.format === 'kmz') {
    const extracted = await extractKmlFromKmz(bytes);
    if (!extracted) return fail(422, 'The KMZ archive contained no KML document.');
    xml = extracted;
  } else if (job.format === 'bundle') {
    return fail(400, 'A bundle contains many files; preview an individual KML export instead.');
  } else {
    xml = new TextDecoder('utf-8').decode(bytes);
  }

  const result = parseKml(xml);
  if (!result.ok) return fail(422, 'The generated document could not be parsed.', result.reason);

  const collection = kmlToFeatureCollection(result.kml);
  const validation = validateKml(xml, job.featureCount);

  return ok({
    exportId: job.id,
    documentName: result.kml.documentName,
    featureCollection: collection,
    validation,
  });
});
