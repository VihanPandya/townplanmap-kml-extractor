/**
 * WFS provider driven against a GeoServer-shaped capabilities document and
 * GetFeature responses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchRecorder } from './fixtures/mock-fetch';
import {
  WFS_CAPABILITIES,
  WFS_EXCEPTION,
  WFS_GETFEATURE_GEOJSON,
  WFS_GML32_LATLON,
  WFS_GML_NO_SRS,
} from './fixtures/wire-formats';

const BASE = 'https://gis.example.org/geoserver/ows';

const state = { jsonSupported: true, gml: WFS_GML32_LATLON as string | null };

const recorder = new FetchRecorder([
  {
    match: (url) => (url.searchParams.get('request') ?? '') === 'GetCapabilities',
    respond: () => ({ text: WFS_CAPABILITIES, contentType: 'text/xml' }),
  },
  {
    match: (url) => (url.searchParams.get('request') ?? '') === 'GetFeature',
    respond: (url) => {
      if (state.jsonSupported) return { json: WFS_GETFEATURE_GEOJSON };
      // A GML-only server rejects the JSON request and serves GML otherwise.
      if (url.searchParams.get('outputFormat') === 'application/json') {
        return { text: WFS_EXCEPTION, contentType: 'text/xml' };
      }
      return { text: state.gml ?? WFS_EXCEPTION, contentType: 'application/gml+xml' };
    },
  },
]);

vi.mock('@/lib/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/net/safe-fetch')>();
  return {
    ...actual,
    safeFetch: (target: string, options: unknown) => recorder.fetch(target, options as never),
  };
});

const { WfsProvider } = await import('@/lib/discovery/providers/wfs');
const { RequestBudget } = await import('@/lib/net/budget');

function endpoint() {
  return {
    id: 'ep_wfs',
    url: `${BASE}?service=WFS`,
    kind: 'ogc-wfs' as const,
    nature: 'vector' as const,
    discoveredIn: 'test',
    evidence: [],
  };
}

function context() {
  return { budget: new RequestBudget(50, 4, 0) };
}

beforeEach(() => {
  recorder.reset();
  state.jsonSupported = true;
  state.gml = WFS_GML32_LATLON;
});

describe('listLayers', () => {
  it('reads every feature type out of the capabilities document', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());

    expect(layers).toHaveLength(2);
    expect(layers.map((layer) => layer.name)).toEqual(['Final Plots', 'Village Boundaries']);
    expect(layers.map((layer) => layer.sourceLayerId)).toEqual([
      'planning:final_plots',
      'planning:village_boundary',
    ]);
  });

  it('requests capabilities with the right service parameters', async () => {
    await new WfsProvider().listLayers(endpoint(), context());
    const params = recorder.paramsOf('GetCapabilities');

    expect(params?.get('service')).toBe('WFS');
    expect(params?.get('request')).toBe('GetCapabilities');
    expect(params?.get('version')).toBe('2.0.0');
  });

  it('resolves a URN-form CRS declaration', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());

    expect(layers[0]?.crs.code).toBe('EPSG:4326');
    expect(layers[0]?.crs.confidence).toBe('declared');
    // The second feature type is in a projected CRS.
    expect(layers[1]?.crs.code).toBe('EPSG:32643');
    expect(layers[1]?.crs.transformable).toBe(true);
  });

  it('reads the WGS84 bounding box', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    expect(layers[0]?.bbox).toEqual([72.5, 23.0, 72.6, 23.1]);
  });

  it('categorises feature types from their titles', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    expect(layers[0]?.category).toBe('tp-scheme');
    expect(layers[1]?.category).toBe('village-boundary');
  });

  it('keeps the abstract as the description and the provider as attribution', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    expect(layers[0]?.description).toBe('Sanctioned final plot boundaries.');
    expect(layers[0]?.attribution).toBe('Municipal Corporation');
  });

  it('treats every WFS feature type as vector and exportable', async () => {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    for (const layer of layers) {
      expect(layer.availability.status).toBe('vector');
      expect(layer.kmlExportable).toBe(true);
    }
  });
});

describe('listFeatures', () => {
  async function layerFixture(index = 0) {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    recorder.reset();
    return layers[index]!;
  }

  it('requests GeoJSON in WGS84 with WFS 2.0 parameter names', async () => {
    const layer = await layerFixture();
    await new WfsProvider().listFeatures(layer, {}, context());

    const params = recorder.paramsOf('GetFeature');
    expect(params?.get('typeNames')).toBe('planning:final_plots');
    expect(params?.get('outputFormat')).toBe('application/json');
    expect(params?.get('srsName')).toBe('EPSG:4326');
    expect(params?.get('count')).toBeTruthy();
    // `typeName` (singular) is the 1.x spelling and must not be sent for 2.0.
    expect(params?.has('typeName')).toBe(false);
  });

  it('reads features with geometry and attributes', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(2);
    expect(page.features[0]?.geometry?.type).toBe('MultiPolygon');
    expect(page.features[0]?.properties.survey_no).toBe('125/2');
    expect(page.features[0]?.sourceFeatureId).toBe('final_plots.1');
  });

  it('reports the total the server matched, not just what it returned', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());
    expect(page.total).toBe(842);
  });

  it('marks a natively-WGS84 layer as source geometry', async () => {
    const layer = await layerFixture(0);
    const page = await new WfsProvider().listFeatures(layer, {}, context());
    expect(page.features[0]?.provenance).toBe('source-geometry');
  });

  it('marks a reprojected layer as crs-converted and says who converted it', async () => {
    const layer = await layerFixture(1); // declared EPSG:32643
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features[0]?.provenance).toBe('crs-converted');
    expect(page.features[0]?.provenanceNote).toMatch(/srsName=EPSG:4326/);
  });

  it('pages with startIndex', async () => {
    const layer = await layerFixture();
    await new WfsProvider().listFeatures(layer, { cursor: '100', limit: 50 }, context());

    const params = recorder.paramsOf('GetFeature');
    expect(params?.get('startIndex')).toBe('100');
    expect(params?.get('count')).toBe('50');
  });

  it('passes a bounding box with its CRS', async () => {
    const layer = await layerFixture();
    await new WfsProvider().listFeatures(layer, { bbox: [72.5, 23.0, 72.6, 23.1] }, context());
    expect(recorder.paramsOf('GetFeature')?.get('bbox')).toBe('72.5,23,72.6,23.1,EPSG:4326');
  });
});

describe('a server that only speaks GML', () => {
  async function layerFixture() {
    const layers = await new WfsProvider().listLayers(endpoint(), context());
    recorder.reset();
    state.jsonSupported = false;
    return layers[0]!;
  }

  it('retries as GML after the JSON request is refused', async () => {
    const layer = await layerFixture();
    await new WfsProvider().listFeatures(layer, {}, context());

    const requests = recorder.requests.filter((request) => request.url.includes('GetFeature'));
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).searchParams.get('outputFormat')).toBe('application/json');
    // The GML retry drops outputFormat entirely.
    expect(new URL(requests[1]!.url).searchParams.has('outputFormat')).toBe(false);
  });

  it('asks for CRS84, whose axis order is unambiguous', async () => {
    const layer = await layerFixture();
    await new WfsProvider().listFeatures(layer, {}, context());

    const gmlRequest = recorder.requests.filter((request) => request.url.includes('GetFeature'))[1]!;
    expect(new URL(gmlRequest.url).searchParams.get('srsName')).toBe('urn:ogc:def:crs:OGC:1.3:CRS84');
  });

  it('reads features out of the GML, with the right axis order', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(2);
    const first = page.features[0]!;
    expect(first.properties.survey_no).toBe('125/2');
    expect(first.geometry?.type).toBe('MultiPolygon');

    // The server answered with latitude-first coordinates despite the CRS84
    // request; honouring its declared srsName must still land it in Gujarat.
    expect(first.bbox?.[0]).toBeCloseTo(72.5, 4);
    expect(first.bbox?.[1]).toBeCloseTo(23.0, 4);
  });

  it('produces exportable features with a WGS84 CRS', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features[0]?.crs.code).toBe('EPSG:4326');
    expect(page.features[0]?.kmlAvailable).toBe(true);
    expect(page.features[0]?.provenance).toBe('source-geometry');
  });

  it('says that GML was read and converted', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());
    expect(page.notes.join(' ')).toMatch(/GML was read and converted/i);
  });

  it('reports the total the GML declared', async () => {
    const layer = await layerFixture();
    const page = await new WfsProvider().listFeatures(layer, {}, context());
    expect(page.total).toBe(842);
  });

  it('refuses to export geometry whose CRS the server never declared', async () => {
    const layer = await layerFixture();
    state.gml = WFS_GML_NO_SRS;
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(1);
    const feature = page.features[0]!;
    expect(feature.crs.code).toBeNull();
    expect(feature.kmlAvailable).toBe(false);
    expect(feature.provenance).toBe('unverified');
    expect(feature.kmlNote).toMatch(/unknown/i);
  });

  it('explains itself when the GML is unreadable too', async () => {
    const layer = await layerFixture();
    state.gml = null; // the server returns an exception for GML as well
    const page = await new WfsProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(0);
    expect(page.notes.join(' ')).toMatch(/could not be read|refused/i);
  });
});
