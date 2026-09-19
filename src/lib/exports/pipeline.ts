/**
 * The export pipeline.
 *
 * Runs the hierarchy the product is built around, in order and without
 * shortcuts:
 *
 *   read vector geometry -> validate -> transform CRS if required ->
 *   generate KML -> validate the generated KML -> make available for download
 *
 * A feature that fails any step is excluded and reported by id and reason.
 * Nothing is approximated to keep a feature in the output.
 */

import { LIMITS, SOURCE } from '@/lib/config';
import { getStore } from '@/lib/db';
import { ensureGeometry, getLayer, listFeatures, providerForLayer } from '@/lib/catalog';
import { RequestBudget } from '@/lib/net/budget';
import { buildKmlDocument } from '@/lib/kml/builder';
import { validateKml, type KmlValidationReport } from '@/lib/kml/validate';
import { buildKmz, buildZip, type ArchiveEntry } from '@/lib/kml/package';
import { buildFeatureFilename, sanitiseFilename } from '@/lib/kml/sanitize';
import { prepareForKml } from '@/lib/geo/geometry';
import type { FeatureRecord, LayerRecord } from '@/lib/discovery/types';
import type { SourceFileRecord } from '@/lib/preservation/types';
import type { ExportProgress, ExportRequest, ExportScope } from './types';

export type PipelineOutput = {
  content: string | Uint8Array;
  filename: string;
  contentType: string;
  featureCount: number;
  skipped: Array<{ featureId: string; reason: string }>;
  validation: KmlValidationReport | null;
  notes: string[];
};

export type ProgressReporter = (progress: Partial<ExportProgress>) => void;

/**
 * Collect every feature a scope refers to, fetching geometry for each.
 *
 * Reading is paged and capped; when the cap is reached the caller is told
 * rather than being handed a silently partial export.
 */
async function collectFeatures(
  scope: ExportScope,
  report: ProgressReporter,
  signal?: AbortSignal,
): Promise<{ groups: Array<{ layer: LayerRecord; features: FeatureRecord[] }>; notes: string[] }> {
  const store = await getStore();
  const notes: string[] = [];
  const groups: Array<{ layer: LayerRecord; features: FeatureRecord[] }> = [];

  const layerIds =
    scope.type === 'features' || scope.type === 'layer'
      ? [scope.layerId]
      : scope.type === 'location'
        ? scope.layerIds
        : scope.layerIds;

  let processed = 0;

  for (const layerId of layerIds) {
    if (signal?.aborted) throw new Error('Export cancelled.');

    const layer = await getLayer(layerId);
    if (!layer) {
      notes.push(`Layer ${layerId} is not in the catalog and was skipped.`);
      continue;
    }

    if (layer.availability.status === 'raster') {
      notes.push(
        `"${layer.name}" exposes only map imagery. KML cannot be generated reliably from imagery, so it was excluded.`,
      );
      continue;
    }
    if (layer.availability.status === 'restricted') {
      notes.push(`"${layer.name}" requires authorised access through ${SOURCE.name} and was excluded.`);
      continue;
    }

    let features: FeatureRecord[] = [];

    if (scope.type === 'features') {
      const wanted = new Set(scope.featureIds);
      const fromStore = await store.getFeatures(scope.featureIds);
      features = fromStore.filter((feature) => wanted.has(feature.id));

      const missing = scope.featureIds.filter(
        (id) => !features.some((feature) => feature.id === id),
      );
      if (missing.length > 0) {
        notes.push(`${missing.length} selected feature(s) were not found in the catalog and were skipped.`);
      }
    } else {
      // Page the whole layer.
      features = await readWholeLayer(layer, report, () => (processed += 1), notes, signal);
    }

    // Geometry is what the export is for, so fetch any that is missing.
    const withGeometry: FeatureRecord[] = [];
    for (const feature of features) {
      if (signal?.aborted) throw new Error('Export cancelled.');
      const resolved = feature.geometry ? feature : await ensureGeometry(feature, signal);
      withGeometry.push(resolved);
      processed += 1;
      if (processed % 25 === 0) {
        report({ featuresProcessed: processed, phase: 'reading' });
      }
    }

    groups.push({ layer, features: withGeometry });
  }

  return { groups, notes };
}

/** Page through an entire layer, respecting the per-layer feature cap. */
async function readWholeLayer(
  layer: LayerRecord,
  report: ProgressReporter,
  tick: () => void,
  notes: string[],
  signal?: AbortSignal,
): Promise<FeatureRecord[]> {
  const provider = providerForLayer(layer);
  if (!provider) {
    notes.push(`No reader is available for "${layer.name}" (${layer.endpointKind}).`);
    return [];
  }

  const budget = new RequestBudget(Math.min(LIMITS.maxRequestsPerScan * 4, 400));
  const collected: FeatureRecord[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    if (signal?.aborted) throw new Error('Export cancelled.');

    const page = await provider.listFeatures(
      layer,
      { cursor, limit: LIMITS.featurePageSize, includeGeometry: true, bbox: layer.bbox ?? null },
      { budget, signal, locationId: layer.locationId },
    );

    collected.push(...page.features);
    for (const _ of page.features) tick();
    cursor = page.nextCursor;
    pages += 1;

    report({
      phase: 'reading',
      featuresProcessed: collected.length,
      message: `Reading "${layer.name}": ${collected.length.toLocaleString()} features so far.`,
    });

    for (const note of page.notes) {
      if (!notes.includes(note)) notes.push(note);
    }

    if (collected.length >= LIMITS.maxFeaturesPerLayer) {
      notes.push(
        `"${layer.name}" was truncated at the ${LIMITS.maxFeaturesPerLayer.toLocaleString()} feature limit. ` +
          'Raise TPM_MAX_FEATURES_PER_LAYER to export more.',
      );
      break;
    }
    if (budget.exhausted) {
      notes.push(`Reading "${layer.name}" stopped at the request budget for this export.`);
      break;
    }
    // A provider that keeps returning the same cursor would loop forever.
    if (pages > 2000) break;
  } while (cursor);

  const store = await getStore();
  if (collected.length > 0) await store.saveFeatures(collected);

  return collected;
}

/**
 * Validate and transform each feature's geometry before generation.
 *
 * Doing this as its own pass means the progress display can show a real
 * geometry-validation percentage, and means an export fails fast on a layer
 * whose CRS cannot be resolved rather than after writing a large document.
 */
function validateGeometries(
  groups: Array<{ layer: LayerRecord; features: FeatureRecord[] }>,
  report: ProgressReporter,
): { usable: Array<{ layer: LayerRecord; features: FeatureRecord[] }>; skipped: Array<{ featureId: string; reason: string }> } {
  const skipped: Array<{ featureId: string; reason: string }> = [];
  const total = groups.reduce((sum, group) => sum + group.features.length, 0);
  let checked = 0;

  const usable = groups.map((group) => {
    const features = group.features.filter((feature) => {
      checked += 1;
      if (checked % 50 === 0 || checked === total) {
        report({
          phase: 'validating-geometry',
          geometryValidationPercent: total === 0 ? 100 : Math.round((checked / total) * 100),
          featuresProcessed: checked,
        });
      }

      if (!feature.geometry) {
        skipped.push({ featureId: feature.id, reason: 'No geometry was available for this feature.' });
        return false;
      }
      const prepared = prepareForKml(feature.geometry, feature.crs);
      if (!prepared.ok) {
        skipped.push({ featureId: feature.id, reason: prepared.reason });
        return false;
      }
      if (!prepared.validation.valid) {
        skipped.push({
          featureId: feature.id,
          reason: prepared.validation.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.message)
            .join(' '),
        });
        return false;
      }
      return true;
    });

    return { layer: group.layer, features };
  });

  report({ phase: 'validating-geometry', geometryValidationPercent: 100 });
  return { usable, skipped };
}

/** Folder path for a feature, mirroring location / layer structure. */
function folderPathFor(layer: LayerRecord, locationName: string | null): string[] {
  const path: string[] = [];
  if (locationName) path.push(locationName);
  path.push(layer.name);
  return path;
}

export async function runExport(
  request: ExportRequest,
  report: ProgressReporter,
  signal?: AbortSignal,
): Promise<PipelineOutput> {
  const store = await getStore();
  report({ phase: 'reading', message: 'Reading features from the source…' });

  const { groups, notes } = await collectFeatures(request.scope, report, signal);
  const totalRead = groups.reduce((sum, group) => sum + group.features.length, 0);
  report({ featuresTotal: totalRead, featuresProcessed: totalRead });

  if (totalRead > LIMITS.maxFeaturesPerExport) {
    throw new Error(
      `This selection contains ${totalRead.toLocaleString()} features, above the ` +
        `${LIMITS.maxFeaturesPerExport.toLocaleString()} per-export limit.`,
    );
  }

  const { usable, skipped } = validateGeometries(groups, report);

  let locationName: string | null = null;
  if (request.scope.type === 'location') {
    const location = await store.getLocation(request.scope.locationId);
    locationName = location?.name ?? null;
  }

  const documentName =
    request.name ??
    locationName ??
    usable[0]?.layer.name ??
    'TownPlanMap export';

  report({ phase: 'generating', message: 'Generating KML…', generationPercent: 10 });

  // --- individual files, packaged as a ZIP --------------------------------
  if (request.individualFiles) {
    return buildIndividualFiles(
      usable,
      locationName,
      documentName,
      skipped,
      notes,
      report,
      request.includeOriginals !== false,
    );
  }

  // --- GeoJSON ------------------------------------------------------------
  if (request.format === 'geojson') {
    return buildGeoJson(usable, documentName, skipped, notes, report);
  }

  // --- single KML / KMZ ---------------------------------------------------
  const folders = usable
    .filter((group) => group.features.length > 0)
    .map((group) => ({ path: folderPathFor(group.layer, locationName), features: group.features }));

  const built = buildKmlDocument({
    documentName,
    documentDescription: `Exported from ${SOURCE.name} by the TownPlanMap KML Extractor.`,
    sourceDataset: usable.map((group) => group.layer.name).join(', ') || null,
    sourcePage: usable[0]?.layer.serviceUrl ?? null,
    folders,
  });

  skipped.push(...built.skipped);
  report({ phase: 'generating', generationPercent: 100 });
  report({ phase: 'validating-kml', message: 'Validating the generated KML…' });

  const validation = validateKml(built.kml, built.written);
  const bytes = Buffer.byteLength(built.kml, 'utf8');

  if (bytes > LIMITS.maxKmlBytes) {
    throw new Error(
      `The generated document is ${bytes.toLocaleString()} bytes, above the ` +
        `${LIMITS.maxKmlBytes.toLocaleString()} byte limit.`,
    );
  }

  const stem = sanitiseFilename(documentName, 'TownPlanMap_export');

  if (request.format === 'kmz') {
    report({ phase: 'packaging', message: 'Packaging as KMZ…' });
    const kmz = await buildKmz(built.kml);
    return {
      content: kmz,
      filename: `${stem}.kmz`,
      contentType: 'application/vnd.google-earth.kmz',
      featureCount: built.written,
      skipped,
      validation,
      notes,
    };
  }

  return {
    content: built.kml,
    filename: `${stem}.kml`,
    contentType: 'application/vnd.google-earth.kml+xml',
    featureCount: built.written,
    skipped,
    validation,
    notes,
  };
}

async function buildIndividualFiles(
  groups: Array<{ layer: LayerRecord; features: FeatureRecord[] }>,
  locationName: string | null,
  documentName: string,
  skipped: Array<{ featureId: string; reason: string }>,
  notes: string[],
  report: ProgressReporter,
  includeOriginals: boolean,
): Promise<PipelineOutput> {
  const entries: ArchiveEntry[] = [];
  const combinedFolders: Array<{ path: string[]; features: FeatureRecord[] }> = [];
  let written = 0;

  const total = groups.reduce((sum, group) => sum + group.features.length, 0);
  let done = 0;

  for (const group of groups) {
    combinedFolders.push({ path: folderPathFor(group.layer, locationName), features: group.features });

    for (const feature of group.features) {
      const single = buildKmlDocument({
        documentName: feature.name,
        sourceDataset: group.layer.name,
        sourcePage: group.layer.serviceUrl,
        features: [feature],
      });

      done += 1;
      if (done % 20 === 0 || done === total) {
        report({
          phase: 'generating',
          generationPercent: total === 0 ? 100 : Math.round((done / total) * 100),
          featuresProcessed: done,
        });
      }

      if (single.written === 0) {
        skipped.push(...single.skipped);
        continue;
      }

      entries.push({
        path: `Reconstructed/Individual/${buildFeatureFilename(locationName, feature.name)}`,
        content: single.kml,
      });
      written += 1;
    }
  }

  // A combined document alongside the individual ones, matching the documented
  // bulk-export layout.
  const combined = buildKmlDocument({
    documentName,
    documentDescription: `Exported from ${SOURCE.name} by the TownPlanMap KML Extractor.`,
    sourceDataset: groups.map((group) => group.layer.name).join(', ') || null,
    folders: combinedFolders,
  });

  report({ phase: 'validating-kml', message: 'Validating the generated KML…' });
  const validation = validateKml(combined.kml, combined.written);

  const stem = sanitiseFilename(documentName, 'TownPlanMap_export');
  entries.unshift({ path: `Reconstructed/KML/${stem}.kml`, content: combined.kml });

  // --- preserved originals, kept strictly apart -----------------------------
  //
  // Originals go in their own top-level directory and are written byte for
  // byte. They are never regenerated, and the directory names alone make the
  // distinction legible to someone who unzips the archive with no other
  // context.
  const originals = includeOriginals ? await loadOriginals() : [];
  for (const original of originals) {
    entries.push({ path: `Original/${original.record.filename}`, content: original.bytes });
  }

  entries.push({
    path: 'README.txt',
    content: originArchiveReadme(originals.length, written, combined.written),
  });

  entries.push({
    path: 'metadata.json',
    content: JSON.stringify(
      {
        source: SOURCE.name,
        sourceUrl: SOURCE.homepage,
        extractionDate: new Date().toISOString(),
        generator: 'TownPlanMap KML Extractor',
        documentName,
        reconstructed: {
          origin: 'reconstructed',
          note:
            'Generated by this tool from geometry read out of the source. Not files the source published.',
          individualFiles: written,
          combinedFeatures: combined.written,
          layers: groups.map((group) => ({
            name: group.layer.name,
            serviceUrl: group.layer.serviceUrl,
            category: group.layer.category,
            sourceCrs: group.layer.crs.code,
            attribution: group.layer.attribution,
            featureCount: group.features.length,
          })),
          skipped,
        },
        original: {
          origin: 'original',
          note: 'Retrieved from the source and preserved byte for byte. Verify with the SHA-256 below.',
          fileCount: originals.length,
          files: originals.map((entry) => ({
            filename: entry.record.filename,
            url: entry.record.url,
            sha256: entry.record.sha256,
            byteSize: entry.record.byteSize,
            retrievedAt: entry.record.retrievedAt,
            discoveredIn: entry.record.discoveredIn,
            route: entry.record.route,
          })),
        },
        notes,
      },
      null,
      2,
    ),
  });

  report({ phase: 'packaging', message: 'Packaging the archive…' });
  const zip = await buildZip(entries);

  return {
    content: zip,
    filename: `${stem}_KML.zip`,
    contentType: 'application/zip',
    featureCount: written,
    skipped,
    validation,
    notes,
  };
}

async function buildGeoJson(
  groups: Array<{ layer: LayerRecord; features: FeatureRecord[] }>,
  documentName: string,
  skipped: Array<{ featureId: string; reason: string }>,
  notes: string[],
  report: ProgressReporter,
): Promise<PipelineOutput> {
  const features: unknown[] = [];

  for (const group of groups) {
    for (const feature of group.features) {
      if (!feature.geometry) continue;
      const prepared = prepareForKml(feature.geometry, feature.crs);
      if (!prepared.ok || !prepared.validation.valid) continue;

      features.push({
        type: 'Feature',
        id: feature.sourceFeatureId ?? feature.id,
        geometry: prepared.geometry,
        properties: {
          ...feature.properties,
          name: feature.name,
          source_layer: group.layer.name,
          provenance: feature.provenance,
          source: SOURCE.name,
          source_url: feature.sourceUrl,
        },
      });
    }
  }

  report({ phase: 'generating', generationPercent: 100 });

  const document = {
    type: 'FeatureCollection',
    name: documentName,
    // RFC 7946 fixes GeoJSON to WGS84; recorded here for readers rather than as
    // a legacy `crs` member, which the specification removed.
    metadata: {
      source: SOURCE.name,
      sourceUrl: SOURCE.homepage,
      extractionDate: new Date().toISOString(),
      coordinateSystem: 'WGS84 (EPSG:4326)',
      generator: 'TownPlanMap KML Extractor',
    },
    features,
  };

  return {
    content: JSON.stringify(document, null, 2),
    filename: `${sanitiseFilename(documentName, 'TownPlanMap_export')}.geojson`,
    contentType: 'application/geo+json',
    featureCount: features.length,
    skipped,
    validation: null,
    notes,
  };
}

/**
 * Load the preserved original files for a bundle.
 *
 * These are read straight out of the store and written into the archive
 * unchanged. They never pass through `buildKmlDocument`, which is what
 * guarantees an original cannot be silently replaced by a regenerated
 * equivalent.
 */
async function loadOriginals(): Promise<Array<{ record: SourceFileRecord; bytes: Uint8Array }>> {
  const store = await getStore();
  const records = await store.listSourceFiles(LIMITS.maxPreservedFiles);

  const out: Array<{ record: SourceFileRecord; bytes: Uint8Array }> = [];
  const usedNames = new Set<string>();

  for (const record of records) {
    const bytes = await store.getSourceFileBytes(record.id);
    if (!bytes) continue;

    // Two originals can legitimately share a filename; keep both.
    let filename = record.filename;
    if (usedNames.has(filename)) {
      const dot = filename.lastIndexOf('.');
      const stem = dot === -1 ? filename : filename.slice(0, dot);
      const extension = dot === -1 ? '' : filename.slice(dot);
      filename = `${stem}_${record.sha256.slice(0, 8)}${extension}`;
    }
    usedNames.add(filename);

    out.push({ record: { ...record, filename }, bytes });
  }

  return out;
}

/** The note that ships inside a bundle, so the archive explains itself. */
function originArchiveReadme(originals: number, individual: number, combined: number): string {
  return [
    'TownPlanMap KML Extractor — export bundle',
    '=========================================',
    '',
    'This archive contains two kinds of file. They are not interchangeable.',
    '',
    'Original/',
    `  ${originals} file(s) retrieved from the source and preserved byte for byte.`,
    '  These are the files the source itself published. Their SHA-256 hashes are',
    '  recorded in metadata.json, so each copy can be proven identical to what',
    '  was served.',
    '',
    'Reconstructed/',
    `  ${combined} feature(s) in one combined document, plus ${individual} individual file(s).`,
    '  These were GENERATED by the extractor from geometry it read out of the',
    '  source. They are NOT files the source published and must not be presented',
    '  as such. Every one carries origin=reconstructed in its ExtendedData.',
    '',
    'metadata.json',
    '  Provenance for both: source URLs, retrieval times, hashes, coordinate',
    '  reference systems, and anything excluded from the export with the reason.',
    '',
    'Extracted geographic data should be independently verified before use in',
    'legal, surveying, property or other high-stakes decisions.',
    '',
  ].join('\n');
}
