/**
 * Candidate-URL harvesting.
 *
 * A modern map page keeps its data endpoints in three places: markup
 * attributes, inline bootstrap JSON, and bundled JavaScript. This module reads
 * all three as *text* — it never executes fetched script — and pulls out
 * anything that looks like it could serve geographic data.
 *
 * Harvesting deliberately over-collects; `probe` spends the request budget to
 * find out which candidates are real.
 */

import { classifyUrl } from '@/lib/geo/detect';
import type { DiscoveredEndpoint } from './types';

/** Absolute http(s) URLs and root/relative paths inside quotes. */
const ABSOLUTE_URL = /https?:\/\/[^\s"'`<>()\\]{4,400}/gi;
const QUOTED_PATH = /["'`](\/[A-Za-z0-9_\-./~%]{2,300}(?:\?[^"'`\s]{0,200})?)["'`]/g;
const SRC_HREF = /\b(?:src|href|data-url|data-src|data-service|data-layer-url)\s*=\s*["']([^"']{2,400})["']/gi;

/** Words that make a URL worth probing. */
const INTEREST_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\/rest\/services\//i, why: 'ArcGIS REST services path' },
  { pattern: /(featureserver|mapserver|imageserver)/i, why: 'ArcGIS service type in the path' },
  { pattern: /\bgeoserver\b/i, why: 'GeoServer instance' },
  { pattern: /\bmapserv(er)?\b/i, why: 'MapServer CGI' },
  { pattern: /\bqgis(server)?\b/i, why: 'QGIS Server' },
  { pattern: /service=(wfs|wms|wmts)/i, why: 'OGC service parameter' },
  { pattern: /\/(wfs|wms|wmts|ows)(\?|\/|$)/i, why: 'OGC service path' },
  { pattern: /\/collections\/[^/]+\/items/i, why: 'OGC API Features items path' },
  { pattern: /\.geojson(\?|$)/i, why: 'GeoJSON file' },
  { pattern: /geojson/i, why: 'mentions GeoJSON' },
  { pattern: /\.topojson(\?|$)/i, why: 'TopoJSON file' },
  { pattern: /\.kmz?(\?|$)/i, why: 'KML/KMZ file' },
  { pattern: /\.gpkg(\?|$)/i, why: 'GeoPackage file' },
  { pattern: /\{z\}|\{x\}|\{y\}/i, why: 'tile URL template' },
  { pattern: /\.(pbf|mvt)(\?|$)/i, why: 'vector tile' },
  { pattern: /style\.json|\/styles?\//i, why: 'map style document' },
  { pattern: /tile\.?json/i, why: 'TileJSON' },
  { pattern: /\/tiles?\//i, why: 'tile path' },
  { pattern: /\b(parcel|survey|khasra|cadastr|plot|boundary|village|taluka|district)\b/i, why: 'cadastral or administrative term' },
  { pattern: /\b(tp[_-]?scheme|townplan|town_plan|dp[_-]?zone|development[_-]?plan|zoning|landuse|land_use)\b/i, why: 'planning term' },
  { pattern: /\/api\/.*\b(map|geo|layer|feature|spatial|gis)\b/i, why: 'geospatial-looking API path' },
  { pattern: /\b(arcgis|esri|mapbox|maptiler|openlayers|leaflet|maplibre)\b/i, why: 'mapping platform reference' },
];

/** Things that are never worth a request. */
const EXCLUSION_PATTERNS: RegExp[] = [
  /\.(css|woff2?|ttf|eot|otf|ico|svg|mp4|webm|mp3|pdf|txt|xml\.gz)(\?|$)/i,
  /\b(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|sentry\.io|segment\.(io|com))\b/i,
  /\/(login|signin|signup|register|logout|account|checkout|payment|subscribe|billing)\b/i,
  /^data:/i,
  /^blob:/i,
  /^javascript:/i,
  /\bw3\.org\b|\bschema\.org\b|\bopengis\.net\/def\b/i,
];

export type HarvestSource = {
  /** URL of the document the text came from. */
  url: string;
  text: string;
  /** How the document was reached. */
  label: string;
};

export type Candidate = {
  url: string;
  discoveredIn: string;
  evidence: string[];
};

function normalise(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function interestOf(url: string): string[] {
  const reasons: string[] = [];
  for (const { pattern, why } of INTEREST_PATTERNS) {
    if (pattern.test(url)) reasons.push(why);
  }
  return reasons;
}

function excluded(url: string): boolean {
  return EXCLUSION_PATTERNS.some((pattern) => pattern.test(url));
}

/** Pull every script URL out of an HTML document so the bundles can be read. */
export function extractScriptUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const scriptTag = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptTag.exec(html)) !== null) {
    const resolved = match[1] ? normalise(match[1], baseUrl) : null;
    if (resolved && !excluded(resolved)) out.add(resolved);
  }
  return [...out];
}

/** Inline `<script>` bodies, which frequently hold the bootstrap configuration. */
export function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  const inline = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]{0,400000}?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = inline.exec(html)) !== null) {
    if (match[1]?.trim()) out.push(match[1]);
  }
  return out;
}

/**
 * Harvest candidate data URLs from one document's text.
 */
export function harvestCandidates(source: HarvestSource): Candidate[] {
  const found = new Map<string, Candidate>();

  const consider = (raw: string, how: string) => {
    const url = normalise(raw, source.url);
    if (!url || excluded(url)) return;
    const reasons = interestOf(url);
    if (reasons.length === 0) return;
    const existing = found.get(url);
    if (existing) {
      for (const reason of reasons) {
        if (!existing.evidence.includes(reason)) existing.evidence.push(reason);
      }
      return;
    }
    found.set(url, {
      url,
      discoveredIn: source.label,
      evidence: [`Found in ${source.label} (${how}).`, ...reasons],
    });
  };

  for (const match of source.text.matchAll(ABSOLUTE_URL)) {
    consider(match[0].replace(/[),;.'"]+$/, ''), 'absolute URL');
  }
  for (const match of source.text.matchAll(QUOTED_PATH)) {
    if (match[1]) consider(match[1], 'quoted path');
  }
  for (const match of source.text.matchAll(SRC_HREF)) {
    if (match[1]) consider(match[1], 'markup attribute');
  }

  return [...found.values()];
}

/**
 * Turn candidates into endpoint records with a provisional classification.
 * Ranked so the highest-value services are probed first when the budget is
 * tight.
 */
export function toEndpoints(candidates: Candidate[]): DiscoveredEndpoint[] {
  const rank = (kind: string): number => {
    switch (kind) {
      case 'arcgis-feature-server':
        return 0;
      case 'ogc-wfs':
        return 1;
      case 'ogc-api-features':
        return 2;
      case 'geojson':
        return 3;
      case 'arcgis-rest-root':
        return 4;
      case 'arcgis-map-server':
        return 5;
      case 'maplibre-style':
        return 6;
      case 'tilejson':
        return 7;
      case 'vector-tiles':
        return 8;
      case 'kml':
      case 'kmz':
        return 9;
      case 'topojson':
        return 10;
      case 'unknown':
        return 11;
      default:
        return 12;
    }
  };

  return candidates
    .map((candidate, index) => {
      const detection = classifyUrl(candidate.url);
      return {
        id: `ep_${index}_${hash(candidate.url)}`,
        url: candidate.url,
        kind: detection.kind,
        nature: detection.nature,
        discoveredIn: candidate.discoveredIn,
        evidence: [...candidate.evidence, ...detection.evidence],
      } satisfies DiscoveredEndpoint;
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Short stable id fragment for a URL. */
export function hash(value: string): string {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
