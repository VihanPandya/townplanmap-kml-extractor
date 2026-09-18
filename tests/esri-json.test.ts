import { describe, expect, it } from 'vitest';
import {
  esriGeometryToGeoJson,
  esriGeometryTypeToGeoJson,
  normaliseAttributes,
  ringIsClockwise,
  ringsToPolygons,
} from '@/lib/discovery/providers/esri-json';
import { validateWgs84Geometry, closeRings } from '@/lib/geo/geometry';
import type { Position } from '@/lib/geo/types';

/** A clockwise unit square, which is how Esri winds an outer ring. */
const OUTER: Position[] = [
  [0, 0],
  [0, 10],
  [10, 10],
  [10, 0],
  [0, 0],
];

/** A counter-clockwise ring inside it, which is how Esri winds a hole. */
const HOLE: Position[] = [
  [2, 2],
  [4, 2],
  [4, 4],
  [2, 4],
  [2, 2],
];

describe('ringIsClockwise', () => {
  it('distinguishes Esri outer rings from holes', () => {
    expect(ringIsClockwise(OUTER)).toBe(true);
    expect(ringIsClockwise(HOLE)).toBe(false);
  });

  it('is the exact inverse when a ring is reversed', () => {
    expect(ringIsClockwise([...OUTER].reverse())).toBe(false);
    expect(ringIsClockwise([...HOLE].reverse())).toBe(true);
  });
});

describe('ringsToPolygons', () => {
  it('nests a hole under the outer ring that precedes it', () => {
    const polygons = ringsToPolygons([OUTER, HOLE]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
    expect(polygons[0]?.[0]).toEqual(OUTER);
    expect(polygons[0]?.[1]).toEqual(HOLE);
  });

  it('starts a new polygon at each clockwise ring', () => {
    const second: Position[] = [
      [20, 0],
      [20, 10],
      [30, 10],
      [30, 0],
      [20, 0],
    ];
    const polygons = ringsToPolygons([OUTER, HOLE, second]);
    expect(polygons).toHaveLength(2);
    expect(polygons[0]).toHaveLength(2);
    expect(polygons[1]).toHaveLength(1);
  });

  it('promotes an orphan hole to its own polygon rather than dropping it', () => {
    // Malformed input: a counter-clockwise ring with no outer ring before it.
    const polygons = ringsToPolygons([HOLE]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.[0]).toEqual(HOLE);
  });

  it('closes a ring the service left open', () => {
    const open = OUTER.slice(0, -1);
    const polygons = ringsToPolygons([open]);
    const ring = polygons[0]?.[0];
    expect(ring).toHaveLength(5);
    expect(ring?.[4]).toEqual(ring?.[0]);
  });

  it('discards a degenerate ring of fewer than three positions', () => {
    expect(ringsToPolygons([[[0, 0], [1, 1]]])).toHaveLength(0);
  });
});

describe('esriGeometryToGeoJson', () => {
  it('converts a point, preserving z', () => {
    expect(esriGeometryToGeoJson({ x: 72.5, y: 23 })).toEqual({ type: 'Point', coordinates: [72.5, 23] });
    expect(esriGeometryToGeoJson({ x: 72.5, y: 23, z: 40 })).toEqual({
      type: 'Point',
      coordinates: [72.5, 23, 40],
    });
  });

  it('rejects a point with non-finite ordinates', () => {
    expect(esriGeometryToGeoJson({ x: Number.NaN, y: 23 })).toBeNull();
  });

  it('converts a single path to LineString and several to MultiLineString', () => {
    expect(esriGeometryToGeoJson({ paths: [[[0, 0], [1, 1]]] })?.type).toBe('LineString');
    expect(
      esriGeometryToGeoJson({
        paths: [
          [[0, 0], [1, 1]],
          [[2, 2], [3, 3]],
        ],
      })?.type,
    ).toBe('MultiLineString');
  });

  it('converts a single ring set to Polygon and several to MultiPolygon', () => {
    expect(esriGeometryToGeoJson({ rings: [OUTER] })?.type).toBe('Polygon');
    const second: Position[] = [
      [20, 0],
      [20, 10],
      [30, 10],
      [20, 0],
    ];
    expect(esriGeometryToGeoJson({ rings: [OUTER, second] })?.type).toBe('MultiPolygon');
  });

  it('produces geometry that passes WGS84 validation', () => {
    const geometry = esriGeometryToGeoJson({
      rings: [
        [
          [72.5, 23.0],
          [72.5, 23.1],
          [72.6, 23.1],
          [72.6, 23.0],
          [72.5, 23.0],
        ],
      ],
    });
    expect(geometry).not.toBeNull();
    const { geometry: closed } = closeRings(geometry!);
    expect(validateWgs84Geometry(closed).valid).toBe(true);
  });

  it('returns null for an empty or unrecognised geometry', () => {
    expect(esriGeometryToGeoJson(null)).toBeNull();
    expect(esriGeometryToGeoJson({})).toBeNull();
    expect(esriGeometryToGeoJson({ rings: [] })).toBeNull();
  });
});

describe('esriGeometryTypeToGeoJson', () => {
  it('maps every Esri geometry type it supports', () => {
    expect(esriGeometryTypeToGeoJson('esriGeometryPoint')).toBe('Point');
    expect(esriGeometryTypeToGeoJson('esriGeometryPolyline')).toBe('MultiLineString');
    expect(esriGeometryTypeToGeoJson('esriGeometryPolygon')).toBe('MultiPolygon');
    expect(esriGeometryTypeToGeoJson('esriGeometryMultipoint')).toBe('MultiPoint');
    expect(esriGeometryTypeToGeoJson('somethingElse')).toBeNull();
    expect(esriGeometryTypeToGeoJson(null)).toBeNull();
  });
});

describe('normaliseAttributes', () => {
  it('keeps scalars, nulls missing values and serialises objects', () => {
    expect(
      normaliseAttributes({
        text: 'Survey 125/2',
        count: 4,
        flag: true,
        missing: null,
        nested: { a: 1 },
      }),
    ).toEqual({
      text: 'Survey 125/2',
      count: 4,
      flag: true,
      missing: null,
      nested: '{"a":1}',
    });
  });

  it('handles an absent attribute bag', () => {
    expect(normaliseAttributes(undefined)).toEqual({});
  });
});
