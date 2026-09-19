/**
 * The browser pass, driven against a single-page application that builds its
 * data URL at runtime.
 *
 * This is the failure the pass exists for. The page below never contains the
 * string `/api/v2/data` anywhere — it assembles it from fragments while it
 * runs — so reading the markup and the script as text finds nothing at all.
 * Watching the page load finds it immediately.
 *
 * The SSRF guard is mocked here, and only here, so the test can point a real
 * browser at a loopback server. The guard itself is covered by `ssrf.test.ts`
 * and `security.test.ts`; nothing in the product relaxes it.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/net/ssrf', () => ({
  assertSafeUrl: async (input: string | URL) => ({
    ok: true as const,
    url: input instanceof URL ? input : new URL(input),
    addresses: ['127.0.0.1'],
  }),
  isBlockedAddress: () => false,
}));

const { observeInBrowser, findBrowser, worthPursuing } = await import('@/lib/discovery/browser');
const { candidatesFromObservations, harvestCandidates, extractInlineScripts } = await import(
  '@/lib/discovery/harvest'
);

/**
 * The application script. The data URL exists only as a runtime concatenation,
 * exactly the way a bundled front-end emits one after minification.
 */
const APP_SCRIPT = `
  var segments = ['ap', 'i', '/', 'v', '2', '/', 'da', 'ta'];
  var layerId = String(3 * 7);
  var endpoint = location.origin + '/' + segments.join('') + '?layer=' + layerId;
  fetch(endpoint)
    .then(function (response) { return response.json(); })
    .then(function (collection) {
      document.title = 'features: ' + collection.features.length;
    });
`;

const PAGE = `<!doctype html>
<html><head><title>Municipal map</title></head>
<body>
  <div id="map"></div>
  <script src="/static/app.bundle.js"></script>
</body></html>`;

const FEATURES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { survey_no: '125/2' },
      geometry: { type: 'Polygon', coordinates: [[[72.5, 23.0], [72.6, 23.0], [72.6, 23.1], [72.5, 23.0]]] },
    },
  ],
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
      return;
    }
    if (path === '/static/app.bundle.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end(APP_SCRIPT);
      return;
    }
    if (path === '/api/v2/data') {
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(JSON.stringify(FEATURES));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('reading the page as text', () => {
  it('cannot see a URL the application builds at runtime', () => {
    expect(PAGE).not.toContain('/api/v2/data');
    expect(APP_SCRIPT).not.toContain('/api/v2/data');

    const fromMarkup = harvestCandidates({ url: `${origin}/`, text: PAGE, label: 'the landing page' });
    const fromScript = harvestCandidates({
      url: `${origin}/static/app.bundle.js`,
      text: APP_SCRIPT,
      label: 'the script app.bundle.js',
    });
    const inline = extractInlineScripts(PAGE);

    expect(inline).toHaveLength(0);
    expect([...fromMarkup, ...fromScript].map((candidate) => candidate.url)).not.toContain(
      `${origin}/api/v2/data?layer=21`,
    );
  });
});

// The browser pass needs a browser. Where none is installed the rest of the
// suite still runs; it is an optional capability, not a dependency.
const browserAvailable = findBrowser() !== null;

describe.skipIf(!browserAvailable)('watching the page in a browser', () => {
  it('records the request the application makes for itself', async () => {
    const observation = await observeInBrowser({ url: `${origin}/`, settleMs: 4_000 });

    if (!observation.ok) throw new Error(`the browser pass failed: ${observation.reason}`);

    const data = observation.requests.find((request) => request.url.includes('/api/v2/data'));
    expect(data, 'the runtime-built data URL should have been observed').toBeDefined();
    expect(data?.url).toBe(`${origin}/api/v2/data?layer=21`);
    expect(data?.status).toBe(200);
    expect(data?.contentType).toContain('geo+json');
    expect(data?.resourceType === 'fetch' || data?.resourceType === 'xhr').toBe(true);
  }, 90_000);

  it('turns what it saw into candidates the pipeline can probe', async () => {
    const observation = await observeInBrowser({ url: `${origin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);

    const pursued = observation.requests.filter(worthPursuing);
    const candidates = candidatesFromObservations(pursued);
    const found = candidates.find((candidate) => candidate.url.includes('/api/v2/data'));

    expect(found).toBeDefined();
    expect(found?.discoveredIn).toBe('the requests the site made in a browser');
    expect(found?.evidence.join(' ')).toContain('requested this');
  }, 90_000);

  it('appends its own identity to the browser user agent rather than hiding', async () => {
    const seen: string[] = [];
    const listener = createServer((request, response) => {
      seen.push(request.headers['user-agent'] ?? '');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>ok</body></html>');
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as AddressInfo).port;

    try {
      await observeInBrowser({ url: `http://127.0.0.1:${port}/`, settleMs: 1_000 });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('TownPlanMap-KML-Extractor');
    // The browser's own identity is kept intact alongside it: nothing is
    // disguised, and "Headless" is not scrubbed out.
    expect(seen[0]).toMatch(/Chrome|Chromium|Edg/);
  }, 90_000);
});
