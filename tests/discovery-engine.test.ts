/**
 * The discovery engine's behaviour when the source does not make it easy.
 *
 * The cases here are the ones that produced an empty result against a live
 * site: a front-end that builds its URLs at runtime, a configuration payload
 * standing between the page and the data, an ArcGIS deployment that keeps
 * every service in a folder, and an operator who already knows the URL and
 * just wants it read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchRecorder, type Route } from './fixtures/mock-fetch';
import type { ObservedRequest } from '@/lib/discovery/types';

const HOST = 'https://map.example.gov';

/** Markup and bundle that between them name no data URL at all. */
const PAGE = `<!doctype html><html><head><title>City map</title></head>
<body><div id="map"></div><script src="/static/main.9f2a.js"></script></body></html>`;

const BUNDLE = `
  var p=["ap","i","/","v","1","/","par","cels"];
  var u=window.location.origin+"/"+p.join("");
  function draw(){fetch(u).then(function(r){return r.json()});}
`;

const PARCELS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { survey_no: '125/2', village: 'Vastral' },
      geometry: { type: 'Polygon', coordinates: [[[72.6, 23.0], [72.7, 23.0], [72.7, 23.1], [72.6, 23.0]]] },
    },
  ],
};

let recorder: FetchRecorder;
let observed: ObservedRequest[] = [];
let browserOk = true;

vi.mock('@/lib/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/net/safe-fetch')>();
  return {
    ...actual,
    safeFetch: (url: string, options: never) => recorder.fetch(url, options),
  };
});

vi.mock('@/lib/discovery/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/discovery/browser')>();
  return {
    ...actual,
    observeInBrowser: async () =>
      browserOk
        ? {
            ok: true as const,
            executablePath: '/usr/bin/chromium',
            finalUrl: `${HOST}/`,
            title: 'City map',
            requests: observed,
            blockedCount: 0,
            notes: [],
          }
        : {
            ok: false as const,
            reason: 'No Chrome, Chromium or Edge installation was found on this machine.',
            hint: 'Install one, or set TPM_BROWSER_PATH.',
          },
  };
});

const { runDiscoveryScan } = await import('@/lib/discovery/engine');

const BASE_ROUTES: Route[] = [
  { match: (url) => url.pathname === '/', respond: () => ({ text: PAGE, contentType: 'text/html' }) },
  {
    match: (url) => url.pathname === '/static/main.9f2a.js',
    respond: () => ({ text: BUNDLE, contentType: 'application/javascript' }),
  },
  {
    match: (url) => url.pathname === '/api/v1/parcels',
    respond: () => ({ json: PARCELS, contentType: 'application/geo+json' }),
  },
];

beforeEach(() => {
  recorder = new FetchRecorder(BASE_ROUTES);
  observed = [];
  browserOk = true;
});

describe('a front-end that builds its data URLs at runtime', () => {
  it('finds nothing by reading the page and its bundle as text', async () => {
    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });

    expect(scan.connected).toBe(true);
    expect(scan.geographicLayersDetected).toBe(false);
    expect(scan.endpoints.filter((endpoint) => endpoint.nature === 'vector')).toHaveLength(0);
    expect(recorder.urls).toContain(`${HOST}/static/main.9f2a.js`);
  });

  it('says so, and says what to do about it', async () => {
    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });
    const advice = scan.diagnostics?.advice.join('\n') ?? '';

    expect(scan.diagnostics?.mode).toBe('text');
    expect(advice).toContain('Watch the site in a browser');
    expect(advice).toContain('Network');
    expect(scan.diagnostics?.scriptsSeen).toBe(1);
    expect(scan.diagnostics?.scriptsRead).toBe(1);
  });

  it('finds the endpoint once the browser has watched the site load', async () => {
    observed = [
      {
        url: `${HOST}/api/v1/parcels`,
        method: 'GET',
        resourceType: 'fetch',
        status: 200,
        contentType: 'application/geo+json',
        bytes: 400,
      },
      {
        url: `${HOST}/static/logo.png`,
        method: 'GET',
        resourceType: 'image',
        status: 200,
        contentType: 'image/png',
        bytes: 900,
      },
    ];

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });

    expect(scan.diagnostics?.mode).toBe('browser');
    expect(scan.geographicLayersDetected).toBe(true);

    const parcels = scan.endpoints.find((endpoint) => endpoint.url === `${HOST}/api/v1/parcels`);
    expect(parcels).toBeDefined();
    expect(parcels?.nature).toBe('vector');
    expect(parcels?.kind).toBe('geojson');
    expect(parcels?.discoveredIn).toBe('the requests the site made in a browser');

    // The image was seen and deliberately not pursued; the record says so.
    expect(scan.diagnostics?.rejected.some((entry) => entry.url.endsWith('logo.png'))).toBe(true);
  });

  it('tells a network failure apart from a refusal by its own rules', async () => {
    observed = [
      {
        url: `${HOST}/api/v1/parcels`,
        method: 'GET',
        resourceType: 'fetch',
        status: null,
        contentType: null,
        bytes: null,
        failureReason: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      },
      {
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
        resourceType: 'fetch',
        status: null,
        contentType: null,
        bytes: null,
        blockedReason: 'Address 169.254.169.254 is in a private, loopback or reserved range.',
      },
    ];

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });
    const rejected = scan.diagnostics?.rejected ?? [];

    const networkFailure = rejected.find((entry) => entry.url.endsWith('/api/v1/parcels'));
    expect(networkFailure?.reason).toContain('failed on the network');
    expect(networkFailure?.reason).not.toContain('safety rules');

    const refused = rejected.find((entry) => entry.url.includes('169.254.169.254'));
    expect(refused?.reason).toContain('safety rules');

    // Neither became an endpoint: one never answered, the other never left.
    expect(scan.endpoints.some((endpoint) => endpoint.url.includes('169.254'))).toBe(false);
    expect(scan.endpoints.some((endpoint) => endpoint.url.endsWith('/api/v1/parcels'))).toBe(false);
  });

  it('accepts a verdict reached from the bytes the browser received', async () => {
    // The URL says nothing: no extension, no service path, no geographic word.
    // Only the response settles it, and the browser already has the response.
    const opaque = `${HOST}/g/7f3a2b`;
    observed = [
      {
        url: opaque,
        method: 'GET',
        resourceType: 'xhr',
        status: 200,
        contentType: 'application/json',
        bytes: 400,
        detected: {
          kind: 'geojson',
          nature: 'vector',
          evidence: ['Classified from the bytes the browser itself received, not from a second request.'],
        },
      },
    ];
    recorder = new FetchRecorder([
      ...BASE_ROUTES,
      { match: (url) => url.pathname === '/g/7f3a2b', respond: () => ({ json: PARCELS, contentType: 'application/json' }) },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });
    const found = scan.endpoints.find((endpoint) => endpoint.url === opaque);

    expect(found?.nature).toBe('vector');
    expect(found?.bodyVerified).toBe(true);
    expect(scan.geographicLayersDetected).toBe(true);
  });

  it('does not let a server-side probe overturn what the site actually received', async () => {
    // The endpoint answers the site with GeoJSON and answers a bare
    // server-side request with the application shell — a redirect to a sign-in
    // page, an error document, a single-page app index. That says something
    // about reading it from here, and nothing about what it serves.
    const url = `${HOST}/api/v1/parcels`;
    observed = [
      {
        url,
        method: 'GET',
        resourceType: 'fetch',
        status: 200,
        contentType: 'application/geo+json',
        bytes: 400,
        detected: { kind: 'geojson', nature: 'vector', evidence: ['Classified from the bytes the browser itself received, not from a second request.'] },
      },
    ];
    recorder = new FetchRecorder([
      { match: (url2) => url2.pathname === '/', respond: () => ({ text: PAGE, contentType: 'text/html' }) },
      {
        match: (url2) => url2.pathname === '/static/main.9f2a.js',
        respond: () => ({ text: BUNDLE, contentType: 'application/javascript' }),
      },
      {
        match: (url2) => url2.pathname === '/api/v1/parcels',
        respond: () => ({ text: '<!doctype html><html><body>Sign in</body></html>', contentType: 'text/html' }),
      },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });
    const found = scan.endpoints.find((endpoint) => endpoint.url === url);

    expect(found?.nature).toBe('vector');
    expect(found?.kind).toBe('geojson');
    expect(found?.evidence.join(' ')).toContain('answered differently');
  });

  it('spends its probes on data rather than on the application\u2019s own code', async () => {
    observed = [
      ...Array.from({ length: 30 }, (_, index) => ({
        url: `${HOST}/_next/static/chunks/${index}.js`,
        method: 'GET',
        resourceType: 'script',
        status: 200,
        contentType: 'application/javascript',
        bytes: 90_000,
      })),
      {
        url: `${HOST}/api/v1/parcels`,
        method: 'GET',
        resourceType: 'fetch',
        status: 200,
        contentType: 'application/geo+json',
        bytes: 400,
      },
    ];

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });

    expect(scan.endpoints.some((endpoint) => endpoint.url.includes('/chunks/'))).toBe(false);
    expect(scan.endpoints.some((endpoint) => endpoint.url.endsWith('/api/v1/parcels'))).toBe(true);
    expect(scan.geographicLayersDetected).toBe(true);
    // One probe, not thirty-one.
    expect(scan.diagnostics?.candidatesProbed).toBe(1);
  });

  it('reports the browser being unavailable rather than failing silently', async () => {
    browserOk = false;
    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: true });

    expect(scan.diagnostics?.browser?.attempted).toBe(true);
    expect(scan.diagnostics?.browser?.used).toBe(false);
    expect(scan.diagnostics?.browser?.reason).toContain('No Chrome');
    expect(scan.warnings.join(' ')).toContain('could not run');
    expect(scan.diagnostics?.advice.join(' ')).toContain('TPM_BROWSER_PATH');
    // The text pass still ran.
    expect(scan.connected).toBe(true);
  });
});

describe('a URL supplied by hand', () => {
  it('is probed without having to match any pattern', async () => {
    const opaque = `${HOST}/x/7f3a2b`;
    recorder = new FetchRecorder([
      ...BASE_ROUTES,
      { match: (url) => url.pathname === '/x/7f3a2b', respond: () => ({ json: PARCELS, contentType: 'application/json' }) },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false, seeds: [opaque] });

    const found = scan.endpoints.find((endpoint) => endpoint.url === opaque);
    expect(found).toBeDefined();
    expect(found?.discoveredIn).toBe('supplied by hand');
    // Classified from the body, not from the URL, which says nothing.
    expect(found?.nature).toBe('vector');
    expect(scan.diagnostics?.seeds).toEqual([opaque]);
  });
});

describe('one more level of indirection', () => {
  it('reads a configuration document for the services it names', async () => {
    const page = `<!doctype html><html><body>
      <script>window.__BOOT__={configUrl:"/api/v1/config"}</script>
      </body></html>`;

    recorder = new FetchRecorder([
      { match: (url) => url.pathname === '/', respond: () => ({ text: page, contentType: 'text/html' }) },
      {
        match: (url) => url.pathname === '/api/v1/config',
        respond: () => ({
          json: {
            title: 'City map',
            layers: [{ id: 'parcels', url: `${HOST}/gis/rest/services/Cadastre/FeatureServer/0` }],
          },
          contentType: 'application/json',
        }),
      },
      {
        match: (url) => url.pathname === '/gis/rest/services/Cadastre/FeatureServer/0',
        respond: () => ({
          json: { name: 'Cadastre', type: 'Feature Layer', geometryType: 'esriGeometryPolygon' },
          contentType: 'application/json',
        }),
      },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });

    const service = scan.endpoints.find((endpoint) => endpoint.url.includes('/FeatureServer/0'));
    expect(service).toBeDefined();
    expect(service?.discoveredIn).toBe('an application configuration document');
    expect(service?.nature).toBe('vector');
  });

  it('reads ArcGIS folders, not just the services at the root', async () => {
    const page = `<!doctype html><html><body>
      <a href="${HOST}/arcgis/rest/services">services</a></body></html>`;

    recorder = new FetchRecorder([
      { match: (url) => url.pathname === '/', respond: () => ({ text: page, contentType: 'text/html' }) },
      {
        match: (url) => url.pathname === '/arcgis/rest/services',
        respond: () => ({
          json: { currentVersion: 11.1, folders: ['TownPlanning'], services: [] },
          contentType: 'application/json',
        }),
      },
      {
        match: (url) => url.pathname === '/arcgis/rest/services/TownPlanning',
        respond: () => ({
          json: {
            currentVersion: 11.1,
            folders: [],
            services: [{ name: 'TownPlanning/TPScheme', type: 'FeatureServer' }],
          },
          contentType: 'application/json',
        }),
      },
      {
        match: (url) => url.pathname === '/arcgis/rest/services/TownPlanning/TPScheme/FeatureServer',
        respond: () => ({
          json: { currentVersion: 11.1, layers: [{ id: 0, name: 'Final Plots' }] },
          contentType: 'application/json',
        }),
      },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });

    const service = scan.endpoints.find((endpoint) => endpoint.url.endsWith('/TPScheme/FeatureServer'));
    expect(service).toBeDefined();
    expect(service?.discoveredIn).toContain('folder "TownPlanning"');
    expect(service?.nature).toBe('vector');
  });
});

describe('the diagnostic record', () => {
  it('keeps every document it fetched, with what each one answered', async () => {
    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });
    const documents = scan.diagnostics?.documents ?? [];

    const landing = documents.find((document) => document.role === 'landing');
    expect(landing?.ok).toBe(true);
    expect(landing?.status).toBe(200);

    const script = documents.find((document) => document.role === 'script');
    expect(script?.url).toBe(`${HOST}/static/main.9f2a.js`);
    expect(script?.bytes).toBeGreaterThan(0);
  });

  it('records a refusal as a refusal, without relabelling it', async () => {
    recorder = new FetchRecorder([
      { match: () => true, respond: () => ({ failure: 'auth-required', status: 403, reason: 'Upstream returned 403.' }) },
    ]);

    const scan = await runDiscoveryScan({ baseUrl: `${HOST}/`, useBrowser: false });

    expect(scan.connected).toBe(false);
    expect(scan.failure?.kind).toBe('auth-required');
    expect(scan.diagnostics?.advice.join(' ')).toContain('Nothing could be read');
    expect(scan.diagnostics?.documents[0]?.ok).toBe(false);
  });
});
