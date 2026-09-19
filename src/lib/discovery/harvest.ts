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
import type {
  DataNature,
  DiscoveredEndpoint,
  EndpointKind,
  ObservedRequest,
  RejectedCandidate,
} from './types';

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
  // --- further service software and gateways -------------------------------
  { pattern: /\b(mapproxy|geowebcache|gwc|tilecache|tileserver|martin|pg_?tileserv|pg_?featureserv)\b/i, why: 'tile or feature server software' },
  { pattern: /\/(gs|geoserver|geonode|mapstore|mapfish)\//i, why: 'geospatial server path' },
  { pattern: /\/(proxy|gisproxy|mapproxy)\b/i, why: 'map proxy path, which usually fronts a real service' },
  { pattern: /\/(geojson|wfs3|ogcapi|features)\//i, why: 'feature service path' },
  // --- Indian land-record and municipal vocabulary -------------------------
  { pattern: /\b(bhunaksha|bhulekh|anyror|jamabandi|mahabhulekh|e[-_]?dhara|revenue)\b/i, why: 'land-record system reference' },
  { pattern: /\b(nagar|palika|mahanagar|municipal|corporation|panchayat|taluk[ao]|tehsil|mandal|ward)\b/i, why: 'local-government term' },
  { pattern: /\b(final[-_]?plot|original[-_]?plot|fp[-_]?no|op[-_]?no|survey[-_]?no|block[-_]?no|gam[-_]?tal)\b/i, why: 'plot or survey-number term' },
  // --- generic data paths that a map front-end uses ------------------------
  { pattern: /\/(layers?|features?|boundar(y|ies)|geometr(y|ies)|shapes?|polygons?)(\/|\?|$)/i, why: 'data path naming geometry' },
  { pattern: /\/(gis|geo|spatial|maps?)(\/|\?|$)/i, why: 'geospatial path segment' },
  { pattern: /[?&](bbox|cql_filter|outfields|geometrytype|spatialrel|typenames?|layers?)=/i, why: 'spatial query parameter' },
];

/**
 * Documents that are not data themselves but usually name where the data is.
 *
 * A single-page application keeps its service URLs in a configuration payload,
 * so reading one of these turns an opaque bundle into a concrete endpoint list.
 */
const CONFIG_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\/(config|configuration|settings|bootstrap|init|runtime[-_.]?config|app[-_.]?config|env)[^/]*\.json(\?|$)/i,
    why: 'configuration document, which normally names the data services',
  },
  {
    pattern: /\/api\/(v\d+\/)?(config|configuration|settings|bootstrap|init|app|meta(data)?|catalog|manifest)\b/i,
    why: 'configuration or catalog API, which normally names the data services',
  },
  { pattern: /\/(webmap|web_map|mapconfig|map[-_.]?config|project\.json|capabilities)\b/i, why: 'map configuration document' },
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
  /**
   * A verdict already reached from the response's own bytes. Present only for
   * a request a browser watched and read; it supersedes any guess the URL
   * could support.
   */
  detection?: { kind: EndpointKind; nature: DataNature; evidence: string[] };
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

export function interestOf(url: string): string[] {
  const reasons: string[] = [];
  for (const { pattern, why } of INTEREST_PATTERNS) {
    if (pattern.test(url)) reasons.push(why);
  }
  for (const { pattern, why } of CONFIG_PATTERNS) {
    if (pattern.test(url)) reasons.push(why);
  }
  return reasons;
}

/** True when a URL looks like a configuration document worth expanding. */
export function looksLikeConfigDocument(url: string): boolean {
  return CONFIG_PATTERNS.some(({ pattern }) => pattern.test(url));
}

export function excluded(url: string): boolean {
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

export type HarvestOptions = {
  /**
   * Accept every URL that is not explicitly excluded, rather than only those
   * matching a known geospatial pattern. Used for URLs a browser watched the
   * site actually request, where the site's own behaviour is better evidence
   * than any pattern this tool could write.
   */
  acceptAll?: boolean;
  /** Called for each URL that was seen and not kept, with the reason. */
  onReject?: (rejection: RejectedCandidate) => void;
};

/**
 * Harvest candidate data URLs from one document's text.
 */
export function harvestCandidates(source: HarvestSource, options: HarvestOptions = {}): Candidate[] {
  const found = new Map<string, Candidate>();
  const reported = new Set<string>();

  const reject = (url: string, reason: string) => {
    if (!options.onReject || reported.has(url)) return;
    reported.add(url);
    options.onReject({ url, reason });
  };

  const consider = (raw: string, how: string) => {
    const url = normalise(raw, source.url);
    if (!url) {
      reject(raw.slice(0, 300), 'Not a usable http(s) URL.');
      return;
    }
    if (excluded(url)) {
      reject(url, 'Matched an exclusion rule: a static asset, tracker or account path.');
      return;
    }
    const reasons = interestOf(url);
    if (reasons.length === 0 && !options.acceptAll) {
      reject(url, 'Did not match any known geospatial service pattern.');
      return;
    }
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
      evidence: [
        `Found in ${source.label} (${how}).`,
        ...(reasons.length > 0
          ? reasons
          : ['Kept because the site itself requested it, not because its URL matched a pattern.']),
      ],
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
 * Turn requests a browser watched the site make into candidates.
 *
 * These carry more weight than anything harvested from text: the site asked
 * for them itself, so they are real endpoints by construction. The declared
 * content type is recorded as evidence, but it is not trusted as the answer —
 * the probe still reads the body before anything is called vector data.
 */
export function candidatesFromObservations(
  observations: ObservedRequest[],
  options: { onReject?: (rejection: RejectedCandidate) => void } = {},
): Candidate[] {
  const found = new Map<string, Candidate>();

  for (const observation of observations) {
    if (observation.blockedReason) {
      options.onReject?.({
        url: observation.url,
        reason: `Stopped by this tool’s safety rules: ${observation.blockedReason}`,
      });
      continue;
    }
    if (observation.failureReason) {
      options.onReject?.({
        url: observation.url,
        reason: `The request failed on the network: ${observation.failureReason}`,
      });
      continue;
    }
    if (excluded(observation.url)) {
      options.onReject?.({ url: observation.url, reason: 'Matched an exclusion rule: a static asset or tracker.' });
      continue;
    }
    if (found.has(observation.url)) continue;

    const evidence = [
      `The site itself requested this ${observation.resourceType} as ${observation.method} while the page was open.`,
    ];
    if (observation.status !== null) evidence.push(`It answered HTTP ${observation.status}.`);
    if (observation.contentType) evidence.push(`It declared content type ${observation.contentType}.`);
    if (observation.method !== 'GET') {
      evidence.push(
        `Observed as ${observation.method}. This tool only issues GET requests, so the endpoint may not answer ` +
          'the same way when probed.',
      );
    }
    evidence.push(...interestOf(observation.url));

    if (observation.detected) evidence.push(...observation.detected.evidence);

    found.set(observation.url, {
      url: observation.url,
      discoveredIn: 'the requests the site made in a browser',
      evidence,
      ...(observation.detected ? { detection: observation.detected } : {}),
    });
  }

  // The probe budget is finite, so what the bytes already said goes first,
  // then what the response declared, then everything else.
  const weight = (candidate: Candidate): number => {
    if (candidate.detection?.nature === 'vector') return 0;
    if (candidate.detection?.nature === 'metadata') return 1;
    if (candidate.detection?.nature === 'raster') return 3;
    if (candidate.detection) return 2;
    return 2;
  };

  return [...found.values()].sort((a, b) => weight(a) - weight(b));
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
      // A verdict from the bytes outranks anything the URL could suggest.
      const detection = candidate.detection ?? classifyUrl(candidate.url);
      return {
        id: `ep_${index}_${hash(candidate.url)}`,
        url: candidate.url,
        kind: detection.kind,
        nature: detection.nature,
        discoveredIn: candidate.discoveredIn,
        evidence: [...candidate.evidence, ...(candidate.detection ? [] : detection.evidence)],
        ...(candidate.detection ? { bodyVerified: true } : {}),
      } satisfies DiscoveredEndpoint;
    })
    .sort((a, b) => {
      // Anything already known to carry geometry is probed first.
      const byNature = (endpoint: DiscoveredEndpoint) => (endpoint.nature === 'vector' ? 0 : 1);
      return byNature(a) - byNature(b) || rank(a.kind) - rank(b.kind);
    });
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
