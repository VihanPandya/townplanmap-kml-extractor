/**
 * Post-generation KML validation.
 *
 * The document is checked by parsing it back rather than by trusting the writer
 * that produced it, so a bug in generation surfaces here instead of in the
 * user's GIS software. Nothing is offered for download until these checks pass.
 */

import { LIMITS } from '@/lib/config';
import { parseKml } from './parse';
import { validateWgs84Geometry, describeGeometry } from '@/lib/geo/geometry';
import type { BoundingBox } from '@/lib/geo/types';

export type ValidationCheck = {
  id:
    | 'xml'
    | 'geometry'
    | 'coordinates'
    | 'closure'
    | 'finite'
    | 'crs'
    | 'feature-count'
    | 'size';
  label: string;
  passed: boolean;
  detail: string;
};

export type KmlValidationReport = {
  valid: boolean;
  checks: ValidationCheck[];
  summary: {
    features: number;
    polygons: number;
    lines: number;
    points: number;
    other: number;
    bytes: number;
    coordinateSystem: string;
    bbox: BoundingBox | null;
  };
};

/**
 * Validate a generated KML document.
 *
 * `expectedFeatures` is the number the export pipeline believes it wrote; a
 * mismatch against what parses back means features were lost, which is a
 * failure rather than a warning.
 */
export function validateKml(kml: string, expectedFeatures: number): KmlValidationReport {
  const checks: ValidationCheck[] = [];
  const bytes = Buffer.byteLength(kml, 'utf8');

  const summary = {
    features: 0,
    polygons: 0,
    lines: 0,
    points: 0,
    other: 0,
    bytes,
    coordinateSystem: 'WGS84 (EPSG:4326)',
    bbox: null as BoundingBox | null,
  };

  // --- 1. XML well-formedness ---------------------------------------------
  const parsed = parseKml(kml);
  if (!parsed.ok) {
    checks.push({ id: 'xml', label: 'XML valid', passed: false, detail: parsed.reason });
    return { valid: false, checks, summary };
  }
  checks.push({
    id: 'xml',
    label: 'XML valid',
    passed: true,
    detail: 'The document parses as well-formed XML with a <kml> root element.',
  });

  const placemarks = parsed.kml.placemarks;
  summary.features = placemarks.length;

  // --- 2 to 5. Geometry, coordinates, closure, finiteness ------------------
  let withGeometry = 0;
  let geometryErrors = 0;
  let unclosedRings = 0;
  let nonFinite = 0;
  let outOfRange = 0;
  let bbox: BoundingBox | null = null;

  for (const placemark of placemarks) {
    if (!placemark.geometry) continue;
    withGeometry += 1;

    const type = placemark.geometry.type;
    if (type.includes('Polygon')) summary.polygons += 1;
    else if (type.includes('LineString')) summary.lines += 1;
    else if (type.includes('Point')) summary.points += 1;
    else summary.other += 1;

    const validation = validateWgs84Geometry(placemark.geometry);
    for (const issue of validation.issues) {
      if (issue.severity !== 'error') continue;
      geometryErrors += 1;
      if (issue.code === 'unclosed-ring') unclosedRings += 1;
      if (issue.code === 'non-finite-coordinate') nonFinite += 1;
      if (issue.code === 'out-of-range') outOfRange += 1;
    }

    const stats = describeGeometry(placemark.geometry);
    if (stats.bbox) {
      bbox = bbox
        ? [
            Math.min(bbox[0], stats.bbox[0]),
            Math.min(bbox[1], stats.bbox[1]),
            Math.max(bbox[2], stats.bbox[2]),
            Math.max(bbox[3], stats.bbox[3]),
          ]
        : stats.bbox;
    }
  }

  summary.bbox = bbox;

  checks.push({
    id: 'geometry',
    label: 'Geometry valid',
    passed: geometryErrors === 0,
    detail:
      geometryErrors === 0
        ? `${withGeometry.toLocaleString()} placemark geometries parsed and validated.`
        : `${geometryErrors} geometry error(s) were found when the document was parsed back.`,
  });

  checks.push({
    id: 'coordinates',
    label: 'Coordinates valid',
    passed: outOfRange === 0,
    detail:
      outOfRange === 0
        ? 'All coordinates fall within the valid WGS84 range.'
        : `${outOfRange} coordinate(s) fall outside the valid longitude/latitude range.`,
  });

  checks.push({
    id: 'closure',
    label: 'Polygon closure',
    passed: unclosedRings === 0,
    detail:
      unclosedRings === 0
        ? 'Every polygon ring closes on its first position.'
        : `${unclosedRings} polygon ring(s) do not close.`,
  });

  checks.push({
    id: 'finite',
    label: 'No NaN or Infinity values',
    passed: nonFinite === 0,
    detail:
      nonFinite === 0
        ? 'No NaN, Infinity or non-numeric coordinate values are present.'
        : `${nonFinite} non-finite coordinate value(s) are present.`,
  });

  // --- 6. CRS --------------------------------------------------------------
  // KML has no CRS element: the specification fixes it to WGS84, so the check
  // is that every coordinate is consistent with that, which the range check
  // above establishes.
  checks.push({
    id: 'crs',
    label: 'WGS84 coordinates',
    passed: outOfRange === 0 && nonFinite === 0,
    detail:
      'KML is defined against WGS84 (EPSG:4326). All coordinates were verified to lie within that system’s valid range.',
  });

  // --- 7. Feature count ----------------------------------------------------
  const countMatches = placemarks.length === expectedFeatures;
  checks.push({
    id: 'feature-count',
    label: `${placemarks.length.toLocaleString()} features`,
    passed: countMatches,
    detail: countMatches
      ? `All ${expectedFeatures.toLocaleString()} feature(s) written are present in the document.`
      : `${expectedFeatures.toLocaleString()} feature(s) were written but ${placemarks.length.toLocaleString()} parsed back.`,
  });

  // --- 8. Size -------------------------------------------------------------
  const withinSize = bytes <= LIMITS.maxKmlBytes;
  checks.push({
    id: 'size',
    label: 'Within size limit',
    passed: withinSize,
    detail: withinSize
      ? `Document is ${formatBytes(bytes)}.`
      : `Document is ${formatBytes(bytes)}, above the ${formatBytes(LIMITS.maxKmlBytes)} limit.`,
  });

  return { valid: checks.every((check) => check.passed), checks, summary };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
