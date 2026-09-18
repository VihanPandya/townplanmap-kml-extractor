/**
 * Tests for the guarantees the product is built on: nothing approximate is
 * described as exact, nothing is exported without a resolvable coordinate
 * system, and synthetic demonstration data is never attributed to the source.
 */

import { describe, expect, it } from 'vitest';
import { buildKmlDocument, buildPlacemark } from '@/lib/kml/builder';
import { parseKml } from '@/lib/kml/parse';
import { validateKml } from '@/lib/kml/validate';
import { identifyCrs, UNKNOWN_CRS } from '@/lib/geo/crs';
import type { FeatureRecord, Provenance } from '@/lib/discovery/types';
import type { Geometry } from '@/lib/geo/types';

const SQUARE: Geometry = {
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

function feature(provenance: Provenance, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    id: `feat_${provenance}`,
    layerId: 'layer_1',
    sourceFeatureId: '1',
    name: 'Example feature',
    geometryType: 'Polygon',
    properties: { village: 'Example Village' },
    geometry: SQUARE,
    crs: identifyCrs(4326),
    provenance,
    provenanceNote: 'note',
    areaSquareMetres: 1000,
    bbox: [72.5, 23.0, 72.6, 23.1],
    kmlAvailable: true,
    kmlNote: 'ok',
    sourceUrl: 'https://example.org/FeatureServer/0',
    ...overrides,
  };
}

/** Read a `<Data name="x">` value back out of generated KML. */
function extendedValue(kml: string, name: string): string | null {
  const parsed = parseKml(kml);
  if (!parsed.ok) return null;
  const value = parsed.kml.placemarks[0]?.properties[name];
  return value === undefined || value === null ? null : String(value);
}

describe('provenance survives into the exported document', () => {
  it('records each provenance status in ExtendedData', () => {
    for (const provenance of [
      'source-geometry',
      'tile-decoded',
      'unverified',
      'synthetic-fixture',
    ] as const) {
      const built = buildKmlDocument({ documentName: 'X', features: [feature(provenance)] });
      expect(extendedValue(built.kml, 'provenance'), provenance).toBe(provenance);
    }
  });

  it('never describes tile-decoded geometry as exact', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('tile-decoded')] });
    const parsed = parseKml(built.kml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const description = parsed.kml.placemarks[0]?.description ?? '';
    expect(description).toMatch(/generalised/i);
    expect(description).not.toMatch(/\bexact(ly)?\b/i);
  });

  it('describes source geometry as published, without hedging', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('source-geometry')] });
    const parsed = parseKml(built.kml);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.kml.placemarks[0]?.description).toMatch(/exactly as published/i);
  });

  it('marks CRS-converted geometry as converted rather than as source geometry', () => {
    const projected = feature('source-geometry', {
      crs: identifyCrs(3857),
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [8070000, 2630000],
            [8080000, 2630000],
            [8080000, 2640000],
            [8070000, 2630000],
          ],
        ],
      },
    });
    const built = buildKmlDocument({ documentName: 'X', features: [projected] });
    expect(extendedValue(built.kml, 'provenance')).toBe('crs-converted');
  });
});

describe('synthetic data is never attributed to the source', () => {
  it('does not name TownPlanMap as the source of a synthetic feature', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('synthetic-fixture')] });
    const source = extendedValue(built.kml, 'source') ?? '';

    expect(source).toMatch(/synthetic/i);
    expect(source).toMatch(/NOT from TownPlanMap/i);
  });

  it('still names TownPlanMap for genuine source geometry', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('source-geometry')] });
    expect(extendedValue(built.kml, 'source')).toBe('TownPlanMap');
  });

  it('carries the synthetic warning in the placemark description', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('synthetic-fixture')] });
    const parsed = parseKml(built.kml);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.kml.placemarks[0]?.description).toMatch(/SYNTHETIC SAMPLE DATA/);
  });
});

describe('nothing is exported without a resolvable coordinate system', () => {
  it('excludes a feature whose CRS the source never declared', () => {
    const built = buildKmlDocument({
      documentName: 'X',
      features: [feature('source-geometry'), feature('source-geometry', { id: 'no_crs', crs: UNKNOWN_CRS })],
    });

    expect(built.written).toBe(1);
    expect(built.skipped).toHaveLength(1);
    expect(built.skipped[0]?.featureId).toBe('no_crs');
    expect(built.skipped[0]?.reason).toMatch(/unknown/i);
    // And it really is absent from the document, not merely reported.
    expect(built.kml).not.toContain('no_crs');
  });

  it('excludes a feature whose CRS has no transform available', () => {
    const exotic = feature('source-geometry', {
      id: 'exotic',
      crs: identifyCrs(99999, 'declared but unsupported'),
    });
    const result = buildPlacemark(exotic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no transformation/i);
  });

  it('excludes an image-only feature and says why', () => {
    const imageOnly = feature('image-only', { id: 'img', geometry: null });
    const result = buildPlacemark(imageOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/imagery/i);
  });
});

describe('every generated document carries attribution', () => {
  it('records source, original source URL and extraction date', () => {
    const built = buildKmlDocument({
      documentName: 'Example Village',
      sourceDataset: 'Land Parcels',
      sourcePage: 'https://example.org/FeatureServer/0',
      features: [feature('source-geometry')],
    });

    expect(built.kml).toContain('Source: TownPlanMap');
    expect(built.kml).toContain('Original source: https://townplanmap.com');
    expect(built.kml).toMatch(/Extraction date: \d{4}-\d{2}-\d{2}/);
    expect(built.kml).toContain('Original dataset: Land Parcels');
    expect(built.kml).toMatch(/independently verified/i);
  });

  it('keeps attribution machine-readable on the document as well as in prose', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [feature('source-geometry')] });
    expect(built.kml).toContain('<Data name="source_url">');
    expect(built.kml).toContain('<Data name="generator">');
    expect(built.kml).toContain('<value>TownPlanMap KML Extractor</value>');
  });

  it('produces a document that passes its own validation', () => {
    const built = buildKmlDocument({
      documentName: 'X',
      features: [feature('source-geometry'), feature('tile-decoded', { id: 'b' })],
    });
    const report = validateKml(built.kml, built.written);
    expect(report.valid).toBe(true);
  });
});
