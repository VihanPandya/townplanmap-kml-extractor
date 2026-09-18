/**
 * XML escaping and filename sanitisation for generated output.
 */

/** Control characters XML 1.0 forbids outright. */
const FORBIDDEN_XML_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]',
  'g',
);

/**
 * Escape text for an XML text node or attribute value.
 *
 * Also strips the control characters that XML 1.0 forbids: a stray 0x00-0x08 in
 * a source attribute would otherwise produce a document no parser will accept,
 * and the failure would only surface later, inside the user's GIS software.
 */
export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escape a value of unknown scalar type for XML. */
export function escapeValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return escapeXml(String(value));
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Turn arbitrary source text into a filename that is safe on every platform.
 *
 * Path separators and traversal sequences are removed rather than replaced
 * positionally, so a feature named `../../etc/passwd` cannot escape the
 * directory a bulk export writes into.
 */
export function sanitiseFilename(raw: string, fallback = 'export'): string {
  let name = raw
    .normalize('NFKD')
    .replace(CONTROL_CHARS, '')
    .replace(/[/\\]+/g, '_')
    .replace(/[<>:"|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();

  if (!name) name = fallback;

  // A leading dot or a reserved device name would still be trouble.
  const stem = name.split('.')[0]?.toUpperCase() ?? '';
  if (RESERVED_WINDOWS_NAMES.has(stem)) name = `_${name}`;

  // Keep well inside the 255-byte limit common filesystems impose.
  if (name.length > 120) name = name.slice(0, 120).replace(/_+$/, '');

  return name || fallback;
}

/** Build a `<location>_<reference>.kml` style name. */
export function buildFeatureFilename(
  locationName: string | null,
  featureReference: string,
  extension = 'kml',
): string {
  const parts = [locationName, featureReference].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  const stem = sanitiseFilename(parts.join('_'), 'feature');
  return `${stem}.${extension}`;
}

/** Ensure every name in a bulk export is unique, appending a counter if needed. */
export function uniquifyFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);
  let counter = 2;
  let candidate = `${stem}_${counter}${extension}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}_${counter}${extension}`;
  }
  used.add(candidate);
  return candidate;
}
