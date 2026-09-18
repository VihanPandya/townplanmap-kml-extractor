/**
 * City and village/locality discovery.
 *
 * The product rule is that no place name is ever hard-coded: everything the
 * selectors offer has to come from the source, and each entry records where it
 * came from so the UI can show its provenance.
 *
 * Three independent strategies are used, because different deployments expose
 * their place list in different ways:
 *
 *   A. Markup — `<select>`/`<option>` lists and `<datalist>`s on the page.
 *   B. Bootstrap data — JSON arrays inside inline or bundled script that carry
 *      an obvious place-name shape.
 *   C. The GIS services themselves — ArcGIS folder and service names, and the
 *      distinct values of a name attribute on an administrative-boundary layer.
 *
 * Whatever the strategies find is merged and de-duplicated. If they find
 * nothing, the selector says so rather than falling back to a built-in list.
 */

import { safeFetch, asText, asJson } from '@/lib/net/safe-fetch';
import type { RequestBudget } from '@/lib/net/budget';
import { hash } from './harvest';
import type { DiscoveredEndpoint, LayerRecord, LocationRecord } from './types';

/** Keys whose values are likely to be place names. */
const PLACE_KEY = /^(city|cities|district|districts|village|villages|taluka|talukas|tehsil|area|areas|locality|localities|region|regions|zone|ward|town|towns|municipality|place|places|location|locations)$/i;
const PLACE_NAME_KEY = /^(name|title|label|city_?name|village_?name|area_?name|district_?name|display_?name|text|value)$/i;

/** Attribute names that carry a place name on an administrative layer. */
const PLACE_FIELD = /(village|city|town|ward|taluka|tehsil|district|area|locality|gram|municipal)[_ ]?(name|nm)?$/i;

function cleanName(raw: string): string | null {
  const name = raw
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
    .trim();
  if (name.length < 2 || name.length > 80) return null;
  // Reject obvious placeholders and non-place strings.
  if (/^(select|choose|all|none|--|n\/?a|null|undefined|please select|\d+)$/i.test(name)) return null;
  if (!/[A-Za-zऀ-ॿ]/.test(name)) return null; // Latin or Devanagari letters
  return name;
}

function makeLocation(
  name: string,
  kind: 'city' | 'area',
  parentId: string | null,
  sourceUrl: string,
  sourceField?: string,
): LocationRecord {
  return {
    id: `${kind}_${hash(`${parentId ?? ''}:${name.toLowerCase()}`)}`,
    name,
    kind,
    parentId,
    sourceUrl,
    sourceField,
  };
}

/**
 * Strategy A — `<select>` and `<datalist>` controls in the page markup.
 *
 * The control's own name/id/label decides whether its options are cities or
 * smaller areas, so a village dropdown is not mistaken for a city one.
 */
export function locationsFromMarkup(html: string, sourceUrl: string): LocationRecord[] {
  const out: LocationRecord[] = [];
  const seen = new Set<string>();

  const selectBlock = /<(select|datalist)\b([^>]*)>([\s\S]{0,200000}?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = selectBlock.exec(html)) !== null) {
    const attributes = match[2] ?? '';
    const body = match[3] ?? '';
    const descriptor = attributes.toLowerCase();

    const isCity = /\b(city|cities|district|municipal|corporation)\b/.test(descriptor);
    const isArea = /\b(village|area|locality|ward|taluka|tehsil|zone|town)\b/.test(descriptor);
    if (!isCity && !isArea) continue;

    const kind: 'city' | 'area' = isCity && !isArea ? 'city' : 'area';
    const fieldName = /\b(?:name|id)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? undefined;

    const option = /<option\b[^>]*>([\s\S]{0,300}?)<\/option>/gi;
    let optionMatch: RegExpExecArray | null;
    while ((optionMatch = option.exec(body)) !== null) {
      const text = (optionMatch[1] ?? '').replace(/<[^>]*>/g, '');
      const name = cleanName(text);
      if (!name) continue;
      const key = `${kind}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makeLocation(name, kind, null, sourceUrl, fieldName));
    }
  }

  return out;
}

/**
 * Strategy B — JSON arrays of place-shaped objects embedded in script.
 *
 * Only arrays reached through a key that names a place type are considered, so
 * an unrelated array of strings elsewhere in a bundle is not mined for names.
 */
export function locationsFromScriptData(text: string, sourceUrl: string): LocationRecord[] {
  const out: LocationRecord[] = [];
  const seen = new Set<string>();

  // Find `"cities": [ ... ]` style arrays and parse only that slice.
  const arrayStart = /["']?(\w+)["']?\s*:\s*\[/g;
  let match: RegExpExecArray | null;

  while ((match = arrayStart.exec(text)) !== null) {
    const key = match[1];
    if (!key || !PLACE_KEY.test(key)) continue;

    const openIndex = text.indexOf('[', match.index);
    if (openIndex === -1) continue;
    const slice = extractBalanced(text, openIndex, 200_000);
    if (!slice) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue; // Not literal JSON (a variable reference, a template) — skip it.
    }
    if (!Array.isArray(parsed)) continue;

    const kind: 'city' | 'area' = /^(city|cities|district|districts|municipality)$/i.test(key) ? 'city' : 'area';

    for (const entry of parsed.slice(0, 5000)) {
      let name: string | null = null;
      let field: string | undefined;

      if (typeof entry === 'string') {
        name = cleanName(entry);
      } else if (entry && typeof entry === 'object') {
        for (const [candidateKey, value] of Object.entries(entry as Record<string, unknown>)) {
          if (!PLACE_NAME_KEY.test(candidateKey)) continue;
          if (typeof value !== 'string') continue;
          name = cleanName(value);
          field = candidateKey;
          if (name) break;
        }
      }

      if (!name) continue;
      const dedupeKey = `${kind}:${name.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(makeLocation(name, kind, null, sourceUrl, field ?? key));
    }
  }

  return out;
}

/** Extract a balanced bracket span starting at `start`, up to `maxLength`. */
function extractBalanced(text: string, start: number, maxLength: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let index = start; index < text.length && index - start < maxLength; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Strategy C1 — ArcGIS folder and service names.
 *
 * Municipal deployments almost always organise services by city, so a folder
 * called `Ahmedabad` is a strong, source-derived signal.
 */
export async function locationsFromArcGisDirectory(
  endpoint: DiscoveredEndpoint,
  budget: RequestBudget,
  signal?: AbortSignal,
): Promise<LocationRecord[]> {
  const url = new URL(endpoint.url.split('?')[0] ?? endpoint.url);
  url.searchParams.set('f', 'json');

  const response = await safeFetch(url.toString(), { budget, signal, accept: 'application/json' });
  if (!response.ok) return [];

  const directory = asJson<{ folders?: string[]; services?: Array<{ name?: string }> }>(response);
  if (!directory) return [];

  const out: LocationRecord[] = [];
  const seen = new Set<string>();

  for (const folder of directory.folders ?? []) {
    const name = cleanName(folder.replace(/[_-]+/g, ' '));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(makeLocation(name, 'city', null, response.finalUrl, 'folder'));
  }

  return out;
}

/**
 * Strategy C2 — distinct values of a place-name attribute on a layer.
 *
 * This is the most reliable source of village names, because it reads them out
 * of the boundary layer that actually defines them. ArcGIS can compute the
 * distinct set server-side, which keeps it to a single cheap request rather
 * than downloading every feature.
 */
export async function areasFromLayerAttribute(
  layer: LayerRecord,
  cityId: string | null,
  budget: RequestBudget,
  signal?: AbortSignal,
): Promise<{ areas: LocationRecord[]; field: string | null }> {
  if (!layer.serviceUrl.match(/(FeatureServer|MapServer)\/\d+$/i)) {
    return { areas: [], field: null };
  }

  const field = layer.fields.find((entry) => PLACE_FIELD.test(entry.name))?.name ?? null;
  if (!field) return { areas: [], field: null };

  const url = new URL(`${layer.serviceUrl}/query`);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', field);
  url.searchParams.set('returnDistinctValues', 'true');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('orderByFields', field);
  url.searchParams.set('f', 'json');

  const response = await safeFetch(url.toString(), { budget, signal, accept: 'application/json' });
  if (!response.ok) return { areas: [], field };

  const payload = asJson<{ features?: Array<{ attributes?: Record<string, unknown> }>; error?: unknown }>(response);
  if (!payload?.features || payload.error) return { areas: [], field };

  const seen = new Set<string>();
  const areas: LocationRecord[] = [];

  for (const entry of payload.features.slice(0, 5000)) {
    const raw = entry.attributes?.[field];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const name = cleanName(String(raw));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    areas.push(makeLocation(name, 'area', cityId, layer.serviceUrl, field));
  }

  return { areas, field };
}

/** Merge location lists, keeping the first provenance recorded for each name. */
export function mergeLocations(...lists: LocationRecord[][]): LocationRecord[] {
  const byKey = new Map<string, LocationRecord>();
  for (const list of lists) {
    for (const location of list) {
      const key = `${location.kind}:${location.parentId ?? ''}:${location.name.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, location);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Read the landing page once and apply both text-based strategies. */
export async function discoverLocationsFromPage(
  pageUrl: string,
  budget: RequestBudget,
  signal?: AbortSignal,
): Promise<LocationRecord[]> {
  const response = await safeFetch(pageUrl, { budget, signal, accept: 'text/html' });
  if (!response.ok) return [];
  const html = asText(response);
  return mergeLocations(
    locationsFromMarkup(html, response.finalUrl),
    locationsFromScriptData(html, response.finalUrl),
  );
}
