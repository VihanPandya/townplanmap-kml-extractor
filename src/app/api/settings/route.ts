/**
 * GET /api/settings — the limits and policies in force, for the Settings screen.
 *
 * Read-only: limits are configured through environment variables so they cannot
 * be raised from the browser.
 */

import { LIMITS, SOURCE, USER_AGENT, FIXTURE_SOURCE_ENABLED, LEGAL_NOTICE } from '@/lib/config';
import { getStore } from '@/lib/db';
import { handler, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = await getStore();

  return ok({
    source: SOURCE,
    userAgent: USER_AGENT,
    fixtureSourceEnabled: FIXTURE_SOURCE_ENABLED,
    legalNotice: LEGAL_NOTICE,
    storage: { kind: store.kind, durable: store.durable, description: store.describe() },
    limits: [
      { name: 'Maximum requests per scan', value: LIMITS.maxRequestsPerScan, env: 'TPM_MAX_REQUESTS_PER_SCAN' },
      { name: 'Maximum response size', value: `${(LIMITS.maxResponseBytes / (1024 * 1024)).toFixed(0)} MB`, env: 'TPM_MAX_RESPONSE_BYTES' },
      { name: 'Request timeout', value: `${(LIMITS.requestTimeoutMs / 1000).toFixed(0)} s`, env: 'TPM_REQUEST_TIMEOUT_MS' },
      { name: 'Concurrent requests', value: LIMITS.maxConcurrentRequests, env: 'TPM_MAX_CONCURRENT_REQUESTS' },
      { name: 'Redirects followed', value: LIMITS.maxRedirects, env: 'TPM_MAX_REDIRECTS' },
      { name: 'Maximum features per layer', value: LIMITS.maxFeaturesPerLayer.toLocaleString(), env: 'TPM_MAX_FEATURES_PER_LAYER' },
      { name: 'Maximum features per export', value: LIMITS.maxFeaturesPerExport.toLocaleString(), env: 'TPM_MAX_FEATURES_PER_EXPORT' },
      { name: 'Maximum KML size', value: `${(LIMITS.maxKmlBytes / (1024 * 1024)).toFixed(0)} MB`, env: 'TPM_MAX_KML_BYTES' },
      { name: 'Maximum vertices per geometry', value: LIMITS.maxVerticesPerGeometry.toLocaleString(), env: 'TPM_MAX_VERTICES_PER_GEOMETRY' },
      { name: 'Maximum XML document size', value: `${(LIMITS.maxXmlBytes / (1024 * 1024)).toFixed(0)} MB`, env: 'TPM_MAX_XML_BYTES' },
      { name: 'Feature page size', value: LIMITS.featurePageSize.toLocaleString(), env: 'TPM_FEATURE_PAGE_SIZE' },
      { name: 'Per-host throttle', value: `${LIMITS.perHostThrottleMs} ms`, env: 'TPM_PER_HOST_THROTTLE_MS' },
    ],
    policies: [
      'Only http:// and https:// URLs are fetched. file://, ftp:// and every other scheme is refused.',
      'Requests to loopback, private, link-local, CGNAT and cloud-metadata addresses are blocked, by hostname and by every resolved address.',
      'Redirects are followed manually and each hop is re-validated against the same rules.',
      'Responses are capped and the transfer is aborted once the cap is passed.',
      'XML documents declaring a DOCTYPE or entities are rejected before parsing.',
      'Authentication, paywalls, access tokens, anti-bot systems and rate limits are never circumvented. A 401 or 403 is reported, not worked around.',
      'The tool identifies itself honestly in its User-Agent and does not impersonate a browser.',
    ],
  });
});
