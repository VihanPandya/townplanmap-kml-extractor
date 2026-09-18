/**
 * XML parsing hardened against entity-expansion and external-entity attacks.
 *
 * WFS/WMS capabilities documents and KML files are XML fetched from a third
 * party, so the parser is the attack surface. fast-xml-parser never resolves
 * external entities, but a document can still carry a DOCTYPE with internal
 * entity definitions ("billion laughs"), so those are rejected before parsing
 * and entity processing is switched off entirely.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { LIMITS } from '@/lib/config';

export type XmlParseResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; reason: string };

/** Anything that declares a DTD or an entity is refused outright. */
const DOCTYPE_PATTERN = /<!DOCTYPE/i;
const ENTITY_PATTERN = /<!ENTITY/i;
/** An XML declaration or processing instruction pointing at an external resource. */
const EXTERNAL_PATTERN = /\b(SYSTEM|PUBLIC)\s+["']/i;

export function safeParseXml(xml: string, options: { maxBytes?: number } = {}): XmlParseResult {
  const maxBytes = options.maxBytes ?? LIMITS.maxXmlBytes;
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > maxBytes) {
    return { ok: false, reason: `XML document of ${byteLength} bytes exceeds the ${maxBytes} byte limit.` };
  }

  // Only inspect the prolog: a DOCTYPE is only legal before the root element,
  // and scanning the whole document would reject documents that merely contain
  // the literal text inside an element value.
  const prolog = xml.slice(0, 4096);
  if (DOCTYPE_PATTERN.test(prolog)) {
    return { ok: false, reason: 'XML declares a DOCTYPE. Documents with a DTD are rejected.' };
  }
  if (ENTITY_PATTERN.test(prolog) || EXTERNAL_PATTERN.test(prolog)) {
    return { ok: false, reason: 'XML declares entities or external references and was rejected.' };
  }

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    return { ok: false, reason: `XML is not well-formed: ${validation.err.msg} (line ${validation.err.line}).` };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    allowBooleanAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    htmlEntities: false,
    // Strip namespace prefixes so `gml:Polygon` and `Polygon` read the same.
    removeNSPrefix: true,
  });

  try {
    return { ok: true, doc: parser.parse(xml) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'XML could not be parsed.' };
  }
}

/** Normalise fast-xml-parser's "one child or an array of children" shape. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a nested path out of a parsed document without throwing. */
export function pick(doc: unknown, ...path: string[]): unknown {
  let node: unknown = doc;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Coerce a parsed XML text node to a trimmed string. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)['#text']);
  }
  return undefined;
}
