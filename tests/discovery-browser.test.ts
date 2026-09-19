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
const { runDiscoveryScan } = await import('@/lib/discovery/engine');
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

  it('identifies the response from the bytes it received, without a second request', async () => {
    const observation = await observeInBrowser({ url: `${origin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);

    const data = observation.requests.find((request) => request.url.includes('/api/v2/data'));
    expect(data?.detected?.nature).toBe('vector');
    expect(data?.detected?.kind).toBe('geojson');
    expect(data?.detected?.evidence.join(' ')).toContain('bytes the browser itself received');
    expect(worthPursuing(data!)).toBe(true);
  }, 90_000);

  it('does not treat the application\u2019s own code as a data endpoint', async () => {
    const observation = await observeInBrowser({ url: `${origin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);

    const bundle = observation.requests.find((request) => request.url.endsWith('app.bundle.js'));
    expect(bundle, 'the bundle should have been observed').toBeDefined();
    expect(bundle?.resourceType).toBe('script');

    // A code-split application ships dozens of these. Probing them spends the
    // whole budget on learning that JavaScript is JavaScript, and crowds the
    // real endpoints out of the queue.
    expect(worthPursuing(bundle!)).toBe(false);
    expect(observation.requests.filter(worthPursuing).every((request) => request.resourceType !== 'script')).toBe(
      true,
    );
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

describe.skipIf(!browserAvailable)('the whole scan, end to end', () => {
  it('turns a runtime-built URL into an exportable vector endpoint', async () => {
    const textOnly = await runDiscoveryScan({ baseUrl: `${origin}/`, useBrowser: false });
    expect(textOnly.connected).toBe(true);
    expect(textOnly.geographicLayersDetected, 'a text read cannot find it').toBe(false);
    expect(textOnly.diagnostics?.advice.join(' ')).toContain('Watch the site in a browser');

    const watched = await runDiscoveryScan({ baseUrl: `${origin}/`, useBrowser: true, browserSettleMs: 4_000 });

    expect(watched.diagnostics?.mode).toBe('browser');
    expect(watched.geographicLayersDetected, 'watching the site finds it').toBe(true);

    const parcels = watched.endpoints.find((endpoint) => endpoint.url.includes('/api/v2/data'));
    expect(parcels?.nature).toBe('vector');
    expect(parcels?.kind).toBe('geojson');
    expect(parcels?.bodyVerified).toBe(true);
    expect(parcels?.probe?.reachable).toBe(true);

    // The bundle the page loads is never mistaken for an endpoint.
    expect(watched.endpoints.some((endpoint) => endpoint.url.endsWith('app.bundle.js'))).toBe(false);
  }, 120_000);
});

/**
 * A source that returns its geometry only to a session that is signed in.
 *
 * This is the shape that matters most: the data is there, the person is
 * entitled to it, and a bare server-side request has no standing to ask for
 * it. The window signs itself in, the site fetches its data, and the bytes are
 * kept — with no credential kept alongside them.
 */
describe.skipIf(!browserAvailable)('a source that only answers a signed-in session', () => {
  const SESSION = 'tpm_session=abc123';

  const PLOTS = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { final_plot_no: '12', village: 'Vastral' },
        geometry: { type: 'Polygon', coordinates: [[[72.63, 23.01], [72.64, 23.01], [72.64, 23.02], [72.63, 23.01]]] },
      },
    ],
  };

  const APP = `
    fetch('/api/plots', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { document.title = c ? 'plots: ' + c.features.length : 'denied'; });
  `;

  let secured: Server;
  let securedOrigin: string;
  const unauthenticatedAttempts: string[] = [];

  beforeAll(async () => {
    secured = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0];
      const cookie = request.headers.cookie ?? '';

      if (path === '/') {
        // The landing page signs the visitor in, standing in for the person
        // typing their own credentials into the source's own form.
        response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `${SESSION}; Path=/` });
        response.end('<!doctype html><html><head><title>Secured map</title></head><body><script>' + APP + '</script></body></html>');
        return;
      }
      if (path === '/api/plots') {
        if (!cookie.includes('tpm_session=')) {
          unauthenticatedAttempts.push(path);
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end('{"error":"sign in required"}');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/geo+json' });
        response.end(JSON.stringify(PLOTS));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => secured.listen(0, '127.0.0.1', resolve));
    securedOrigin = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => secured.close(() => resolve()));
  });

  it('keeps the geometry the source returned to the signed-in session', async () => {
    const observation = await observeInBrowser({ url: `${securedOrigin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);

    const captured = observation.captured.find((entry) => entry.url.includes('/api/plots'));
    expect(captured, 'the response should have been kept whole').toBeDefined();
    expect(captured?.carriedSession, 'the request it watched was an authenticated one').toBe(true);

    const document = JSON.parse(new TextDecoder().decode(captured!.bytes)) as typeof PLOTS;
    expect(document.features).toHaveLength(1);
    expect(document.features[0]?.properties.final_plot_no).toBe('12');
    expect(document.features[0]?.geometry.coordinates[0]?.[0]).toEqual([72.63, 23.01]);
  }, 120_000);

  it('reads it back into features without asking the source again', async () => {
    const observation = await observeInBrowser({ url: `${securedOrigin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);
    const captured = observation.captured.find((entry) => entry.url.includes('/api/plots'))!;

    const before = unauthenticatedAttempts.length;
    const { readCapturedDocument } = await import('@/lib/discovery/captured');
    const read = await readCapturedDocument({
      record: {
        id: 'cap_plots',
        url: captured.url,
        contentType: captured.contentType,
        kind: captured.kind,
        byteLength: captured.bytes.byteLength,
        capturedAt: new Date().toISOString(),
        carriedSession: captured.carriedSession,
      },
      bytes: captured.bytes,
    });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.features).toHaveLength(1);
    expect(read.features[0]?.properties.village).toBe('Vastral');

    // Nothing went back to the source: no request at all, let alone one
    // without the session that was entitled to the data.
    expect(unauthenticatedAttempts.length).toBe(before);
  }, 120_000);

  it('keeps no credential alongside the data it kept', async () => {
    const observation = await observeInBrowser({ url: `${securedOrigin}/`, settleMs: 4_000 });
    if (!observation.ok) throw new Error(observation.reason);

    // The captured record says the request was authenticated. It does not, and
    // must not, carry what authenticated it.
    const serialised = JSON.stringify(
      observation.captured.map((entry) => ({ ...entry, bytes: undefined })),
    );
    expect(serialised).not.toContain('abc123');
    expect(serialised).not.toContain('tpm_session');
    expect(JSON.stringify(observation.requests)).not.toContain('abc123');
  }, 120_000);
});
