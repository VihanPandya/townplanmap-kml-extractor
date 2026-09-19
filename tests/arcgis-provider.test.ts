/**
 * ArcGIS provider driven against recorded wire formats.
 *
 * This is the provider that does most of the work against real municipal
 * portals, and the only way to exercise it in this environment is to feed it
 * the exact response shapes ArcGIS Server emits.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchRecorder } from './fixtures/mock-fetch';
import {
  ARCGIS_COUNT,
  ARCGIS_ERROR,
  ARCGIS_LAYER_INFO,
  ARCGIS_QUERY_ESRI_JSON,
  ARCGIS_QUERY_GEOJSON,
  ARCGIS_SERVICE_INFO,
} from './fixtures/wire-formats';

const BASE = 'https://gis.example.org/arcgis/rest/services/Planning/TPScheme/FeatureServer';

/** Switched per test to steer the mock's behaviour. */
const state = {
  geojsonSupported: true,
  layerInfoFails: false,
  authRequired: false,
};

const recorder = new FetchRecorder([
  {
    match: (url) => url.pathname.endsWith('/query'),
    respond: (url) => {
      if (state.authRequired) return { failure: 'auth-required' as const, status: 403 };
      if (url.searchParams.get('returnCountOnly') === 'true') return { json: ARCGIS_COUNT };
      // A server without GeoJSON support answers f=geojson with an error.
      if (url.searchParams.get('f') === 'geojson' && !state.geojsonSupported) {
        return { json: ARCGIS_ERROR };
      }
      return {
        json: url.searchParams.get('f') === 'geojson' ? ARCGIS_QUERY_GEOJSON : ARCGIS_QUERY_ESRI_JSON,
      };
    },
  },
  {
    match: (url) => /\/FeatureServer\/\d+$/.test(url.pathname),
    respond: () =>
      state.layerInfoFails
        ? { failure: 'network' as const, reason: 'connection reset' }
        : { json: ARCGIS_LAYER_INFO },
  },
  {
    match: (url) => url.pathname.endsWith('/FeatureServer'),
    respond: () =>
      state.authRequired ? { failure: 'auth-required' as const, status: 403 } : { json: ARCGIS_SERVICE_INFO },
  },
]);

vi.mock('@/lib/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/net/safe-fetch')>();
  return {
    ...actual,
    safeFetch: (target: string, options: unknown) => recorder.fetch(target, options as never),
  };
});

const { ArcGisProvider } = await import('@/lib/discovery/providers/arcgis');
const { RequestBudget } = await import('@/lib/net/budget');
const { identifyCrs } = await import('@/lib/geo/crs');

function endpoint(url = BASE) {
  return {
    id: 'ep_1',
    url,
    kind: 'arcgis-feature-server' as const,
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
  state.geojsonSupported = true;
  state.layerInfoFails = false;
  state.authRequired = false;
});

describe('listLayers', () => {
  it('enumerates the service layers and skips group layers', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());

    expect(layers).toHaveLength(3);
    expect(layers.map((layer) => layer.name)).toEqual(['Final Plots', 'Final Plots', 'Final Plots']);
    // Each sub-layer is described individually, so the service URL differs.
    expect(layers.map((layer) => layer.serviceUrl)).toEqual([
      `${BASE}/0`,
      `${BASE}/1`,
      `${BASE}/2`,
    ]);
  });

  it('requests the service description as JSON', async () => {
    await new ArcGisProvider().listLayers(endpoint(), context());
    const params = recorder.paramsOf('/FeatureServer?');
    expect(params?.get('f')).toBe('json');
  });

  it('reads the declared spatial reference, preferring latestWkid', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    // The layer's own extent declares 4326 even though the service says 102100.
    expect(layers[0]?.crs.code).toBe('EPSG:4326');
    expect(layers[0]?.crs.confidence).toBe('declared');
  });

  it('carries the service fields through for the attribute table', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    const names = layers[0]?.fields.map((field) => field.name);
    expect(names).toContain('SURVEY_NO');
    expect(names).toContain('VILLAGE');
    expect(layers[0]?.fields.find((f) => f.name === 'FP_NO')?.alias).toBe('Final Plot No');
  });

  it('categorises layers from their own names', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    // Every described layer reports "Final Plots" from the fixture. A final
    // plot is the output of a Town Planning Scheme, so tp-scheme is the right
    // reading of that name.
    expect(layers[0]?.category).toBe('tp-scheme');
  });

  it('categorises a parcel layer separately from a scheme layer', async () => {
    state.layerInfoFails = true; // fall back to the summary names
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    const byName = Object.fromEntries(layers.map((layer) => [layer.name, layer.category]));

    expect(byName['TP Scheme Boundary']).toBe('tp-scheme');
    expect(byName['Village Boundary']).toBe('village-boundary');
  });

  it('marks a queryable polygon layer as vector and KML-exportable', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    expect(layers[0]?.availability.status).toBe('vector');
    expect(layers[0]?.kmlExportable).toBe(true);
  });

  it('keeps the copyright text as attribution', async () => {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    expect(layers[0]?.attribution).toBe('Municipal Corporation, 2024');
  });

  it('falls back to the summary when a layer description cannot be fetched', async () => {
    state.layerInfoFails = true;
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());

    expect(layers).toHaveLength(3);
    expect(layers.map((layer) => layer.name)).toEqual([
      'TP Scheme Boundary',
      'Final Plots',
      'Village Boundary',
    ]);
    // Without the layer description, the service-level spatial reference applies.
    expect(layers[0]?.crs.code).toBe('EPSG:3857');
  });

  it('reports a restricted service rather than pretending it has no layers', async () => {
    state.authRequired = true;
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());

    expect(layers).toHaveLength(1);
    expect(layers[0]?.availability.status).toBe('restricted');
    expect(layers[0]?.kmlExportable).toBe(false);
    expect(layers[0]?.kmlNote).toMatch(/authorised access/i);
  });

  it('stays inside the request budget', async () => {
    const ctx = { budget: new RequestBudget(3, 4, 0) };
    const layers = await new ArcGisProvider().listLayers(endpoint(), ctx);
    expect(layers.length).toBeGreaterThan(0);
    expect(ctx.budget.requestsSpent).toBeLessThanOrEqual(3);
  });
});

describe('listFeatures against a GeoJSON-capable server', () => {
  async function layerFixture() {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    recorder.reset();
    return layers[1]!;
  }

  it('asks for WGS84 and GeoJSON', async () => {
    const layer = await layerFixture();
    await new ArcGisProvider().listFeatures(layer, {}, context());

    const params = recorder.paramsOf('/query');
    expect(params?.get('f')).toBe('geojson');
    expect(params?.get('outSR')).toBe('4326');
    expect(params?.get('outFields')).toBe('*');
    expect(params?.get('returnGeometry')).toBe('true');
  });

  it('reads features with geometry, attributes and a derived name', async () => {
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(2);
    const first = page.features[0]!;
    expect(first.geometry?.type).toBe('Polygon');
    expect(first.properties.SURVEY_NO).toBe('125/2');
    expect(first.sourceFeatureId).toBe('101');
    // SURVEY_NO matches a survey-number pattern, so it wins as the display name.
    expect(first.name).toBe('125/2');
  });

  it('computes area for WGS84 geometry', async () => {
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());
    expect(page.features[0]?.areaSquareMetres).toBeGreaterThan(0);
  });

  it('marks geometry the service reprojected on request as crs-converted', async () => {
    const layer = await layerFixture();
    // Pretend the layer is natively web mercator, as the service root declares.
    const projected = { ...layer, crs: identifyCrs(3857) };
    const page = await new ArcGisProvider().listFeatures(projected, {}, context());

    expect(page.features[0]?.provenance).toBe('crs-converted');
    expect(page.features[0]?.provenanceNote).toMatch(/outSR=4326/);
  });

  it('marks geometry as source-geometry when the layer was already WGS84', async () => {
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());
    expect(page.features[0]?.provenance).toBe('source-geometry');
  });

  it('pages with resultOffset and reports a next cursor', async () => {
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, { limit: 2 }, context());

    expect(recorder.paramsOf('/query')?.get('resultOffset')).toBe('0');
    expect(recorder.paramsOf('/query')?.get('resultRecordCount')).toBe('2');
    // Two features came back for a limit of two, so there may be more.
    expect(page.nextCursor).toBe('2');

    recorder.reset();
    await new ArcGisProvider().listFeatures(layer, { cursor: '2', limit: 2 }, context());
    expect(recorder.paramsOf('/query')?.get('resultOffset')).toBe('2');
  });

  it('queries by object id without an offset when ids are given', async () => {
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, { ids: ['101', '102'] }, context());

    const params = recorder.paramsOf('/query');
    expect(params?.get('objectIds')).toBe('101,102');
    expect(params?.get('where')).toBe('1=1');
    expect(params?.has('resultOffset')).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('passes a bounding box as an envelope filter', async () => {
    const layer = await layerFixture();
    await new ArcGisProvider().listFeatures(layer, { bbox: [72.5, 23.0, 72.6, 23.1] }, context());

    const params = recorder.paramsOf('/query');
    expect(params?.get('geometry')).toBe('72.5,23,72.6,23.1');
    expect(params?.get('geometryType')).toBe('esriGeometryEnvelope');
    expect(params?.get('inSR')).toBe('4326');
    expect(params?.get('spatialRel')).toBe('esriSpatialRelIntersects');
  });

  it('skips geometry when the caller does not need it', async () => {
    const layer = await layerFixture();
    await new ArcGisProvider().listFeatures(layer, { includeGeometry: false }, context());
    expect(recorder.paramsOf('/query')?.get('returnGeometry')).toBe('false');
  });
});

describe('server-side search', () => {
  async function layerFixture() {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    recorder.reset();
    return layers[1]!;
  }

  it('builds a WHERE clause over the text fields the service declared', async () => {
    const layer = await layerFixture();
    await new ArcGisProvider().listFeatures(layer, { search: '125/2' }, context());

    const where = recorder.paramsOf('/query')?.get('where') ?? '';
    expect(where).toContain('SURVEY_NO');
    expect(where).toContain('VILLAGE');
    expect(where).toContain("LIKE UPPER('%125/2%')");
    // Numeric fields must not appear in a LIKE clause.
    expect(where).not.toContain('AREA_SQM');
  });

  it('escapes a quote in the search term rather than letting it close the literal', async () => {
    const layer = await layerFixture();
    await new ArcGisProvider().listFeatures(layer, { search: "x' OR '1'='1" }, context());

    const where = recorder.paramsOf('/query')?.get('where') ?? '';

    // The user's quotes are doubled, which is the SQL-92 escape ArcGIS expects.
    expect(where).toContain("''");

    // The property that matters: once the doubled pairs are removed, the only
    // quotes left are the literal delimiters the clause itself opened and
    // closed — two per LIKE, three LIKEs. Any quote the search term managed to
    // smuggle through unescaped would push this above six.
    const delimiters = where.replaceAll("''", '').match(/'/g) ?? [];
    expect(delimiters).toHaveLength(6);
  });

  it('quotes a field name that is not a plain identifier', async () => {
    const layer = await layerFixture();
    const awkward = {
      ...layer,
      fields: [{ name: 'SURVEY NO; DROP TABLE x--', alias: null, type: 'esriFieldTypeString' }],
    };
    await new ArcGisProvider().listFeatures(awkward, { search: 'abc' }, context());

    const where = recorder.paramsOf('/query')?.get('where') ?? '';
    expect(where).toContain('"SURVEY NO DROP TABLE x"');
    expect(where).not.toContain(';');
    expect(where).not.toContain('--');
  });

  it('falls back to filtering the returned page when no text field exists', async () => {
    const layer = await layerFixture();
    const noTextFields = { ...layer, fields: [{ name: 'AREA_SQM', alias: null, type: 'esriFieldTypeDouble' }] };
    const page = await new ArcGisProvider().listFeatures(noTextFields, { search: '125/2' }, context());

    expect(recorder.paramsOf('/query')?.get('where')).toBe('1=1');
    expect(page.notes.join(' ')).toMatch(/applied to the features returned/i);
    // The client-side filter still narrows it correctly.
    expect(page.features).toHaveLength(1);
    expect(page.features[0]?.properties.SURVEY_NO).toBe('125/2');
  });
});

describe('Esri JSON fallback for older deployments', () => {
  async function layerFixture() {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    recorder.reset();
    return layers[1]!;
  }

  it('retries with f=json when the server rejects f=geojson', async () => {
    state.geojsonSupported = false;
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());

    const formats = recorder.requests
      .filter((request) => request.url.includes('/query'))
      .map((request) => new URL(request.url).searchParams.get('f'));
    expect(formats).toEqual(['geojson', 'json']);
    expect(page.notes.join(' ')).toMatch(/does not support GeoJSON/i);
  });

  it('rebuilds polygon nesting from Esri ring winding order', async () => {
    state.geojsonSupported = false;
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());

    const geometry = page.features[0]?.geometry;
    expect(geometry?.type).toBe('MultiPolygon');
    if (geometry?.type !== 'MultiPolygon') return;

    // Two parts: the first carries a hole, the second does not.
    expect(geometry.coordinates).toHaveLength(2);
    expect(geometry.coordinates[0]).toHaveLength(2);
    expect(geometry.coordinates[1]).toHaveLength(1);
  });

  it('reads the object id from the field the response names', async () => {
    state.geojsonSupported = false;
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());
    expect(page.features[0]?.sourceFeatureId).toBe('201');
  });

  it('reports the transfer limit the server flagged', async () => {
    state.geojsonSupported = false;
    const layer = await layerFixture();
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());
    expect(page.truncated).toBe(true);
  });
});

describe('error handling', () => {
  async function layerFixture() {
    const layers = await new ArcGisProvider().listLayers(endpoint(), context());
    recorder.reset();
    return layers[1]!;
  }

  it('surfaces an authorisation refusal in the tool’s own words', async () => {
    const layer = await layerFixture();
    state.authRequired = true;
    const page = await new ArcGisProvider().listFeatures(layer, {}, context());

    expect(page.features).toHaveLength(0);
    expect(page.notes.join(' ')).toMatch(/requires authorised access/i);
  });

  it('counts features without downloading them', async () => {
    const layer = await layerFixture();
    const count = await new ArcGisProvider().countFeatures(layer, context());

    expect(count).toBe(1284);
    expect(recorder.paramsOf('/query')?.get('returnCountOnly')).toBe('true');
  });
});
