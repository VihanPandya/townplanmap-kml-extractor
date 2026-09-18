import { describe, expect, it } from 'vitest';
import { buildKmlDocument, buildPlacemark, formatPosition, geometryToKml } from '@/lib/kml/builder';
import { validateKml } from '@/lib/kml/validate';
import { parseKml, parseCoordinates } from '@/lib/kml/parse';
import { escapeXml, sanitiseFilename, buildFeatureFilename, uniquifyFilename } from '@/lib/kml/sanitize';
import { sanitisePath } from '@/lib/kml/package';
import { identifyCrs, UNKNOWN_CRS } from '@/lib/geo/crs';
import type { FeatureRecord } from '@/lib/discovery/types';
import type { Geometry } from '@/lib/geo/types';

function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  const geometry: Geometry = {
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
  return {
    id: 'feat_1',
    layerId: 'layer_1',
    sourceFeatureId: '1',
    name: 'Survey 125/2',
    geometryType: 'Polygon',
    properties: { survey_number: '125/2', village: 'Example Village', empty_field: null },
    geometry,
    crs: identifyCrs(4326),
    provenance: 'source-geometry',
    provenanceNote: 'Coordinates are exactly as the service published them.',
    areaSquareMetres: 23400,
    bbox: [72.5, 23.0, 72.6, 23.1],
    kmlAvailable: true,
    kmlNote: 'ok',
    sourceUrl: 'https://example.org/FeatureServer/0',
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes the five XML entities', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  it('strips control characters XML forbids', () => {
    const raw = `bad${String.fromCharCode(0)}${String.fromCharCode(7)}value`;
    expect(escapeXml(raw)).toBe('badvalue');
  });

  it('neutralises an attempted tag injection from a source attribute', () => {
    const escaped = escapeXml('</name><Placemark><name>injected');
    expect(escaped).not.toContain('<Placemark>');
    expect(escaped).toContain('&lt;Placemark&gt;');
  });
});

describe('sanitiseFilename', () => {
  it('strips path traversal', () => {
    expect(sanitiseFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitiseFilename('../../etc/passwd')).not.toContain('/');
  });

  it('replaces characters that are invalid on Windows', () => {
    expect(sanitiseFilename('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('escapes reserved device names', () => {
    expect(sanitiseFilename('CON')).toBe('_CON');
    expect(sanitiseFilename('nul.kml')).toBe('_nul.kml');
  });

  it('falls back when nothing usable survives', () => {
    expect(sanitiseFilename('///', 'fallback')).toBe('fallback');
  });

  it('builds a location-prefixed feature filename', () => {
    expect(buildFeatureFilename('Ahmedabad', 'Survey 125/2')).toBe('Ahmedabad_Survey_125_2.kml');
  });

  it('de-duplicates repeated filenames', () => {
    const used = new Set<string>();
    expect(uniquifyFilename('a.kml', used)).toBe('a.kml');
    expect(uniquifyFilename('a.kml', used)).toBe('a_2.kml');
    expect(uniquifyFilename('a.kml', used)).toBe('a_3.kml');
  });
});

describe('sanitisePath', () => {
  it('drops traversal segments but keeps the folder structure', () => {
    expect(sanitisePath('KML/../../../etc/passwd')).toBe('KML/etc/passwd');
    expect(sanitisePath('Individual/Survey_125_2.kml')).toBe('Individual/Survey_125_2.kml');
  });
});

describe('formatPosition', () => {
  it('writes lon,lat in KML order and trims false precision', () => {
    expect(formatPosition([72.5, 23.0])).toBe('72.5,23');
    expect(formatPosition([72.5, 23.0, 15])).toBe('72.5,23,15');
  });

  it('rejects a non-numeric pair', () => {
    expect(() => formatPosition([Number.NaN as number, 1])).not.toThrow();
  });
});

describe('geometryToKml', () => {
  it('writes outer and inner boundaries for a polygon with a hole', () => {
    const withHole: Geometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
        [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]],
      ],
    };
    const xml = geometryToKml(withHole);
    expect(xml).toContain('<outerBoundaryIs>');
    expect(xml).toContain('<innerBoundaryIs>');
  });

  it('writes a MultiGeometry for a MultiPolygon', () => {
    const multi: Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]]],
      ],
    };
    const xml = geometryToKml(multi);
    expect(xml).toContain('<MultiGeometry>');
    expect((xml.match(/<Polygon>/g) ?? []).length).toBe(2);
  });
});

describe('buildPlacemark', () => {
  it('writes the name, description and ExtendedData', () => {
    const result = buildPlacemark(makeFeature());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xml).toContain('<name>Survey 125/2</name>');
    expect(result.xml).toContain('Source: TownPlanMap');
    expect(result.xml).toContain('<Data name="survey_number">');
    expect(result.xml).toContain('<value>125/2</value>');
    expect(result.xml).toContain('<Data name="village">');
  });

  it('omits attributes the source left empty rather than writing "null"', () => {
    const result = buildPlacemark(makeFeature());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xml).not.toContain('empty_field');
  });

  it('records provenance in ExtendedData', () => {
    const result = buildPlacemark(makeFeature());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xml).toContain('<Data name="provenance">');
    expect(result.xml).toContain('<value>source-geometry</value>');
  });

  it('refuses a feature with no geometry', () => {
    const result = buildPlacemark(makeFeature({ geometry: null }));
    expect(result.ok).toBe(false);
  });

  it('refuses a feature whose CRS is unknown rather than guessing', () => {
    const result = buildPlacemark(makeFeature({ crs: UNKNOWN_CRS }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown/i);
  });

  it('refuses a feature whose geometry is invalid', () => {
    const broken = makeFeature({
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [Number.NaN, 1], [1, 1], [0, 0]]] },
    });
    const result = buildPlacemark(broken);
    expect(result.ok).toBe(false);
  });

  it('marks geometry as converted when a transform was applied', () => {
    const projected = makeFeature({
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
    const result = buildPlacemark(projected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xml).toContain('<value>crs-converted</value>');
  });
});

describe('buildKmlDocument', () => {
  it('produces a document that validates', () => {
    const built = buildKmlDocument({
      documentName: 'Example Village',
      features: [makeFeature(), makeFeature({ id: 'feat_2', name: 'Survey 126/1' })],
    });
    expect(built.written).toBe(2);
    expect(built.skipped).toHaveLength(0);

    const report = validateKml(built.kml, built.written);
    expect(report.valid).toBe(true);
    expect(report.summary.features).toBe(2);
    expect(report.summary.polygons).toBe(2);
    for (const check of report.checks) {
      expect(check.passed, `${check.label}: ${check.detail}`).toBe(true);
    }
  });

  it('carries source attribution in the document', () => {
    const built = buildKmlDocument({
      documentName: 'Example',
      sourceDataset: 'TP Scheme 01',
      features: [makeFeature()],
    });
    expect(built.kml).toContain('Source: TownPlanMap');
    expect(built.kml).toContain('https://townplanmap.com');
    expect(built.kml).toContain('<Data name="extraction_date">');
    expect(built.kml).toContain('<value>TP Scheme 01</value>');
  });

  it('nests folders rather than flattening them', () => {
    const built = buildKmlDocument({
      documentName: 'Ahmedabad',
      folders: [
        { path: ['Ahmedabad', 'TP Schemes'], features: [makeFeature({ name: 'TP 01' })] },
        { path: ['Ahmedabad', 'Villages'], features: [makeFeature({ id: 'f2', name: 'Village A' })] },
      ],
    });
    const parsed = parseKml(built.kml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const paths = parsed.kml.placemarks.map((placemark) => placemark.folderPath.join('/'));
    expect(paths).toContain('Ahmedabad/TP Schemes');
    expect(paths).toContain('Ahmedabad/Villages');
  });

  it('reports skipped features instead of silently dropping them', () => {
    const built = buildKmlDocument({
      documentName: 'Mixed',
      features: [makeFeature(), makeFeature({ id: 'bad', geometry: null })],
    });
    expect(built.written).toBe(1);
    expect(built.skipped).toHaveLength(1);
    expect(built.skipped[0]?.featureId).toBe('bad');
  });

  it('survives a round trip through the parser with attributes intact', () => {
    const built = buildKmlDocument({ documentName: 'Round trip', features: [makeFeature()] });
    const parsed = parseKml(built.kml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const placemark = parsed.kml.placemarks[0];
    expect(placemark?.name).toBe('Survey 125/2');
    expect(placemark?.properties.survey_number).toBe('125/2');
    expect(placemark?.geometry?.type).toBe('Polygon');
  });
});

describe('validateKml', () => {
  it('fails a document that is not well-formed XML', () => {
    const report = validateKml('<kml><Document><name>broken</Document></kml>', 0);
    expect(report.valid).toBe(false);
    expect(report.checks[0]?.id).toBe('xml');
    expect(report.checks[0]?.passed).toBe(false);
  });

  it('fails when the feature count does not match what was written', () => {
    const built = buildKmlDocument({ documentName: 'X', features: [makeFeature()] });
    const report = validateKml(built.kml, 5);
    expect(report.valid).toBe(false);
    expect(report.checks.find((check) => check.id === 'feature-count')?.passed).toBe(false);
  });
});

describe('parseCoordinates', () => {
  it('reads lon,lat,alt tuples', () => {
    expect(parseCoordinates('72.5,23.0,0 72.6,23.1')).toEqual([
      [72.5, 23, 0],
      [72.6, 23.1],
    ]);
  });

  it('ignores malformed tuples', () => {
    expect(parseCoordinates('abc,def 72.5,23.0')).toEqual([[72.5, 23]]);
  });

  it('handles an empty input', () => {
    expect(parseCoordinates(undefined)).toEqual([]);
    expect(parseCoordinates('   ')).toEqual([]);
  });
});

describe('parseKml', () => {
  it('rejects a document declaring a DOCTYPE (entity-expansion guard)', () => {
    const hostile = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [<!ENTITY lol "lol">]>',
      '<kml><Document><name>&lol;</name></Document></kml>',
    ].join('\n');
    const result = parseKml(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DOCTYPE/i);
  });

  it('reads a MultiGeometry of polygons as a MultiPolygon', () => {
    const kml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      '<Placemark><name>Two parts</name><MultiGeometry>',
      '<Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon>',
      '<Polygon><outerBoundaryIs><LinearRing><coordinates>2,2 3,2 3,3 2,2</coordinates></LinearRing></outerBoundaryIs></Polygon>',
      '</MultiGeometry></Placemark>',
      '</Document></kml>',
    ].join('');
    const result = parseKml(kml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kml.placemarks[0]?.geometry?.type).toBe('MultiPolygon');
  });
});
