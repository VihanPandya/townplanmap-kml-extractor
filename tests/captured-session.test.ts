/**
 * Data captured inside the browser window.
 *
 * This is the path that matters when the source only returns geometry to a
 * signed-in user: the person signs themselves in, the site fetches its data,
 * and the bytes it received are read back here. Nothing is asked of the source
 * a second time, and nothing that authenticated the session is kept.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { RequestBudget } from '@/lib/net/budget';
import {
  CAPTURED_SOURCE,
  CapturedProvider,
  capturedEndpointId,
  capturedId,
  readCapturedDocument,
  setCapturedLookup,
  type CapturedPayload,
} from '@/lib/discovery/captured';
import type { DiscoveredEndpoint } from '@/lib/discovery/types';

const encoder = new TextEncoder();

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'FP-12',
      properties: { final_plot_no: '12', village: 'Vastral', area_sqm: 1820 },
      geometry: {
        type: 'Polygon',
        coordinates: [[[72.63, 23.01], [72.64, 23.01], [72.64, 23.02], [72.63, 23.02], [72.63, 23.01]]],
      },
    },
  ],
});

const ESRI = JSON.stringify({
  objectIdFieldName: 'OBJECTID',
  spatialReference: { wkid: 32643, latestWkid: 32643 },
  features: [
    {
      attributes: { OBJECTID: 7, SURVEY_NO: '125/2', VILLAGE: 'Vastral' },
      geometry: { rings: [[[712345, 2545678], [712445, 2545678], [712445, 2545778], [712345, 2545678]]] },
    },
  ],
});

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Ward 4</name>
  <Placemark><name>Plot 88</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      72.63,23.01 72.64,23.01 72.64,23.02 72.63,23.01
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Document></kml>`;

function payload(url: string, body: string, contentType: string, carriedSession = true): CapturedPayload {
  const bytes = encoder.encode(body);
  return {
    record: {
      id: `cap_${url}`,
      url,
      contentType,
      kind: 'geojson',
      byteLength: bytes.byteLength,
      capturedAt: new Date().toISOString(),
      carriedSession,
    },
    bytes,
  };
}

function endpointFor(url: string): DiscoveredEndpoint {
  return {
    id: capturedEndpointId(url),
    url,
    kind: 'geojson',
    nature: 'vector',
    discoveredIn: CAPTURED_SOURCE,
    bodyVerified: true,
    evidence: [],
  };
}

describe('reading a captured response', () => {
  it('reads GeoJSON the site returned', async () => {
    const result = await readCapturedDocument(payload('https://x/api/plots', GEOJSON, 'application/geo+json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties.final_plot_no).toBe('12');
    expect(result.crs.isWgs84).toBe(true);
  });

  it('reads an ArcGIS feature set, with its own spatial reference', async () => {
    const result = await readCapturedDocument(payload('https://x/query', ESRI, 'application/json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.crs.code).toBe('EPSG:32643');
    expect(result.crs.isWgs84).toBe(false);
    expect(result.crs.transformable).toBe(true);
    expect(result.features[0]?.geometry?.type).toBe('Polygon');
    expect(result.features[0]?.properties.SURVEY_NO).toBe('125/2');
  });

  it('reads KML the site returned', async () => {
    const result = await readCapturedDocument(payload('https://x/ward.kml', KML, 'application/vnd.google-earth.kml+xml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('Ward 4');
    expect(result.features[0]?.properties.name).toBe('Plot 88');
  });

  it('refuses to treat imagery as geometry', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = await readCapturedDocument({
      record: {
        id: 'cap_tile',
        url: 'https://x/tile/1/2/3.png',
        contentType: 'image/png',
        kind: 'raster-tiles',
        byteLength: png.byteLength,
        capturedAt: new Date().toISOString(),
        carriedSession: true,
      },
      bytes: png,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('imagery');
  });
});

describe('the captured provider', () => {
  const url = 'https://townplanmap.example/api/v1/plots?ward=4';
  const provider = new CapturedProvider();

  beforeEach(() => {
    setCapturedLookup(async (asked) => (asked === url ? payload(url, GEOJSON, 'application/geo+json') : null));
  });

  it('serves a layer without issuing a single request', async () => {
    const budget = new RequestBudget(0);
    const layers = await provider.listLayers(endpointFor(url), { budget, locationId: null });

    expect(layers).toHaveLength(1);
    expect(layers[0]?.availability.status).toBe('vector');
    expect(layers[0]?.kmlExportable).toBe(true);
    expect(layers[0]?.description).toContain('signed-in browser session');
    // A budget of zero: nothing was spent, because nothing was asked for.
    expect(budget.requestsSpent).toBe(0);
  });

  it('serves features with their geometry and provenance', async () => {
    const budget = new RequestBudget(0);
    const [layer] = await provider.listLayers(endpointFor(url), { budget, locationId: null });
    const page = await provider.listFeatures(layer!, { includeGeometry: true }, { budget });

    expect(page.features).toHaveLength(1);
    const feature = page.features[0]!;
    expect(feature.geometry?.type).toBe('Polygon');
    expect(feature.provenance).toBe('source-geometry');
    expect(feature.provenanceNote).toContain('exactly as the source returned them');
    expect(feature.kmlAvailable).toBe(true);
    expect(budget.requestsSpent).toBe(0);
  });

  it('says so plainly when the bytes are no longer held', async () => {
    const [layer] = await provider.listLayers(endpointFor(url), { budget: new RequestBudget(0) });
    expect(layer).toBeDefined();

    // A restart loses in-memory captures. That is a real state to be in, and
    // the answer is to say so rather than to quietly return nothing.
    setCapturedLookup(async () => null);
    const page = await provider.listFeatures(layer!, {}, { budget: new RequestBudget(0) });

    expect(page.features).toHaveLength(0);
    expect(page.notes.join(' ')).toContain('no longer held');
  });
});

/**
 * The last mile: captured bytes through the catalog to a validated KML file.
 *
 * Detecting data is not the product; exporting it is. This drives the real
 * store, the real provider dispatch and the real KML builder, so nothing
 * between "the site returned this" and "here is a .kml" is assumed.
 */
describe('from a captured response to exported KML', () => {
  it('becomes a layer, features and a valid KML document', async () => {
    const { getStore } = await import('@/lib/db');
    const { discoverLayers, listFeatures } = await import('@/lib/catalog');
    const { buildKmlDocument } = await import('@/lib/kml/builder');
    const { validateKml } = await import('@/lib/kml/validate');

    const url = 'https://townplanmap.example/api/v1/plots?ward=4';
    const store = await getStore();
    const bytes = encoder.encode(GEOJSON);

    await store.saveCapturedResponse(
      {
        id: capturedId(url),
        url,
        contentType: 'application/geo+json',
        kind: 'geojson',
        byteLength: bytes.byteLength,
        capturedAt: new Date().toISOString(),
        carriedSession: true,
      },
      bytes,
    );

    await store.saveScan({
      id: 'scan_captured',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      baseUrl: 'https://townplanmap.example',
      connected: true,
      mapInterfaceDetected: false,
      geographicLayersDetected: true,
      endpoints: [endpointFor(url)],
      documentsFetched: [],
      requestsSpent: 0,
      bytesDownloaded: 0,
      notes: [],
      warnings: [],
      failure: null,
    });

    const { layers } = await discoverLayers(null, { refresh: true });
    const layer = layers.find((entry) => entry.serviceUrl === url);
    expect(layer, 'the captured response should appear as a layer').toBeDefined();
    expect(layer?.kmlExportable).toBe(true);

    const page = await listFeatures(layer!.id, { includeGeometry: true, limit: 50 });
    expect(page.features).toHaveLength(1);
    expect(page.features[0]?.geometry?.type).toBe('Polygon');

    const built = buildKmlDocument({
      documentName: layer!.name,
      sourceDataset: layer!.name,
      sourcePage: url,
      features: page.features,
    });
    const validation = validateKml(built.kml, built.written);

    expect(built.written).toBe(1);
    expect(built.skipped).toHaveLength(0);
    expect(
      validation.valid,
      validation.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.label}: ${check.detail}`)
        .join('; '),
    ).toBe(true);
    expect(built.kml).toContain('<Placemark');
    expect(built.kml).toContain('<coordinates>');
    // A generated document is still a reconstruction, however direct its source.
    expect(built.kml).toContain('<value>reconstructed</value>');
    expect(built.kml).not.toContain('<value>original</value>');
  });
});
