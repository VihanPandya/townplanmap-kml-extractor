/**
 * Central runtime limits and settings.
 *
 * Everything that touches the network or produces a file is bounded here so the
 * Settings screen can show a single, honest list of what the tool will and will
 * not do. Values may be overridden with environment variables; each override is
 * clamped to a hard ceiling that cannot be raised from the environment.
 */

function intFromEnv(name: string, fallback: number, hardMax: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, hardMax);
}

export const LIMITS = {
  /** Requests a single discovery scan may issue against the source. */
  maxRequestsPerScan: intFromEnv('TPM_MAX_REQUESTS_PER_SCAN', 60, 400),
  /** Bytes accepted from any one response before the transfer is aborted. */
  maxResponseBytes: intFromEnv('TPM_MAX_RESPONSE_BYTES', 24 * 1024 * 1024, 128 * 1024 * 1024),
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: intFromEnv('TPM_REQUEST_TIMEOUT_MS', 20_000, 120_000),
  /** Simultaneous outbound requests. */
  maxConcurrentRequests: intFromEnv('TPM_MAX_CONCURRENT_REQUESTS', 4, 16),
  /** Redirect hops followed before a fetch is rejected. */
  maxRedirects: intFromEnv('TPM_MAX_REDIRECTS', 3, 10),
  /** Features retained from a single layer. */
  maxFeaturesPerLayer: intFromEnv('TPM_MAX_FEATURES_PER_LAYER', 50_000, 500_000),
  /** Features allowed into one export job. */
  maxFeaturesPerExport: intFromEnv('TPM_MAX_FEATURES_PER_EXPORT', 100_000, 1_000_000),
  /** Ceiling on a generated KML document, in bytes. */
  maxKmlBytes: intFromEnv('TPM_MAX_KML_BYTES', 256 * 1024 * 1024, 1024 * 1024 * 1024),
  /** Coordinate pairs allowed in one geometry before it is rejected as hostile. */
  maxVerticesPerGeometry: intFromEnv('TPM_MAX_VERTICES_PER_GEOMETRY', 2_000_000, 10_000_000),
  /** Bytes of XML accepted by the safe parser. */
  maxXmlBytes: intFromEnv('TPM_MAX_XML_BYTES', 32 * 1024 * 1024, 128 * 1024 * 1024),
  /** Page size used when paging a remote feature service. */
  featurePageSize: intFromEnv('TPM_FEATURE_PAGE_SIZE', 1000, 5000),
  /** Minimum milliseconds between two requests to the same host. */
  perHostThrottleMs: intFromEnv('TPM_PER_HOST_THROTTLE_MS', 120, 10_000),

  // --- preservation of original KML/KMZ files ------------------------------
  /** Original files preserved in a single sweep. */
  maxPreservedFiles: intFromEnv('TPM_MAX_PRESERVED_FILES', 250, 5_000),
  /** Bytes accepted for one preserved file. */
  maxPreservedFileBytes: intFromEnv('TPM_MAX_PRESERVED_FILE_BYTES', 64 * 1024 * 1024, 256 * 1024 * 1024),
  /** How deep a NetworkLink chain is followed before the sweep stops. */
  maxNetworkLinkDepth: intFromEnv('TPM_MAX_NETWORK_LINK_DEPTH', 4, 12),
  /** Requests a preservation sweep may issue. */
  maxRequestsPerSweep: intFromEnv('TPM_MAX_REQUESTS_PER_SWEEP', 200, 2_000),
} as const;

export type Limits = typeof LIMITS;

/** The upstream this build is pointed at. Overridable for self-hosted mirrors. */
export const SOURCE = {
  name: 'TownPlanMap',
  baseUrl: process.env.TPM_BASE_URL ?? 'https://townplanmap.com',
  homepage: 'https://townplanmap.com',
} as const;

/**
 * User agent sent upstream. It identifies the tool honestly rather than
 * impersonating a browser: this tool does not defeat bot detection.
 */
export const USER_AGENT =
  process.env.TPM_USER_AGENT ??
  'TownPlanMap-KML-Extractor/1.0 (+https://github.com/vihanpandya/townplanmap-kml-extractor)';

/**
 * Opt-in synthetic dataset for offline development and demos. It is OFF unless
 * explicitly enabled, and everything it produces is labelled as synthetic all
 * the way through to the exported KML so it can never be mistaken for data that
 * came from the source.
 */
export const FIXTURE_SOURCE_ENABLED = process.env.TPM_ENABLE_FIXTURE_SOURCE === '1';

export const LEGAL_NOTICE =
  'This tool extracts or converts geographic information that is publicly accessible through the ' +
  'authorised source. Users are responsible for complying with TownPlanMap’s terms, applicable ' +
  'licences, copyright, database rights and other applicable laws. Extracted geographic data should ' +
  'be independently verified before use in legal, surveying, property or other high-stakes decisions.';
