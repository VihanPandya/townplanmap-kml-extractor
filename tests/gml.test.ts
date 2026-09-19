/**
 * GML reading, with particular attention to axis order.
 *
 * Reading the axis order wrong does not throw and does not look broken — it
 * silently transposes every coordinate. For a tool whose whole claim is that it
 * does not publish geometry it cannot vouch for, that is the single most
 * dangerous failure mode in the codebase, so it is tested hardest.
 */

import { describe, expect, it } from 'vitest';
import {
  axisOrderLooksTransposed,
  gmlGeometryToGeoJson,
  interpretSrsName,
  parseGmlFeatureCollection,
  readCoordinates,
  readPosList,
} from '@/lib/discovery/providers/gml';
import { validateWgs84Geometry } from '@/lib/geo/geometry';
import { WFS_GML2_LONLAT, WFS_GML32_LATLON, WFS_GML_NO_SRS } from './fixtures/wire-formats';

describe('interpretSrsName', () => {
  it('reads the URN form as the authority axis order, latitude first', () => {
    const result = interpretSrsName('urn:ogc:def:crs:EPSG::4326');
    expect(result.code).toBe('EPSG:4326');
    expect(result.axisOrder).toBe('lat-lon');
    expect(result.declared).toBe(true);
  });

  it('reads the OGC HTTP URI the same way', () => {
    expect(interpretSrsName('http://www.opengis.net/def/crs/EPSG/0/4326').axisOrder).toBe('lat-lon');
  });

  it('reads the short form as longitude first, by convention', () => {
    const result = interpretSrsName('EPSG:4326');
    expect(result.code).toBe('EPSG:4326');
    expect(result.axisOrder).toBe('lon-lat');
  });

  it('always reads CRS84 as longitude first, whichever spelling', () => {
    for (const name of ['CRS:84', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:OGC::CRS84']) {
      const result = interpretSrsName(name);
      expect(result.axisOrder, name).toBe('lon-lat');
      expect(result.code, name).toBe('EPSG:4326');
    }
  });

  it('treats a projected CRS as easting/northing even in URN form', () => {
    const result = interpretSrsName('urn:ogc:def:crs:EPSG::32643');
    expect(result.code).toBe('EPSG:32643');
    expect(result.axisOrder).toBe('lon-lat');
    expect(result.reason).toMatch(/projected/i);
  });

  it('reports an absent srsName as undeclared rather than defaulting silently', () => {
    const result = interpretSrsName(undefined);
    expect(result.declared).toBe(false);
    expect(result.code).toBeNull();
  });
});

describe('readPosList', () => {
  it('applies latitude-first order', () => {
    expect(readPosList('23.0 72.5 23.1 72.6', 'lat-lon')).toEqual([
      [72.5, 23.0],
      [72.6, 23.1],
    ]);
  });

  it('applies longitude-first order', () => {
    expect(readPosList('72.5 23.0 72.6 23.1', 'lon-lat')).toEqual([
      [72.5, 23.0],
      [72.6, 23.1],
    ]);
  });

  it('keeps a third ordinate as elevation', () => {
    expect(readPosList('23.0 72.5 15 23.1 72.6 20', 'lat-lon', 3)).toEqual([
      [72.5, 23.0, 15],
      [72.6, 23.1, 20],
    ]);
  });

  it('drops a trailing partial tuple rather than inventing an ordinate', () => {
    expect(readPosList('23.0 72.5 23.1', 'lat-lon')).toEqual([[72.5, 23.0]]);
  });

  it('handles an empty or absent list', () => {
    expect(readPosList(undefined, 'lon-lat')).toEqual([]);
    expect(readPosList('   ', 'lon-lat')).toEqual([]);
  });
});

describe('readCoordinates', () => {
  it('reads GML 2 comma-separated tuples', () => {
    expect(readCoordinates('72.5,23.0 72.6,23.1', 'lon-lat')).toEqual([
      [72.5, 23.0],
      [72.6, 23.1],
    ]);
  });

  it('applies the axis order to GML 2 tuples too', () => {
    expect(readCoordinates('23.0,72.5', 'lat-lon')).toEqual([[72.5, 23.0]]);
  });

  it('honours a non-default tuple separator', () => {
    expect(readCoordinates('72.5,23.0;72.6,23.1', 'lon-lat', { ts: ';' })).toEqual([
      [72.5, 23.0],
      [72.6, 23.1],
    ]);
  });

  it('skips malformed tuples', () => {
    expect(readCoordinates('abc,def 72.5,23.0', 'lon-lat')).toEqual([[72.5, 23.0]]);
  });
});

describe('gmlGeometryToGeoJson', () => {
  const unknown = interpretSrsName(null);

  it('reads a GML 3 polygon with an interior ring', () => {
    const node = {
      Polygon: {
        '@srsName': 'EPSG:4326',
        exterior: { LinearRing: { posList: '72.5 23.0 72.6 23.0 72.6 23.1 72.5 23.1 72.5 23.0' } },
        interior: { LinearRing: { posList: '72.52 23.02 72.55 23.02 72.55 23.05 72.52 23.02' } },
      },
    };
    const { geometry } = gmlGeometryToGeoJson(node, unknown);

    expect(geometry?.type).toBe('Polygon');
    if (geometry?.type !== 'Polygon') return;
    expect(geometry.coordinates).toHaveLength(2);
    expect(geometry.coordinates[0]?.[0]).toEqual([72.5, 23.0]);
  });

  it('closes a ring the server left open', () => {
    const node = {
      Polygon: {
        '@srsName': 'EPSG:4326',
        exterior: { LinearRing: { posList: '72.5 23.0 72.6 23.0 72.6 23.1' } },
      },
    };
    const { geometry } = gmlGeometryToGeoJson(node, unknown);
    if (geometry?.type !== 'Polygon') throw new Error('expected a polygon');

    const ring = geometry.coordinates[0]!;
    expect(ring).toHaveLength(4);
    expect(ring[3]).toEqual(ring[0]);
    expect(validateWgs84Geometry(geometry).valid).toBe(true);
  });

  it('reads a MultiSurface as a MultiPolygon', () => {
    const node = {
      MultiSurface: {
        '@srsName': 'EPSG:4326',
        surfaceMember: [
          { Polygon: { exterior: { LinearRing: { posList: '72.5 23.0 72.6 23.0 72.6 23.1 72.5 23.0' } } } },
          { Polygon: { exterior: { LinearRing: { posList: '73.5 24.0 73.6 24.0 73.6 24.1 73.5 24.0' } } } },
        ],
      },
    };
    const { geometry } = gmlGeometryToGeoJson(node, unknown);

    expect(geometry?.type).toBe('MultiPolygon');
    if (geometry?.type !== 'MultiPolygon') return;
    expect(geometry.coordinates).toHaveLength(2);
  });

  it('reads a GML 2 MultiPolygon with comma-separated coordinates', () => {
    const node = {
      MultiPolygon: {
        '@srsName': 'EPSG:4326',
        polygonMember: {
          Polygon: {
            outerBoundaryIs: { LinearRing: { coordinates: '72.5,23.0 72.6,23.0 72.6,23.1 72.5,23.0' } },
          },
        },
      },
    };
    const { geometry } = gmlGeometryToGeoJson(node, unknown);
    expect(geometry?.type).toBe('MultiPolygon');
  });

  it('reads a point and a line string', () => {
    expect(gmlGeometryToGeoJson({ Point: { '@srsName': 'EPSG:4326', pos: '72.5 23.0' } }, unknown).geometry).toEqual({
      type: 'Point',
      coordinates: [72.5, 23.0],
    });
    expect(
      gmlGeometryToGeoJson({ LineString: { '@srsName': 'EPSG:4326', posList: '72.5 23.0 72.6 23.1' } }, unknown)
        .geometry?.type,
    ).toBe('LineString');
  });

  it('inherits an srsName declared on an enclosing element', () => {
    const inherited = interpretSrsName('urn:ogc:def:crs:EPSG::4326');
    const node = { Polygon: { exterior: { LinearRing: { posList: '23.0 72.5 23.0 72.6 23.1 72.6 23.0 72.5' } } } };
    const { geometry, srs } = gmlGeometryToGeoJson(node, inherited);

    expect(srs.axisOrder).toBe('lat-lon');
    if (geometry?.type !== 'Polygon') throw new Error('expected a polygon');
    // Latitude came first in the posList, so longitude must come first here.
    expect(geometry.coordinates[0]?.[0]).toEqual([72.5, 23.0]);
  });

  it('returns null for an element carrying no geometry', () => {
    expect(gmlGeometryToGeoJson({ somethingElse: 'x' }, unknown).geometry).toBeNull();
  });
});

describe('parseGmlFeatureCollection', () => {
  it('reads WFS 2.0 / GML 3.2 with latitude-first coordinates', () => {
    const parsed = parseGmlFeatureCollection(WFS_GML32_LATLON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.result.features).toHaveLength(2);
    expect(parsed.result.numberMatched).toBe(842);
    expect(parsed.result.numberReturned).toBe(2);

    const first = parsed.result.features[0]!;
    expect(first.id).toBe('final_plots.1');
    expect(first.properties.survey_no).toBe('125/2');
    expect(first.properties.village).toBe('Example Village');
    expect(first.geometry?.type).toBe('MultiPolygon');

    // The decisive assertion: the posList was `lat lon`, so the output must be
    // `lon lat` and must land in Gujarat, not in the Indian Ocean.
    if (first.geometry?.type !== 'MultiPolygon') return;
    const corner = first.geometry.coordinates[0]?.[0]?.[0];
    expect(corner?.[0]).toBeCloseTo(72.5, 6);
    expect(corner?.[1]).toBeCloseTo(23.0, 6);
    expect(validateWgs84Geometry(first.geometry).valid).toBe(true);
  });

  it('reads an interior ring from GML 3', () => {
    const parsed = parseGmlFeatureCollection(WFS_GML32_LATLON);
    if (!parsed.ok) throw new Error('parse failed');

    const second = parsed.result.features[1]!;
    if (second.geometry?.type !== 'Polygon') throw new Error('expected a polygon');
    expect(second.geometry.coordinates).toHaveLength(2);
  });

  it('reads WFS 1.1 / GML 2 with longitude-first coordinates', () => {
    const parsed = parseGmlFeatureCollection(WFS_GML2_LONLAT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const feature = parsed.result.features[0]!;
    expect(feature.id).toBe('final_plots.7');
    expect(feature.properties.survey_no).toBe('127/4');
    expect(feature.geometry?.type).toBe('MultiPolygon');

    if (feature.geometry?.type !== 'MultiPolygon') return;
    const corner = feature.geometry.coordinates[0]?.[0]?.[0];
    expect(corner?.[0]).toBeCloseTo(72.5, 6);
    expect(corner?.[1]).toBeCloseTo(23.0, 6);
  });

  it('marks geometry as undeclared when no srsName appears anywhere', () => {
    const parsed = parseGmlFeatureCollection(WFS_GML_NO_SRS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.result.features[0]?.srs.declared).toBe(false);
    expect(parsed.result.notes.join(' ')).toMatch(/did not declare a coordinate reference system/i);
  });

  it('reports an OGC exception report as a refusal, not an empty collection', () => {
    const exception = [
      '<?xml version="1.0"?>',
      '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">',
      '<ows:Exception exceptionCode="InvalidParameterValue">',
      '<ows:ExceptionText>Failed to find response for output format application/json</ows:ExceptionText>',
      '</ows:Exception></ows:ExceptionReport>',
    ].join('');

    const parsed = parseGmlFeatureCollection(exception);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/refused/i);
    expect(parsed.reason).toMatch(/output format/i);
  });

  it('rejects a GML document carrying a DOCTYPE', () => {
    const hostile = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>',
      '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"/>',
    ].join('\n');

    const parsed = parseGmlFeatureCollection(hostile);
    expect(parsed.ok).toBe(false);
  });

  it('coerces numeric attribute text but keeps long identifiers as strings', () => {
    const parsed = parseGmlFeatureCollection(WFS_GML32_LATLON);
    if (!parsed.ok) throw new Error('parse failed');

    expect(parsed.result.features[0]?.properties.area_sqm).toBe(23400.5);
    expect(parsed.result.features[0]?.properties.fp_no).toBe(12);
  });
});

describe('axisOrderLooksTransposed', () => {
  it('flags coordinates that only make sense transposed', () => {
    // 23,72 is off Somalia; 72,23 is Gujarat.
    expect(axisOrderLooksTransposed([[23.0, 72.5]])).toBe(true);
  });

  it('does not flag coordinates that are already plausible', () => {
    expect(axisOrderLooksTransposed([[72.5, 23.0]])).toBe(false);
  });

  it('stays quiet when neither order is plausible, rather than guessing', () => {
    // Somewhere in the Atlantic: transposing does not help either.
    expect(axisOrderLooksTransposed([[-30, -10]])).toBe(false);
  });

  it('stays quiet on an empty input', () => {
    expect(axisOrderLooksTransposed([])).toBe(false);
  });
});
