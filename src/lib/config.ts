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
  maxRequestsPerScan: intFromEnv('TPM_MAX_REQUESTS_PER_SCAN', 150, 400),
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

  // --- discovery breadth ---------------------------------------------------
  /**
   * JavaScript bundles read during a scan. A code-split application can ship
   * its map configuration in a chunk well down the list, so this is generous
   * rather than minimal; bundles are read as text and never executed.
   */
  maxScriptsRead: intFromEnv('TPM_MAX_SCRIPTS_READ', 16, 80),
  /** Candidate URLs a scan will spend a probe request on. */
  maxProbes: intFromEnv('TPM_MAX_PROBES', 40, 200),
  /**
   * Non-geographic JSON documents expanded for further candidates. A bootstrap
   * or configuration endpoint usually names the real data services.
   */
  maxConfigDocuments: intFromEnv('TPM_MAX_CONFIG_DOCUMENTS', 10, 50),
  /** Rejected candidate URLs retained for the diagnostics screen. */
  maxDiagnosticEntries: intFromEnv('TPM_MAX_DIAGNOSTIC_ENTRIES', 300, 2_000),

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

/**
 * Browser-assisted discovery.
 *
 * Reading a page's markup and scripts as text finds nothing when the
 * application builds its data URLs at runtime, which is how most modern map
 * front-ends work. Opening the page in a real browser and recording the
 * requests *it* makes is the only reliable way to see those URLs.
 *
 * This is opt-in, uses a browser already installed on the machine, and does
 * nothing to disguise itself: no stealth patches, no credentials, no cookies
 * carried in, and the tool's own token is appended to the browser's user
 * agent so the source can see exactly what visited it.
 */
export const BROWSER = {
  /** Whether a scan uses the browser unless the caller says otherwise. */
  enabledByDefault: process.env.TPM_BROWSER_SCAN === '1',
  /** Explicit path to a Chrome, Chromium or Edge executable. */
  executablePath: process.env.TPM_BROWSER_PATH ?? null,
  /** Run with a visible window, which is useful when watching a scan. */
  headless: process.env.TPM_BROWSER_HEADED !== '1',
  /** How long to wait for the first load before giving up. */
  navigationTimeoutMs: intFromEnv('TPM_BROWSER_TIMEOUT_MS', 45_000, 180_000),
  /** How long to keep listening after load, for data fetched asynchronously. */
  settleMs: intFromEnv('TPM_BROWSER_SETTLE_MS', 9_000, 120_000),
  /**
   * How long to keep recording when the window is visible.
   *
   * A visible window is there to be driven: some maps load nothing until a
   * city is chosen or a parcel clicked, and no automated page load reproduces
   * that. Recording continues until the window is closed or this runs out.
   */
  headedSettleMs: intFromEnv('TPM_BROWSER_HEADED_SETTLE_MS', 300_000, 1_800_000),
  /** Requests recorded from one page visit. */
  maxObservedRequests: intFromEnv('TPM_BROWSER_MAX_REQUESTS', 500, 5_000),

  /**
   * Geographic responses kept from one visit, and the size of each.
   *
   * When the window is signed in, the data the site returns is data the person
   * using it is authorised to see. Keeping those bytes is what makes it usable
   * without ever asking the server to repeat a request it has no standing to
   * make.
   */
  maxCapturedResponses: intFromEnv('TPM_BROWSER_MAX_CAPTURED', 400, 5_000),
  maxCapturedBytes: intFromEnv('TPM_BROWSER_MAX_CAPTURED_BYTES', 64 * 1024 * 1024, 512 * 1024 * 1024),
} as const;

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
