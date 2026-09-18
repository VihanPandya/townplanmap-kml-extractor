import { describe, expect, it } from 'vitest';
import {
  closeRings,
  describeGeometry,
  prepareForKml,
  validateWgs84Geometry,
  formatArea,
} from '@/lib/geo/geometry';
import { identifyCrs, normaliseCrsCode, geojsonDefaultCrs, transformerToWgs84, UNKNOWN_CRS } from '@/lib/geo/crs';
import type { Geometry } from '@/lib/geo/types';

const square: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [72.5, 23.0],
      [72.6, 23.0],
      [72.6, 23.1],
      [72.5, 23.1],
      [72.5, 23.0],
    ],
  ],
};

describe('normaliseCrsCode', () => {
  it('handles the many spellings of an EPSG code', () => {
    expect(normaliseCrsCode(4326)).toBe('EPSG:4326');
    expect(normaliseCrsCode('4326')).toBe('EPSG:4326');
    expect(normaliseCrsCode('EPSG:4326')).toBe('EPSG:4326');
    expect(normaliseCrsCode('urn:ogc:def:crs:EPSG::4326')).toBe('EPSG:4326');
    expect(normaliseCrsCode('http://www.opengis.net/def/crs/EPSG/0/3857')).toBe('EPSG:3857');
    expect(normaliseCrsCode('CRS:84')).toBe('EPSG:4326');
  });

  it('maps the ArcGIS web-mercator WKIDs onto EPSG:3857', () => {
    expect(normaliseCrsCode(102100)).toBe('EPSG:3857');
    expect(normaliseCrsCode(900913)).toBe('EPSG:3857');
  });

  it('returns null when there is nothing to read', () => {
    expect(normaliseCrsCode(null)).toBeNull();
    expect(normaliseCrsCode(undefined)).toBeNull();
    expect(normaliseCrsCode('')).toBeNull();
    expect(normaliseCrsCode('some projection')).toBeNull();
  });
});

describe('identifyCrs', () => {
  it('marks an undeclared CRS as unknown rather than assuming WGS84', () => {
    const crs = identifyCrs(null);
    expect(crs.code).toBeNull();
    expect(crs.confidence).toBe('unknown');
    expect(crs.transformable).toBe(false);
  });

  it('distinguishes a spec default from a declared value', () => {
    expect(geojsonDefaultCrs().confidence).toBe('assumed-by-spec');
    expect(identifyCrs(4326).confidence).toBe('declared');
  });
});

describe('transformerToWgs84', () => {
  it('is a no-op for WGS84', () => {
    const transform = transformerToWgs84('EPSG:4326');
    expect(transform).not.toBeNull();
    expect(transform?.([72.5, 23.0])).toEqual([72.5, 23.0]);
  });

  it('converts web mercator metres to degrees', () => {
    const transform = transformerToWgs84('EPSG:3857');
    expect(transform).not.toBeNull();
    const [lon, lat] = transform?.([8070000, 2630000]) ?? [];
    // Cross-checked against the closed-form spherical Mercator inverse:
    // lon = x/R, lat = 2*atan(exp(y/R)) - pi/2, with R = 6378137.
    expect(lon).toBeCloseTo(72.494043, 4);
    expect(lat).toBeCloseTo(22.983307, 4);
  });

  it('converts UTM zone 43N metres to degrees', () => {
    const transform = transformerToWgs84('EPSG:32643');
    expect(transform).not.toBeNull();
    const [lon, lat] = transform?.([449000, 2544000]) ?? [];
    // Ahmedabad sits in UTM zone 43N; the result must land in Gujarat.
    expect(lon).toBeGreaterThan(70);
    expect(lon).toBeLessThan(75);
    expect(lat).toBeGreaterThan(21);
    expect(lat).toBeLessThan(25);
  });

  it('returns null for an unknown CRS', () => {
    expect(transformerToWgs84(null)).toBeNull();
    expect(transformerToWgs84('EPSG:999999')).toBeNull();
  });

  it('preserves an elevation ordinate', () => {
    const transform = transformerToWgs84('EPSG:3857');
    expect(transform?.([8070000, 2630000, 55])?.[2]).toBe(55);
  });
});

describe('describeGeometry', () => {
  it('counts vertices, rings and the bounding box', () => {
    const stats = describeGeometry(square);
    expect(stats.type).toBe('Polygon');
    expect(stats.vertices).toBe(5);
    expect(stats.rings).toBe(1);
    expect(stats.bbox).toEqual([72.5, 23.0, 72.6, 23.1]);
  });

  it('counts inner rings separately', () => {
    const withHole: Geometry = {
      type: 'Polygon',
      coordinates: [
        square.type === 'Polygon' ? (square.coordinates[0] ?? []) : [],
        [
          [72.52, 23.02],
          [72.55, 23.02],
          [72.55, 23.05],
          [72.52, 23.02],
        ],
      ],
    };
    const stats = describeGeometry(withHole);
    expect(stats.rings).toBe(2);
    expect(stats.innerRings).toBe(1);
  });
});

describe('closeRings', () => {
  it('closes an open ring by repeating its first position', () => {
    const open: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    };
    const { geometry, closed } = closeRings(open);
    expect(closed).toBe(1);
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : [];
    expect(ring?.length).toBe(5);
    expect(ring?.[4]).toEqual([0, 0]);
  });

  it('leaves an already-closed ring untouched', () => {
    const { closed } = closeRings(square);
    expect(closed).toBe(0);
  });
});

describe('validateWgs84Geometry', () => {
  it('accepts a well-formed polygon', () => {
    const result = validateWgs84Geometry(square);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('rejects NaN and Infinity coordinates', () => {
    const broken: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [Number.NaN, 1],
          [1, Number.POSITIVE_INFINITY],
          [0, 0],
        ],
      ],
    };
    const result = validateWgs84Geometry(broken);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'non-finite-coordinate')).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    const outside: Geometry = {
      type: 'Point',
      coordinates: [8070000, 2630000], // metres, not degrees
    };
    const result = validateWgs84Geometry(outside);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'out-of-range')).toBe(true);
  });

  it('rejects an unclosed ring', () => {
    const open: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    };
    const result = validateWgs84Geometry(open);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'unclosed-ring')).toBe(true);
  });

  it('rejects a ring with too few positions', () => {
    const sliver: Geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] };
    const result = validateWgs84Geometry(sliver);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'insufficient-vertices')).toBe(true);
  });

  it('rejects an empty geometry', () => {
    const empty: Geometry = { type: 'Polygon', coordinates: [] };
    expect(validateWgs84Geometry(empty).valid).toBe(false);
  });
});

describe('prepareForKml', () => {
  it('refuses to guess when the CRS is unknown', () => {
    const result = prepareForKml(square, UNKNOWN_CRS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown/i);
  });

  it('passes WGS84 geometry through unchanged', () => {
    const result = prepareForKml(square, identifyCrs(4326));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transformed).toBe(false);
      expect(result.validation.valid).toBe(true);
    }
  });

  it('transforms projected coordinates and then validates them', () => {
    const mercator: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [8070000, 2630000],
          [8080000, 2630000],
          [8080000, 2640000],
          [8070000, 2640000],
          [8070000, 2630000],
        ],
      ],
    };
    const result = prepareForKml(mercator, identifyCrs(3857));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transformed).toBe(true);
      expect(result.validation.valid).toBe(true);
      const first = result.geometry.type === 'Polygon' ? result.geometry.coordinates[0]?.[0] : null;
      expect(first?.[0]).toBeGreaterThan(70);
      expect(first?.[0]).toBeLessThan(75);
    }
  });

  it('closes an open ring and reports that it did so', () => {
    const open: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [72.5, 23.0],
          [72.6, 23.0],
          [72.6, 23.1],
          [72.5, 23.1],
        ],
      ],
    };
    const result = prepareForKml(open, identifyCrs(4326));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ringsClosed).toBe(1);
      expect(result.validation.valid).toBe(true);
      expect(result.validation.issues.some((issue) => issue.code === 'ring-closed')).toBe(true);
    }
  });
});

describe('formatArea', () => {
  it('uses hectares above a hectare and square metres below', () => {
    expect(formatArea(23400)).toBe('2.34 ha');
    expect(formatArea(500)).toBe('500 m²');
    expect(formatArea(null)).toBeNull();
  });
});
