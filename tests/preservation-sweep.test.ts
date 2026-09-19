/**
 * The preservation sweep, driven against a mock source.
 *
 * Exercises the part that reaches resources the visible interface never
 * offers: a root KML whose NetworkLinks lead to further documents, which lead
 * to more, none of which appear in any page or script.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { FetchRecorder } from './fixtures/mock-fetch';

const HOST = 'https://gis.example.org';

/** The root index, linked from the page. Points at two wards and a nested doc. */
const ROOT_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>Ward index</name>
  <NetworkLink><name>Ward 1</name><Link><href>wards/ward-1.kml</href></Link></NetworkLink>
  <NetworkLink><name>Ward 2</name><Link><href>${HOST}/wards/ward-2.kmz</href></Link></NetworkLink>
  <NetworkLink><name>Restricted</name><Link><href>${HOST}/private/internal.kml</href></Link></NetworkLink>
</Document></kml>`;

/** Ward 1 links deeper still, and back to the root (a cycle). */
const WARD_1 = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>Ward 1 parcels</name>
  <NetworkLink><name>Block A</name><Link><href>ward-1-block-a.kml</href></Link></NetworkLink>
  <NetworkLink><name>Back to index</name><Link><href>${HOST}/index.kml</href></Link></NetworkLink>
  <Placemark><name>Survey 125/2</name>
    <Polygon><outerBoundaryIs><LinearRing>
      <coordinates>72.5,23.0 72.51,23.0 72.51,23.01 72.5,23.0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Document></kml>`;

const BLOCK_A = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>Ward 1 Block A</name>
  <Placemark><name>Survey 126/1</name>
    <Point><coordinates>72.52,23.02</coordinates></Point>
  </Placemark>
</Document></kml>`;

let ward2Archive: Uint8Array;

const recorder = new FetchRecorder([
  {
    match: (url) => url.pathname === '/index.kml',
    respond: () => ({ text: ROOT_KML, contentType: 'application/vnd.google-earth.kml+xml' }),
  },
  {
    match: (url) => url.pathname === '/wards/ward-1.kml',
    respond: () => ({ text: WARD_1, contentType: 'application/vnd.google-earth.kml+xml' }),
  },
  {
    match: (url) => url.pathname === '/wards/ward-1-block-a.kml',
    respond: () => ({ text: BLOCK_A, contentType: 'application/vnd.google-earth.kml+xml' }),
  },
  {
    // The same bytes as the root, served from a second URL.
    match: (url) => url.pathname === '/mirror/index.kml',
    respond: () => ({ text: ROOT_KML, contentType: 'application/vnd.google-earth.kml+xml' }),
  },
  {
    match: (url) => url.pathname === '/private/internal.kml',
    respond: () => ({ failure: 'auth-required' as const, status: 403 }),
  },
  {
    match: (url) => url.pathname === '/not-really.kml',
    respond: () => ({ text: '<html><body>Login required</body></html>', contentType: 'text/html' }),
  },
]);

vi.mock('@/lib/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/net/safe-fetch')>();
  return {
    ...actual,
    safeFetch: async (target: string, options: unknown) => {
      // The KMZ is binary, so it is served outside the text-based recorder.
      if (target.endsWith('/wards/ward-2.kmz')) {
        recorder.requests.push({ url: target, method: 'GET' });
        return {
          ok: true as const,
          url: target,
          finalUrl: target,
          status: 200,
          contentType: 'application/vnd.google-earth.kmz',
          bytes: ward2Archive.byteLength,
          body: ward2Archive,
          headers: { 'content-type': 'application/vnd.google-earth.kmz' },
          truncated: false,
          elapsedMs: 1,
          redirects: [],
        };
      }
      return recorder.fetch(target, options as never);
    },
  };
});

const { runPreservationSweep } = await import('@/lib/preservation/sweep');
const { RequestBudget } = await import('@/lib/net/budget');

function seeds(...urls: string[]) {
  return urls.map((url) => ({ url, route: 'page-markup' as const, discoveredIn: 'the landing page' }));
}

beforeEach(async () => {
  recorder.reset();
  const zip = new JSZip();
  zip.file('doc.kml', BLOCK_A.replace('Block A', 'Ward 2'));
  zip.file('files/overlay.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]));
  ward2Archive = await zip.generateAsync({ type: 'uint8array' });
});

describe('following NetworkLinks', () => {
  it('reaches documents that are only referenced from inside other KML', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    const urls = sweep.preserved.map((file) => file.url);
    expect(urls).toContain(`${HOST}/index.kml`);
    expect(urls).toContain(`${HOST}/wards/ward-1.kml`);
    expect(urls).toContain(`${HOST}/wards/ward-2.kmz`);
    // Two levels deep, and never mentioned anywhere but inside ward-1.
    expect(urls).toContain(`${HOST}/wards/ward-1-block-a.kml`);
  });

  it('resolves relative hrefs against the document that declared them', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });
    // `ward-1-block-a.kml` is relative to /wards/, not to the site root.
    expect(sweep.preserved.map((file) => file.url)).toContain(`${HOST}/wards/ward-1-block-a.kml`);
  });

  it('records the route and depth so the find can be retraced', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    const blockA = sweep.preserved.find((file) => file.url.endsWith('ward-1-block-a.kml'));
    expect(blockA?.route).toBe('network-link');
    expect(blockA?.depth).toBe(2);
    expect(blockA?.discoveredIn).toMatch(/NetworkLink inside/i);

    const ward1 = sweep.preserved.find((file) => file.url.endsWith('ward-1.kml'));
    expect(blockA?.parentId).toBe(ward1?.id);
  });

  it('says how many files the visible interface does not offer', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });
    expect(sweep.notes.join(' ')).toMatch(/not offered anywhere in the visible interface/i);
  });

  it('does not loop on a cycle back to a document already preserved', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });
    const indexCount = sweep.preserved.filter((file) => file.url === `${HOST}/index.kml`).length;
    expect(indexCount).toBe(1);
  });

  it('stops at the configured link depth', async () => {
    vi.stubEnv('TPM_MAX_NETWORK_LINK_DEPTH', '1');
    vi.resetModules();
    const { runPreservationSweep: bounded } = await import('@/lib/preservation/sweep');

    const sweep = await bounded({ seeds: seeds(`${HOST}/index.kml`), budget: new RequestBudget(50, 4, 0) });
    // Depth 1 reaches the wards but not what they link to.
    expect(sweep.preserved.map((file) => file.url)).not.toContain(`${HOST}/wards/ward-1-block-a.kml`);
    expect(sweep.notes.join(' ')).toMatch(/depth limit/i);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('what a sweep refuses to do', () => {
  it('records an authorisation refusal without working around it', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    const refusal = sweep.failures.find((failure) => failure.url.includes('/private/'));
    expect(refusal?.kind).toBe('auth-required');
    expect(refusal?.reason).toMatch(/requires authorised access/i);
    expect(refusal?.reason).toMatch(/No attempt was made to work around that/i);

    // And it was tried exactly once.
    const attempts = recorder.urls.filter((url) => url.includes('/private/')).length;
    expect(attempts).toBe(1);
  });

  it('does not preserve a login page dressed up as a .kml', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/not-really.kml`),
      budget: new RequestBudget(20, 4, 0),
    });

    expect(sweep.preserved).toHaveLength(0);
    expect(sweep.failures[0]?.kind).toBe('not-kml');
  });

  it('does not fetch a URL that is not a KML resource at all', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/app.js`, `${HOST}/data/wards.geojson`),
      budget: new RequestBudget(20, 4, 0),
    });

    expect(recorder.requests).toHaveLength(0);
    expect(sweep.notes.join(' ')).toMatch(/did not look like KML or KMZ/i);
  });

  it('stores byte-identical duplicates once', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`, `${HOST}/mirror/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    const roots = sweep.preserved.filter((file) => file.inspection.documentName === 'Ward index');
    expect(roots).toHaveLength(1);
    expect(sweep.notes.join(' ')).toMatch(/byte-identical/i);
  });

  it('stays inside its request budget', async () => {
    const budget = new RequestBudget(2, 4, 0);
    const sweep = await runPreservationSweep({ seeds: seeds(`${HOST}/index.kml`), budget });

    expect(budget.requestsSpent).toBeLessThanOrEqual(2);
    expect(sweep.warnings.join(' ')).toMatch(/budget/i);
  });
});

describe('what a sweep records', () => {
  it('hashes the preserved bytes', async () => {
    const captured: Array<{ sha256: string; bytes: Uint8Array }> = [];
    await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
      onFile: (record, bytes) => {
        captured.push({ sha256: record.sha256, bytes });
      },
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const entry of captured) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // Distinct documents hash differently.
    expect(new Set(captured.map((entry) => entry.sha256)).size).toBe(captured.length);
  });

  it('hands the caller the exact bytes that were received', async () => {
    let rootBytes: Uint8Array | null = null;
    await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
      onFile: (record, bytes) => {
        if (record.url.endsWith('/index.kml')) rootBytes = bytes;
      },
    });

    expect(rootBytes).not.toBeNull();
    expect(new TextDecoder().decode(rootBytes!)).toBe(ROOT_KML);
  });

  it('summarises a document without altering it', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    const ward1 = sweep.preserved.find((file) => file.url.endsWith('ward-1.kml'));
    expect(ward1?.inspection.documentName).toBe('Ward 1 parcels');
    expect(ward1?.inspection.placemarks).toBe(1);
    expect(ward1?.inspection.withGeometry).toBe(1);
    expect(ward1?.inspection.geometryTypes).toEqual(['Polygon']);
    expect(ward1?.inspection.networkLinks).toBe(2);
  });

  it('marks everything it preserves as an original', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });

    expect(sweep.preserved.length).toBeGreaterThan(0);
    for (const file of sweep.preserved) {
      expect(file.origin).toBe('original');
    }
  });

  it('lists what a KMZ archive contains', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/wards/ward-2.kmz`),
      budget: new RequestBudget(20, 4, 0),
    });

    const ward2 = sweep.preserved[0];
    expect(ward2?.kind).toBe('kmz');
    expect(ward2?.inspection.archiveEntries).toContain('doc.kml');
    expect(ward2?.inspection.archiveEntries).toContain('files/overlay.png');
    // The KML inside was read, without the archive being rewritten.
    expect(ward2?.inspection.placemarks).toBe(1);
  });

  it('derives a filename from the URL', async () => {
    const sweep = await runPreservationSweep({
      seeds: seeds(`${HOST}/index.kml`),
      budget: new RequestBudget(50, 4, 0),
    });
    expect(sweep.preserved.map((file) => file.filename)).toContain('index.kml');
  });
});
