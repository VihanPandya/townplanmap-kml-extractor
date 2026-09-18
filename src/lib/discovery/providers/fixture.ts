/**
 * Synthetic sample dataset for offline development and demonstration.
 *
 * DISABLED unless `TPM_ENABLE_FIXTURE_SOURCE=1`.
 *
 * This exists so the application can be exercised end to end without network
 * access to the source. None of it is real: the polygons are invented, the
 * survey numbers are invented, and the village is invented. Because the whole
 * point of this product is not to pass off invented boundaries as real ones,
 * every record it produces carries the `synthetic-fixture` provenance, which
 * the UI renders as a loud warning and which the KML writer stamps into each
 * placemark's description and ExtendedData.
 *
 * The names below are deliberately obvious placeholders rather than real
 * Gujarati village or survey references, so a stray export cannot be mistaken
 * for a genuine land record.
 */

import { identifyCrs } from '@/lib/geo/crs';
import { areaSquareMetres, describeGeometry } from '@/lib/geo/geometry';
import type { Geometry } from '@/lib/geo/types';
import type { DiscoveredEndpoint, FeatureRecord, LayerRecord, LocationRecord } from '../types';
import type { FeaturePage, FeatureQuery, GeoProvider, ProviderContext } from './base';
import { featureMatches } from './arcgis';

export const FIXTURE_URL = 'fixture://synthetic-sample-dataset';

const SYNTHETIC_NOTE =
  'SYNTHETIC SAMPLE DATA. These boundaries are invented for demonstration and are not from TownPlanMap or ' +
  'any land record. They must not be used for any real-world purpose.';

export function fixtureEndpoint(): DiscoveredEndpoint {
  return {
    id: 'ep_fixture',
    url: FIXTURE_URL,
    kind: 'geojson',
    nature: 'vector',
    discoveredIn: 'the built-in synthetic sample dataset',
    evidence: [SYNTHETIC_NOTE],
    probe: {
      reachable: true,
      status: 200,
      contentType: 'application/geo+json',
      bytes: 0,
      detail: { note: SYNTHETIC_NOTE },
    },
  };
}

export function fixtureCities(): LocationRecord[] {
  return [
    {
      id: 'city_sample',
      name: 'Sample City (synthetic)',
      kind: 'city',
      parentId: null,
      sourceUrl: FIXTURE_URL,
      sourceField: 'fixture',
    },
  ];
}

/** Build a rectangular ring. Used only to generate the invented sample shapes. */
function rectangle(west: number, south: number, width: number, height: number): Geometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [west + width, south],
        [west + width, south + height],
        [west, south + height],
        [west, south],
      ],
    ],
  };
}

type FixtureLayerSpec = {
  id: string;
  name: string;
  category: LayerRecord['category'];
  features: Array<{ name: string; properties: Record<string, string>; geometry: Geometry }>;
};

// Placed in an empty stretch of the Arabian Sea so the shapes cannot be
// confused with, or overlaid onto, any real parcel on land.
const ORIGIN_LON = 68.0;
const ORIGIN_LAT = 20.0;

const SPECS: FixtureLayerSpec[] = [
  {
    id: 'fixture_village_boundary',
    name: 'Village Boundaries (synthetic sample)',
    category: 'village-boundary',
    features: [
      {
        name: 'Placeholder Village A',
        properties: { village: 'Placeholder Village A', status: 'synthetic sample' },
        geometry: rectangle(ORIGIN_LON, ORIGIN_LAT, 0.08, 0.06),
      },
      {
        name: 'Placeholder Village B',
        properties: { village: 'Placeholder Village B', status: 'synthetic sample' },
        geometry: rectangle(ORIGIN_LON + 0.09, ORIGIN_LAT, 0.06, 0.06),
      },
    ],
  },
  {
    id: 'fixture_tp_scheme',
    name: 'TP Schemes (synthetic sample)',
    category: 'tp-scheme',
    features: [
      {
        name: 'Sample Scheme One',
        properties: { scheme_number: 'SAMPLE-01', village: 'Placeholder Village A', status: 'synthetic sample' },
        geometry: rectangle(ORIGIN_LON + 0.01, ORIGIN_LAT + 0.01, 0.03, 0.02),
      },
      {
        name: 'Sample Scheme Two',
        properties: { scheme_number: 'SAMPLE-02', village: 'Placeholder Village B', status: 'synthetic sample' },
        geometry: rectangle(ORIGIN_LON + 0.1, ORIGIN_LAT + 0.01, 0.03, 0.02),
      },
    ],
  },
  {
    id: 'fixture_parcels',
    name: 'Land Parcels (synthetic sample)',
    category: 'land-parcel',
    features: Array.from({ length: 6 }, (_, index) => ({
      name: `Sample Parcel ${index + 1}`,
      properties: {
        parcel_reference: `SAMPLE/${index + 1}`,
        village: index < 3 ? 'Placeholder Village A' : 'Placeholder Village B',
        status: 'synthetic sample',
      },
      geometry: rectangle(
        ORIGIN_LON + 0.015 + (index % 3) * 0.012,
        ORIGIN_LAT + 0.015 + Math.floor(index / 3) * 0.012,
        0.01,
        0.01,
      ),
    })),
  },
];

export class FixtureProvider implements GeoProvider {
  readonly id = 'fixture';

  supports(endpoint: DiscoveredEndpoint): boolean {
    return endpoint.url === FIXTURE_URL || endpoint.url.startsWith(`${FIXTURE_URL}#`);
  }

  async listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]> {
    const crs = identifyCrs(4326, 'The synthetic sample dataset is defined directly in WGS84.');
    return SPECS.map((spec) => ({
      id: `layer_${spec.id}`,
      sourceLayerId: spec.id,
      name: spec.name,
      description: SYNTHETIC_NOTE,
      category: spec.category,
      endpointId: endpoint.id,
      endpointKind: 'geojson' as const,
      serviceUrl: `${FIXTURE_URL}#${spec.id}`,
      availability: { status: 'vector' as const, geometryTypes: ['Polygon'], note: SYNTHETIC_NOTE },
      crs,
      featureCount: spec.features.length,
      fields: [
        { name: 'village', alias: 'Village', type: 'esriFieldTypeString' },
        { name: 'status', alias: 'Status', type: 'esriFieldTypeString' },
      ],
      bbox: null,
      locationId: context.locationId ?? 'city_sample',
      kmlExportable: true,
      kmlNote: SYNTHETIC_NOTE,
      attribution: 'Synthetic sample data generated by the extractor itself.',
    }));
  }

  async listFeatures(layer: LayerRecord, query: FeatureQuery): Promise<FeaturePage> {
    const spec = SPECS.find((entry) => layer.serviceUrl.endsWith(`#${entry.id}`));
    if (!spec) {
      return { features: [], nextCursor: null, total: 0, truncated: false, notes: [SYNTHETIC_NOTE] };
    }

    const crs = identifyCrs(4326, 'The synthetic sample dataset is defined directly in WGS84.');
    let features: FeatureRecord[] = spec.features.map((entry, index) => {
      const stats = describeGeometry(entry.geometry);
      return {
        id: `feat_${layer.id}_${index}`,
        layerId: layer.id,
        sourceFeatureId: String(index + 1),
        name: entry.name,
        geometryType: entry.geometry.type,
        properties: { ...entry.properties },
        geometry: query.includeGeometry === false ? null : entry.geometry,
        crs,
        provenance: 'synthetic-fixture',
        provenanceNote: SYNTHETIC_NOTE,
        areaSquareMetres: areaSquareMetres(entry.geometry),
        bbox: stats.bbox,
        kmlAvailable: true,
        kmlNote: SYNTHETIC_NOTE,
        sourceUrl: layer.serviceUrl,
      };
    });

    if (query.ids && query.ids.length > 0) {
      const wanted = new Set(query.ids);
      features = features.filter(
        (feature) => wanted.has(feature.id) || (feature.sourceFeatureId !== null && wanted.has(feature.sourceFeatureId)),
      );
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      features = features.filter((feature) => featureMatches(feature, needle));
    }

    return { features, nextCursor: null, total: features.length, truncated: false, notes: [SYNTHETIC_NOTE] };
  }
}
