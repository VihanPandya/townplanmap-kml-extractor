/**
 * KMZ and ZIP packaging.
 *
 * KMZ is a ZIP archive whose entry point is `doc.kml`; bulk exports use the
 * folder layout documented in the README so a downloaded archive is navigable
 * without any of the tool's own context.
 */

import JSZip from 'jszip';
import { sanitiseFilename, uniquifyFilename } from './sanitize';

export type ArchiveEntry = {
  /** Path inside the archive, using forward slashes. */
  path: string;
  content: string | Uint8Array;
};

/** Wrap a single KML document as a KMZ archive. */
export async function buildKmz(kml: string, extras: ArchiveEntry[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  // `doc.kml` at the archive root is the conventional entry point that Google
  // Earth and QGIS both look for first.
  zip.file('doc.kml', kml);
  for (const entry of extras) {
    zip.file(sanitisePath(entry.path), entry.content);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Build a general ZIP archive from a list of entries. */
export async function buildZip(entries: ArchiveEntry[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const entry of entries) {
    const path = uniquifyFilename(sanitisePath(entry.path), used);
    zip.file(path, entry.content);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/**
 * Sanitise each path segment independently.
 *
 * Directory separators are meaningful inside an archive, so they are preserved,
 * but every segment is cleaned and `.`/`..` segments are dropped so an entry
 * cannot escape the extraction directory ("zip slip").
 */
export function sanitisePath(path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map((segment, index, all) =>
      index === all.length - 1 ? sanitiseFileSegment(segment) : sanitiseFilename(segment, 'folder'),
    );
  return segments.length > 0 ? segments.join('/') : 'file';
}

/** Keep a final segment's extension intact while cleaning its stem. */
function sanitiseFileSegment(segment: string): string {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return sanitiseFilename(segment, 'file');
  const stem = sanitiseFilename(segment.slice(0, dot), 'file');
  const extension = segment.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '');
  return extension ? `${stem}.${extension}` : stem;
}
