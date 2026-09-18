/**
 * KML generation.
 *
 * The document is written as text rather than through a DOM, which keeps
 * generation streaming-friendly for large layers. Every value that comes from
 * the source is escaped on the way in (see `sanitize.ts`), and the writer
 * refuses to emit a Placemark whose geometry did not pass validation — an
 * invalid geometry is reported to the caller and excluded, never rounded into
 * something that merely looks plausible.
 */

import { SOURCE } from '@/lib/config';
import type { Geometry, Position } from '@/lib/geo/types';
import { prepareForKml, type GeometryValidation } from '@/lib/geo/geometry';
import type { FeatureRecord, Provenance } from '@/lib/discovery/types';
import { escapeValue, escapeXml } from './sanitize';

/** Coordinate precision. 7 decimal places is ~1 cm — beyond any survey source. */
const COORDINATE_PRECISION = 7;

export type KmlStyle = {
  id: string;
  lineColour: string;
  lineWidth: number;
  fillColour: string;
  fill: boolean;
};

/**
 * Default styling.
 *
 * Deliberately neutral: a single blue outline with a light fill. Zoning
 * palettes carry legal meaning in planning documents, so the tool does not
 * invent colours that would imply a land-use classification the source never
 * stated. `aabbggrr` is KML's colour order, not `rrggbb`.
 */
export const DEFAULT_STYLES: KmlStyle[] = [
  { id: 'tpm-default-polygon', lineColour: 'ff3f6fd8', lineWidth: 2, fillColour: '332f6fd8', fill: true },
  { id: 'tpm-default-line', lineColour: 'ff3f6fd8', lineWidth: 3, fillColour: '00000000', fill: false },
  { id: 'tpm-default-point', lineColour: 'ff3f6fd8', lineWidth: 2, fillColour: '663f6fd8', fill: true },
];

function styleIdFor(geometryType: string | null): string {
  if (!geometryType) return 'tpm-default-polygon';
  if (geometryType.includes('Polygon')) return 'tpm-default-polygon';
  if (geometryType.includes('LineString')) return 'tpm-default-line';
  if (geometryType.includes('Point')) return 'tpm-default-point';
  return 'tpm-default-polygon';
}

function formatOrdinate(value: number): string {
  // Trim trailing zeros so the file does not carry false precision.
  const fixed = value.toFixed(COORDINATE_PRECISION);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Render one coordinate tuple in KML's `lon,lat[,alt]` order. */
export function formatPosition(position: Position): string {
  const [lon, lat, alt] = position;
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    throw new Error('Coordinate pair is not numeric.');
  }
  const base = `${formatOrdinate(lon)},${formatOrdinate(lat)}`;
  return typeof alt === 'number' && Number.isFinite(alt) ? `${base},${formatOrdinate(alt)}` : base;
}

function coordinatesBlock(positions: Position[], indent: string): string {
  return `${indent}<coordinates>${positions.map(formatPosition).join(' ')}</coordinates>`;
}

function polygonXml(rings: Position[][], indent: string): string {
  const [outer, ...inner] = rings;
  const lines: string[] = [`${indent}<Polygon>`];
  if (outer) {
    lines.push(`${indent}  <outerBoundaryIs>`);
    lines.push(`${indent}    <LinearRing>`);
    lines.push(coordinatesBlock(outer, `${indent}      `));
    lines.push(`${indent}    </LinearRing>`);
    lines.push(`${indent}  </outerBoundaryIs>`);
  }
  for (const ring of inner) {
    lines.push(`${indent}  <innerBoundaryIs>`);
    lines.push(`${indent}    <LinearRing>`);
    lines.push(coordinatesBlock(ring, `${indent}      `));
    lines.push(`${indent}    </LinearRing>`);
    lines.push(`${indent}  </innerBoundaryIs>`);
  }
  lines.push(`${indent}</Polygon>`);
  return lines.join('\n');
}

/** Render a GeoJSON geometry as KML. Assumes WGS84 coordinates. */
export function geometryToKml(geometry: Geometry, indent = '      '): string {
  switch (geometry.type) {
    case 'Point':
      return [`${indent}<Point>`, coordinatesBlock([geometry.coordinates], `${indent}  `), `${indent}</Point>`].join('\n');

    case 'MultiPoint':
      return [
        `${indent}<MultiGeometry>`,
        ...geometry.coordinates.map((position) =>
          [`${indent}  <Point>`, coordinatesBlock([position], `${indent}    `), `${indent}  </Point>`].join('\n'),
        ),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    case 'LineString':
      return [
        `${indent}<LineString>`,
        `${indent}  <tessellate>1</tessellate>`,
        coordinatesBlock(geometry.coordinates, `${indent}  `),
        `${indent}</LineString>`,
      ].join('\n');

    case 'MultiLineString':
      return [
        `${indent}<MultiGeometry>`,
        ...geometry.coordinates.map((line) =>
          [
            `${indent}  <LineString>`,
            `${indent}    <tessellate>1</tessellate>`,
            coordinatesBlock(line, `${indent}    `),
            `${indent}  </LineString>`,
          ].join('\n'),
        ),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    case 'Polygon':
      return polygonXml(geometry.coordinates, indent);

    case 'MultiPolygon':
      return [
        `${indent}<MultiGeometry>`,
        ...geometry.coordinates.map((polygon) => polygonXml(polygon, `${indent}  `)),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    case 'GeometryCollection':
      return [
        `${indent}<MultiGeometry>`,
        ...geometry.geometries.map((child) => geometryToKml(child, `${indent}  `)),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    default:
      throw new Error(`Geometry type "${(geometry as { type: string }).type}" cannot be written to KML.`);
  }
}

const PROVENANCE_LABELS: Record<Provenance, string> = {
  'source-geometry': 'Source geometry, exactly as published.',
  'crs-converted': 'Source geometry, converted from the source coordinate reference system to WGS84.',
  'tile-decoded': 'Decoded from vector tiles: generalised to the tile grid, not the surveyed boundary.',
  'image-only': 'Image only: no vector geometry was available.',
  'unverified': 'Geometry could not be independently verified.',
  'synthetic-fixture': 'SYNTHETIC SAMPLE DATA. Not from the source. For demonstration only.',
};

export type PlacemarkResult =
  | { ok: true; xml: string; validation: GeometryValidation }
  | { ok: false; reason: string; featureId: string };

export type BuildOptions = {
  documentName: string;
  /** Extra text placed in the document description, above the attribution. */
  documentDescription?: string;
  /** Layer / dataset name recorded in attribution. */
  sourceDataset?: string | null;
  sourcePage?: string | null;
  extractionDate?: string;
  /** Folder tree: folder path (outermost first) to the features inside it. */
  folders?: Array<{ path: string[]; features: FeatureRecord[] }>;
  /** Flat feature list, used when no folder structure is given. */
  features?: FeatureRecord[];
};

/** Render one feature as a `<Placemark>`, or explain why it cannot be. */
export function buildPlacemark(feature: FeatureRecord, indent = '    '): PlacemarkResult {
  if (!feature.geometry) {
    return {
      ok: false,
      featureId: feature.id,
      reason:
        feature.provenance === 'image-only'
          ? 'The source exposes only map imagery for this feature, so no geometry could be written.'
          : 'No geometry was available for this feature.',
    };
  }

  const prepared = prepareForKml(feature.geometry, feature.crs);
  if (!prepared.ok) {
    return { ok: false, featureId: feature.id, reason: prepared.reason };
  }
  if (!prepared.validation.valid) {
    const errors = prepared.validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join(' ');
    return { ok: false, featureId: feature.id, reason: errors || 'Geometry failed validation.' };
  }

  let geometryXml: string;
  try {
    geometryXml = geometryToKml(prepared.geometry, `${indent}  `);
  } catch (error) {
    return {
      ok: false,
      featureId: feature.id,
      reason: error instanceof Error ? error.message : 'Geometry could not be written to KML.',
    };
  }

  const provenance: Provenance = prepared.transformed && feature.provenance === 'source-geometry'
    ? 'crs-converted'
    : feature.provenance;

  const lines: string[] = [];
  lines.push(`${indent}<Placemark id="${escapeXml(feature.id)}">`);
  lines.push(`${indent}  <name>${escapeValue(feature.name)}</name>`);
  lines.push(`${indent}  <description>${escapeValue(describeFeature(feature, provenance))}</description>`);
  lines.push(`${indent}  <styleUrl>#${styleIdFor(prepared.geometry.type)}</styleUrl>`);

  const data = extendedData(feature, provenance, prepared.sourceCrs.code, `${indent}  `);
  if (data) lines.push(data);

  lines.push(geometryXml);
  lines.push(`${indent}</Placemark>`);

  return { ok: true, xml: lines.join('\n'), validation: prepared.validation };
}

/**
 * Name the true origin of a feature.
 *
 * Synthetic demonstration data must never be attributed to the real source, in
 * the document a user opens in their GIS software least of all.
 */
function sourceNameFor(provenance: Provenance): string {
  return provenance === 'synthetic-fixture'
    ? 'Synthetic sample data generated by the TownPlanMap KML Extractor \u2014 NOT from TownPlanMap'
    : SOURCE.name;
}

function describeFeature(feature: FeatureRecord, provenance: Provenance): string {
  const parts = [`Source: ${sourceNameFor(provenance)}`, PROVENANCE_LABELS[provenance]];
  if (feature.provenanceNote && feature.provenanceNote !== PROVENANCE_LABELS[provenance]) {
    parts.push(feature.provenanceNote);
  }
  return parts.join('\n');
}

/**
 * Write the feature's own attributes plus provenance into `<ExtendedData>`.
 *
 * Only attributes the source actually supplied are written out; no field is
 * invented to fill a gap, and empty values are dropped rather than emitted as
 * the string "null".
 */
function extendedData(
  feature: FeatureRecord,
  provenance: Provenance,
  crsCode: string | null,
  indent: string,
): string | null {
  const entries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(feature.properties)) {
    if (value === null || value === '') continue;
    if (key.startsWith('_')) continue; // internal bookkeeping fields
    entries.push([key, String(value)]);
  }

  if (feature.sourceFeatureId) entries.push(['feature_id', feature.sourceFeatureId]);
  if (feature.geometryType) entries.push(['geometry_type', feature.geometryType]);
  if (feature.areaSquareMetres !== null) {
    entries.push(['area_square_metres', feature.areaSquareMetres.toFixed(2)]);
  }
  if (crsCode) entries.push(['source_crs', crsCode]);
  entries.push(['provenance', provenance]);
  entries.push(['source', sourceNameFor(provenance)]);
  entries.push(['source_url', feature.sourceUrl]);

  if (entries.length === 0) return null;

  const lines = [`${indent}<ExtendedData>`];
  for (const [name, value] of entries) {
    lines.push(`${indent}  <Data name="${escapeXml(name)}">`);
    lines.push(`${indent}    <value>${escapeXml(value)}</value>`);
    lines.push(`${indent}  </Data>`);
  }
  lines.push(`${indent}</ExtendedData>`);
  return lines.join('\n');
}

function stylesXml(): string {
  return DEFAULT_STYLES.map((style) =>
    [
      `  <Style id="${style.id}">`,
      '    <LineStyle>',
      `      <color>${style.lineColour}</color>`,
      `      <width>${style.lineWidth}</width>`,
      '    </LineStyle>',
      '    <PolyStyle>',
      `      <color>${style.fillColour}</color>`,
      `      <fill>${style.fill ? 1 : 0}</fill>`,
      '      <outline>1</outline>',
      '    </PolyStyle>',
      '  </Style>',
    ].join('\n'),
  ).join('\n');
}

/**
 * Attribution block written into every document.
 *
 * Kept both as human-readable description text and as machine-readable
 * ExtendedData on the Document, so it survives a round trip through GIS
 * software that shows one but not the other.
 */
function documentAttribution(options: BuildOptions): { description: string; extended: string } {
  const extractionDate = options.extractionDate ?? new Date().toISOString().slice(0, 10);
  const lines = [
    options.documentDescription ?? '',
    '',
    `Source: ${SOURCE.name}`,
    `Original source: ${SOURCE.homepage}`,
    `Extraction date: ${extractionDate}`,
  ];
  if (options.sourceDataset) lines.push(`Original dataset: ${options.sourceDataset}`);
  if (options.sourcePage) lines.push(`Source page: ${options.sourcePage}`);
  lines.push(
    '',
    'Extracted geographic data should be independently verified before use in legal, surveying, property or',
    'other high-stakes decisions.',
  );

  const entries: Array<[string, string]> = [
    ['source', SOURCE.name],
    ['source_url', SOURCE.homepage],
    ['extraction_date', extractionDate],
    ['generator', 'TownPlanMap KML Extractor'],
  ];
  if (options.sourceDataset) entries.push(['source_dataset', options.sourceDataset]);
  if (options.sourcePage) entries.push(['source_page', options.sourcePage]);

  const extended = [
    '  <ExtendedData>',
    ...entries.flatMap(([name, value]) => [
      `    <Data name="${escapeXml(name)}">`,
      `      <value>${escapeXml(value)}</value>`,
      '    </Data>',
    ]),
    '  </ExtendedData>',
  ].join('\n');

  return { description: lines.join('\n').trim(), extended };
}

export type BuildResult = {
  kml: string;
  written: number;
  skipped: Array<{ featureId: string; reason: string }>;
  geometryCounts: { polygons: number; lines: number; points: number; collections: number };
};

/** Build a complete KML document. */
export function buildKmlDocument(options: BuildOptions): BuildResult {
  const skipped: Array<{ featureId: string; reason: string }> = [];
  const counts = { polygons: 0, lines: 0, points: 0, collections: 0 };
  let written = 0;

  const countGeometry = (type: string | null) => {
    if (!type) return;
    if (type.includes('Polygon')) counts.polygons += 1;
    else if (type.includes('LineString')) counts.lines += 1;
    else if (type.includes('Point')) counts.points += 1;
    else counts.collections += 1;
  };

  const renderFeatures = (features: FeatureRecord[], indent: string): string[] => {
    const out: string[] = [];
    for (const feature of features) {
      const result = buildPlacemark(feature, indent);
      if (!result.ok) {
        skipped.push({ featureId: result.featureId, reason: result.reason });
        continue;
      }
      out.push(result.xml);
      written += 1;
      countGeometry(feature.geometry?.type ?? feature.geometryType);
    }
    return out;
  };

  const body: string[] = [];

  if (options.folders && options.folders.length > 0) {
    // Build the folder tree so nested paths nest in the output rather than
    // producing a flat list of folders with slash-joined names.
    const tree = buildFolderTree(options.folders);
    body.push(...renderFolderTree(tree, '  ', renderFeatures));
  }
  if (options.features && options.features.length > 0) {
    body.push(...renderFeatures(options.features, '    '));
  }

  const attribution = documentAttribution(options);

  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${escapeValue(options.documentName)}</name>`,
    `    <description>${escapeValue(attribution.description)}</description>`,
    stylesXml(),
    attribution.extended,
    ...body,
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');

  return { kml, written, skipped, geometryCounts: counts };
}

type FolderNode = {
  name: string;
  features: FeatureRecord[];
  children: Map<string, FolderNode>;
};

function buildFolderTree(folders: Array<{ path: string[]; features: FeatureRecord[] }>): FolderNode {
  const root: FolderNode = { name: '', features: [], children: new Map() };

  for (const folder of folders) {
    let node = root;
    for (const segment of folder.path) {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, features: [], children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.features.push(...folder.features);
  }

  return root;
}

function renderFolderTree(
  node: FolderNode,
  indent: string,
  renderFeatures: (features: FeatureRecord[], indent: string) => string[],
): string[] {
  const out: string[] = [];

  if (node.name) {
    out.push(`${indent}<Folder>`);
    out.push(`${indent}  <name>${escapeValue(node.name)}</name>`);
    out.push(...renderFeatures(node.features, `${indent}  `));
    for (const child of node.children.values()) {
      out.push(...renderFolderTree(child, `${indent}  `, renderFeatures));
    }
    out.push(`${indent}</Folder>`);
    return out;
  }

  out.push(...renderFeatures(node.features, `${indent}  `));
  for (const child of node.children.values()) {
    out.push(...renderFolderTree(child, `${indent}  `, renderFeatures));
  }
  return out;
}
