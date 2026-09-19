/**
 * The preservation sweep: find every publicly accessible KML/KMZ the source
 * exposes, and keep the bytes.
 *
 * "Publicly accessible" is meant strictly. The sweep reads what the source
 * serves to an ordinary unauthenticated request, through the same guarded
 * fetcher everything else uses. A `401` or `403` is recorded as a refusal and
 * the file is left alone; nothing here attempts to bypass authentication,
 * paywalls, tokens or access controls. What it *does* do is follow references
 * the visible interface never surfaces:
 *
 *   - hrefs buried in JavaScript bundles and inline bootstrap config
 *   - sources named by a map style document
 *   - `<NetworkLink>` chains inside KML documents, followed transitively
 *   - `styleUrl` and overlay `<Icon>` references into further documents
 *
 * Everything retrieved is stored exactly as received and hashed, so a
 * preserved copy can be proven identical to what the source served. Original
 * bytes never pass through the KML builder — there is deliberately no code
 * path by which a regenerated document could inherit an original's identity.
 */

import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { LIMITS, SOURCE } from '@/lib/config';
import { RequestBudget } from '@/lib/net/budget';
import { safeFetch, asText } from '@/lib/net/safe-fetch';
import { detectImageFormat, isZipArchive } from '@/lib/geo/detect';
import { parseKml } from '@/lib/kml/parse';
import { extractKmlLinks, geographicLinks, type KmlLink } from '@/lib/kml/links';
import { sanitiseFilename } from '@/lib/kml/sanitize';
import { hash as shortHash } from '@/lib/discovery/harvest';
import type {
  DiscoveryRoute,
  FileInspection,
  PreservationFailure,
  PreservationSweep,
  PreservedFileKind,
  SourceFileRecord,
} from './types';

/** A URL queued for retrieval, with how it was reached. */
type Candidate = {
  url: string;
  route: DiscoveryRoute;
  discoveredIn: string;
  parentId: string | null;
  depth: number;
};

export type SweepOptions = {
  /** URLs already known to be worth trying — usually from the last scan. */
  seeds?: Array<{ url: string; route: DiscoveryRoute; discoveredIn: string }>;
  budget?: RequestBudget;
  signal?: AbortSignal;
  /** Bytes are returned alongside each record so the caller can store them. */
  onFile?: (record: SourceFileRecord, bytes: Uint8Array) => void | Promise<void>;
};

/** Does this URL look like it could be a KML or KMZ resource? */
export function looksLikeKmlResource(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (/\.km[lz]$/.test(path)) return true;

    const query = parsed.search.toLowerCase();
    // Service endpoints that emit KML on request.
    if (/[?&](f|format|outputformat)=km[lz]\b/.test(query)) return true;
    if (/kml|kmz/.test(query) && /(download|export|output|format)/.test(query)) return true;
    // A path segment naming the format, e.g. /export/kml/...
    if (/\/km[lz](\/|$)/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

/** The filename the source implied, from Content-Disposition or the URL path. */
export function filenameFor(url: string, contentDisposition: string | null, kind: PreservedFileKind): string {
  if (contentDisposition) {
    // RFC 5987 `filename*=UTF-8''name` takes precedence over plain `filename=`.
    const extended = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(contentDisposition);
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
    const raw = extended?.[1] ?? plain?.[1];
    if (raw) {
      try {
        const decoded = decodeURIComponent(raw.trim());
        if (decoded) return sanitiseFilename(decoded, `source.${kind}`);
      } catch {
        return sanitiseFilename(raw.trim(), `source.${kind}`);
      }
    }
  }

  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) {
      const decoded = decodeURIComponent(last);
      const cleaned = sanitiseFilename(decoded, `source.${kind}`);
      return /\.km[lz]$/i.test(cleaned) ? cleaned : `${cleaned}.${kind}`;
    }
    return `${sanitiseFilename(parsed.hostname, 'source')}.${kind}`;
  } catch {
    return `source.${kind}`;
  }
}

/** Read what a KML document contains, without altering it. */
function inspectKml(xml: string): FileInspection {
  const base: FileInspection = {
    documentName: null,
    placemarks: 0,
    withGeometry: 0,
    geometryTypes: [],
    folders: [],
    networkLinks: 0,
    hasRefreshingLinks: false,
    archiveEntries: [],
    parseError: null,
  };

  const parsed = parseKml(xml);
  if (!parsed.ok) {
    // The bytes are still preserved; only the summary is unavailable.
    return { ...base, parseError: parsed.reason };
  }

  const types = new Set<string>();
  const folders = new Set<string>();
  for (const placemark of parsed.kml.placemarks) {
    base.placemarks += 1;
    if (placemark.geometry) {
      base.withGeometry += 1;
      types.add(placemark.geometry.type);
    }
    if (placemark.folderPath.length > 0) folders.add(placemark.folderPath.join(' / '));
  }

  const links = extractKmlLinks(xml);
  if (links.ok) {
    base.networkLinks = links.links.filter((link) => link.kind === 'network-link').length;
    base.hasRefreshingLinks = links.links.some(
      (link) => link.refreshMode === 'onInterval' || link.refreshMode === 'onExpire',
    );
  }

  return {
    ...base,
    documentName: parsed.kml.documentName,
    geometryTypes: [...types].sort(),
    folders: [...folders].slice(0, 50),
  };
}

/** Pull the KML text out of a KMZ, and list what else the archive holds. */
async function readKmz(
  bytes: Uint8Array,
): Promise<{ xml: string | null; entries: string[]; error: string | null }> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files)
      .filter((file) => !file.dir)
      .map((file) => file.name);

    const kmlEntries = entries.filter((name) => /\.kml$/i.test(name));
    const chosen = kmlEntries.find((name) => /(^|\/)doc\.kml$/i.test(name)) ?? kmlEntries[0];
    if (!chosen) return { xml: null, entries, error: 'The archive contains no KML document.' };

    const file = zip.file(chosen);
    if (!file) return { xml: null, entries, error: 'The archive entry could not be opened.' };

    const uncompressed = await file.async('uint8array');
    if (uncompressed.byteLength > LIMITS.maxXmlBytes) {
      return {
        xml: null,
        entries,
        error: `The archive expands to ${uncompressed.byteLength} bytes, above the configured limit.`,
      };
    }

    return { xml: new TextDecoder('utf-8', { fatal: false }).decode(uncompressed), entries, error: null };
  } catch (error) {
    return { xml: null, entries: [], error: error instanceof Error ? error.message : 'The archive could not be read.' };
  }
}

/** Map a KML link kind onto the route that describes how it was reached. */
function routeForLink(link: KmlLink): DiscoveryRoute {
  switch (link.kind) {
    case 'network-link':
      return 'network-link';
    case 'style':
      return 'style-reference';
    case 'icon':
    case 'ground-overlay':
    case 'photo-overlay':
    case 'screen-overlay':
      return 'overlay-icon';
    default:
      return 'network-link';
  }
}

/**
 * Run a preservation sweep.
 *
 * Breadth-first, so shallow documents are preserved before deep NetworkLink
 * chains, and every bound is honoured: request budget, file count, file size
 * and link depth.
 */
export async function runPreservationSweep(options: SweepOptions = {}): Promise<PreservationSweep> {
  const startedAt = new Date().toISOString();
  const budget = options.budget ?? new RequestBudget(LIMITS.maxRequestsPerSweep);
  const notes: string[] = [];
  const warnings: string[] = [];
  const preserved: SourceFileRecord[] = [];
  const failures: PreservationFailure[] = [];

  const queue: Candidate[] = (options.seeds ?? [])
    .filter((seed) => looksLikeKmlResource(seed.url))
    .map((seed) => ({ url: seed.url, route: seed.route, discoveredIn: seed.discoveredIn, parentId: null, depth: 0 }));

  const skippedSeeds = (options.seeds ?? []).length - queue.length;
  if (skippedSeeds > 0) {
    notes.push(`${skippedSeeds} candidate URL(s) did not look like KML or KMZ resources and were not fetched.`);
  }

  const seenUrls = new Set(queue.map((candidate) => candidate.url));
  const seenHashes = new Map<string, string>();
  let candidatesConsidered = queue.length;

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      warnings.push('The sweep was cancelled before it finished.');
      break;
    }
    if (preserved.length >= LIMITS.maxPreservedFiles) {
      warnings.push(
        `The sweep stopped at the ${LIMITS.maxPreservedFiles} file limit. Raise TPM_MAX_PRESERVED_FILES to ` +
          'preserve more.',
      );
      break;
    }
    if (budget.requestsRemaining <= 0) {
      warnings.push('The request budget for this sweep was exhausted before every candidate was retrieved.');
      break;
    }

    const candidate = queue.shift();
    if (!candidate) break;

    const response = await safeFetch(candidate.url, {
      budget,
      signal: options.signal,
      accept:
        'application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/xml,text/xml,*/*;q=0.5',
      maxBytes: LIMITS.maxPreservedFileBytes,
    });

    if (!response.ok) {
      failures.push({
        url: candidate.url,
        route: candidate.route,
        discoveredIn: candidate.discoveredIn,
        kind: response.kind,
        reason:
          response.kind === 'auth-required'
            ? `This resource requires authorised access through ${SOURCE.name} and was not retrieved. ` +
              'No attempt was made to work around that.'
            : response.reason,
      });
      continue;
    }

    // --- establish what was actually served ------------------------------
    const bytes = response.body;
    const imageFormat = detectImageFormat(bytes);
    if (imageFormat) {
      failures.push({
        url: candidate.url,
        route: candidate.route,
        discoveredIn: candidate.discoveredIn,
        kind: 'not-kml',
        reason: `The URL served a ${imageFormat} image rather than a KML or KMZ document.`,
      });
      continue;
    }

    const archive = isZipArchive(bytes);
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
    const looksKml = /<kml[\s>]/i.test(head);

    if (!archive && !looksKml) {
      failures.push({
        url: candidate.url,
        route: candidate.route,
        discoveredIn: candidate.discoveredIn,
        kind: 'not-kml',
        reason: 'The response was neither a KML document nor a ZIP archive.',
      });
      continue;
    }

    const kind: PreservedFileKind = archive ? 'kmz' : 'kml';
    const digest = createHash('sha256').update(bytes).digest('hex');

    // The same document is routinely reachable by more than one path.
    const duplicateOf = seenHashes.get(digest);
    if (duplicateOf) {
      notes.push(
        `${candidate.url} is byte-identical to a file already preserved (${duplicateOf}); it was not stored twice.`,
      );
      continue;
    }
    seenHashes.set(digest, candidate.url);

    // --- inspect, without modifying the preserved bytes -------------------
    let xml: string | null = null;
    let inspection: FileInspection;

    if (archive) {
      const extracted = await readKmz(bytes);
      xml = extracted.xml;
      inspection = xml
        ? { ...inspectKml(xml), archiveEntries: extracted.entries }
        : {
            documentName: null,
            placemarks: 0,
            withGeometry: 0,
            geometryTypes: [],
            folders: [],
            networkLinks: 0,
            hasRefreshingLinks: false,
            archiveEntries: extracted.entries,
            parseError: extracted.error,
          };
    } else {
      xml = asText(response);
      inspection = inspectKml(xml);
    }

    const record: SourceFileRecord = {
      id: `src_${shortHash(candidate.url)}_${randomUUID().slice(0, 8)}`,
      origin: 'original',
      url: candidate.url,
      finalUrl: response.finalUrl !== candidate.url ? response.finalUrl : null,
      kind,
      filename: filenameFor(candidate.url, response.headers['content-disposition'] ?? null, kind),
      contentType: response.contentType || null,
      byteSize: bytes.byteLength,
      sha256: digest,
      retrievedAt: new Date().toISOString(),
      lastModified: response.headers['last-modified'] ?? null,
      etag: response.headers['etag'] ?? null,
      discoveredIn: candidate.discoveredIn,
      route: candidate.route,
      parentId: candidate.parentId,
      depth: candidate.depth,
      inspection,
      notes: [],
    };

    if (inspection.parseError) {
      record.notes.push(
        `The document could not be parsed (${inspection.parseError}), so no summary is available. The bytes ` +
          'are preserved unchanged regardless.',
      );
    }
    if (inspection.hasRefreshingLinks) {
      record.notes.push(
        'This document refreshes one or more of its links on a timer, so it is a live feed. The preserved ' +
          'copy is a snapshot taken at the retrieval time recorded above.',
      );
    }

    preserved.push(record);
    await options.onFile?.(record, bytes);

    // --- follow the document's own links ----------------------------------
    if (!xml || candidate.depth >= LIMITS.maxNetworkLinkDepth) {
      if (xml && inspection.networkLinks > 0) {
        notes.push(
          `${record.filename} declares ${inspection.networkLinks} NetworkLink(s) that were not followed: ` +
            `the depth limit of ${LIMITS.maxNetworkLinkDepth} was reached.`,
        );
      }
      continue;
    }

    const links = extractKmlLinks(xml);
    if (!links.ok) continue;

    for (const link of geographicLinks(links.links)) {
      let resolved: string;
      try {
        resolved = new URL(link.href, response.finalUrl).toString();
      } catch {
        continue;
      }
      if (seenUrls.has(resolved)) continue;
      if (!looksLikeKmlResource(resolved)) continue;

      seenUrls.add(resolved);
      candidatesConsidered += 1;
      queue.push({
        url: resolved,
        route: routeForLink(link),
        discoveredIn: `a ${link.kind === 'network-link' ? 'NetworkLink' : link.kind} inside ${record.filename}`,
        parentId: record.id,
        depth: candidate.depth + 1,
      });
    }
  }

  if (preserved.length === 0 && failures.length === 0) {
    notes.push('No KML or KMZ resource was found among the candidates supplied.');
  }

  const fromLinks = preserved.filter((file) => file.route === 'network-link' || file.route === 'style-reference');
  if (fromLinks.length > 0) {
    notes.push(
      `${fromLinks.length} file(s) were reached only by following links inside other KML documents, and are ` +
        'not offered anywhere in the visible interface.',
    );
  }

  return {
    id: `sweep_${shortHash(startedAt)}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidates: candidatesConsidered,
    preserved,
    failures,
    requestsSpent: budget.requestsSpent,
    bytesDownloaded: budget.bytesDownloaded,
    notes,
    warnings,
  };
}
