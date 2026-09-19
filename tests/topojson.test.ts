/**
 * TopoJSON decoding.
 *
 * The two things that can silently produce wrong geometry are delta decoding
 * (skip the cumulative step and the shape is subtly wrong) and arc reversal
 * (get it wrong and holes turn inside out), so both are tested directly.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeArc,
  isTopology,
  stitchArcs,
  topoGeometryToGeoJson,
  topologyObjectNames,
  topologyToFeatures,
  type Topology,
} from '@/lib/discovery/providers/topojson';
import { validateWgs84Geometry } from '@/lib/geo/geometry';
import type { Position } from '@/lib/geo/types';

/**
 * A quantised topology covering two adjacent square plots that share an edge.
 *
 * With `scale` 0.001 and `translate` [72.5, 23.0], integer position [0,0] is
 * (72.5, 23.0) and [10,10] is (72.51, 23.01).
 *
 * Arc 0 is the shared edge, running north along x=10. Arc 1 closes the west
 * plot around it, arc 2 closes the east plot. The west plot traverses the
 * shared edge forwards; the east plot traverses it backwards, as `~0`.
 */
const QUANTISED: Topology = {
  type: 'Topology',
  transform: { scale: [0.001, 0.001], translate: [72.5, 23.0] },
  // Positions are cumulative deltas.
  arcs: [
    // Arc 0: (10,0) -> (10,10)
    [
      [10, 0],
      [0, 10],
    ],
    // Arc 1: (10,10) -> (0,10) -> (0,0) -> (10,0)
    [
      [10, 10],
      [-10, 0],
      [0, -10],
      [10, 0],
    ],
    // Arc 2: (10,10) -> (20,10) -> (20,0) -> (10,0)
    [
      [10, 10],
      [10, 0],
      [0, -10],
      [-10, 0],
    ],
  ],
  objects: {
    plots: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', id: 'west', arcs: [[0, 1]], properties: { survey_no: '125/2' } },
        { type: 'Polygon', id: 'east', arcs: [[2, ~0]], properties: { survey_no: '126/1' } },
      ],
    },
  },
};

/** The same shapes without quantisation, as absolute coordinates. */
const UNQUANTISED: Topology = {
  type: 'Topology',
  arcs: [
    [
      [72.51, 23.0],
      [72.51, 23.01],
    ],
    [
      [72.51, 23.01],
      [72.5, 23.01],
      [72.5, 23.0],
      [72.51, 23.0],
    ],
  ],
  objects: {
    plots: {
      type: 'GeometryCollection',
      geometries: [{ type: 'Polygon', id: 'west', arcs: [[0, 1]], properties: {} }],
    },
  },
};

describe('isTopology', () => {
  it('accepts a topology and rejects anything else', () => {
    expect(isTopology(QUANTISED)).toBe(true);
    expect(isTopology({ type: 'FeatureCollection', features: [] })).toBe(false);
    expect(isTopology(null)).toBe(false);
    expect(isTopology({ type: 'Topology' })).toBe(false); // no arcs
  });
});

describe('decodeArc', () => {
  it('accumulates deltas and applies the transform', () => {
    const decoded = decodeArc(QUANTISED.arcs[0]!, QUANTISED.transform);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.[0]).toBeCloseTo(72.51, 9);
    expect(decoded[0]?.[1]).toBeCloseTo(23.0, 9);
    // The second position is the running sum (10,0) + (0,10) = (10,10).
    expect(decoded[1]?.[0]).toBeCloseTo(72.51, 9);
    expect(decoded[1]?.[1]).toBeCloseTo(23.01, 9);
  });

  it('passes positions straight through when there is no transform', () => {
    expect(decodeArc(UNQUANTISED.arcs[0]!, undefined)).toEqual([
      [72.51, 23.0],
      [72.51, 23.01],
    ]);
  });

  it('would produce a different result without the cumulative step', () => {
    // Guards the delta decoding itself: treating deltas as absolute values
    // gives (0,10) for the second position rather than (10,10).
    const decoded = decodeArc(QUANTISED.arcs[0]!, QUANTISED.transform);
    const naive = QUANTISED.arcs[0]!.map(
      ([x, y]) => [x! * 0.001 + 72.5, y! * 0.001 + 23.0] as Position,
    );
    expect(decoded[1]).not.toEqual(naive[1]);
  });
});

describe('stitchArcs', () => {
  const arcs: Position[][] = [
    [
      [0, 0],
      [1, 0],
    ],
    [
      [1, 0],
      [1, 1],
    ],
  ];

  it('joins consecutive arcs without duplicating the shared position', () => {
    expect(stitchArcs([0, 1], arcs)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('reverses an arc referenced by its one’s complement', () => {
    expect(stitchArcs([~0], arcs)).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });

  it('ignores an index that points at no arc', () => {
    expect(stitchArcs([99], arcs)).toEqual([]);
  });

  it('returns nothing for an empty index list', () => {
    expect(stitchArcs([], arcs)).toEqual([]);
  });
});

describe('topoGeometryToGeoJson', () => {
  it('builds a closed polygon from quantised arcs', () => {
    const features = topologyToFeatures(QUANTISED, 'plots');
    const west = features.find((feature) => feature.id === 'west');

    expect(west?.geometry?.type).toBe('Polygon');
    if (west?.geometry?.type !== 'Polygon') return;

    const ring = west.geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(validateWgs84Geometry(west.geometry).valid).toBe(true);
  });

  it('places the decoded geometry at the right coordinates', () => {
    const features = topologyToFeatures(QUANTISED, 'plots');
    const west = features.find((feature) => feature.id === 'west');
    if (west?.geometry?.type !== 'Polygon') throw new Error('expected a polygon');

    const longitudes = west.geometry.coordinates[0]!.map((position) => position[0] as number);
    const latitudes = west.geometry.coordinates[0]!.map((position) => position[1] as number);

    expect(Math.min(...longitudes)).toBeCloseTo(72.5, 6);
    expect(Math.max(...longitudes)).toBeCloseTo(72.51, 6);
    expect(Math.min(...latitudes)).toBeCloseTo(23.0, 6);
    expect(Math.max(...latitudes)).toBeCloseTo(23.01, 6);
  });

  it('builds the neighbouring plot by traversing the shared arc backwards', () => {
    const features = topologyToFeatures(QUANTISED, 'plots');
    const east = features.find((feature) => feature.id === 'east');
    if (east?.geometry?.type !== 'Polygon') throw new Error('expected a polygon');

    const longitudes = east.geometry.coordinates[0]!.map((position) => position[0] as number);
    // The east plot spans the far side of the shared edge.
    expect(Math.min(...longitudes)).toBeCloseTo(72.51, 6);
    expect(Math.max(...longitudes)).toBeCloseTo(72.52, 6);
    expect(validateWgs84Geometry(east.geometry).valid).toBe(true);
  });

  it('decodes a point through the transform', () => {
    const geometry = topoGeometryToGeoJson(
      { type: 'Point', coordinates: [10, 10] },
      [],
      QUANTISED.transform,
    );
    expect(geometry?.type).toBe('Point');
    if (geometry?.type !== 'Point') return;
    expect(geometry.coordinates[0]).toBeCloseTo(72.51, 9);
    expect(geometry.coordinates[1]).toBeCloseTo(23.01, 9);
  });

  it('builds a MultiPolygon from nested arc lists', () => {
    const geometry = topoGeometryToGeoJson(
      { type: 'MultiPolygon', arcs: [[[0, 1]], [[2, ~0]]] },
      QUANTISED.arcs.map((arc) => decodeArc(arc, QUANTISED.transform)),
      undefined,
    );
    expect(geometry?.type).toBe('MultiPolygon');
    if (geometry?.type !== 'MultiPolygon') return;
    expect(geometry.coordinates).toHaveLength(2);
  });

  it('returns null for an unrecognised geometry type', () => {
    expect(topoGeometryToGeoJson({ type: 'Nonsense' }, [], undefined)).toBeNull();
  });

  it('drops a ring with too few positions rather than emitting it', () => {
    const geometry = topoGeometryToGeoJson({ type: 'Polygon', arcs: [[99]] }, [], undefined);
    expect(geometry).toBeNull();
  });
});

describe('topologyToFeatures', () => {
  it('yields one feature per child of a GeometryCollection object', () => {
    const features = topologyToFeatures(QUANTISED);
    expect(features).toHaveLength(2);
    expect(features.map((feature) => feature.id).sort()).toEqual(['east', 'west']);
  });

  it('carries properties through', () => {
    const features = topologyToFeatures(QUANTISED, 'plots');
    expect(features[0]?.properties.survey_no).toBe('125/2');
  });

  it('records which object each feature came from', () => {
    const features = topologyToFeatures(QUANTISED);
    expect(features.every((feature) => feature.objectName === 'plots')).toBe(true);
  });

  it('narrows to a single object when one is named', () => {
    const multi: Topology = {
      ...QUANTISED,
      objects: {
        plots: QUANTISED.objects.plots!,
        villages: { type: 'GeometryCollection', geometries: [] },
      },
    };
    expect(topologyObjectNames(multi)).toEqual(['plots', 'villages']);
    expect(topologyToFeatures(multi, 'villages')).toHaveLength(0);
    expect(topologyToFeatures(multi, 'plots')).toHaveLength(2);
  });

  it('handles an unquantised topology', () => {
    const features = topologyToFeatures(UNQUANTISED, 'plots');
    expect(features).toHaveLength(1);
    if (features[0]?.geometry?.type !== 'Polygon') throw new Error('expected a polygon');
    expect(validateWgs84Geometry(features[0].geometry).valid).toBe(true);
  });
});
