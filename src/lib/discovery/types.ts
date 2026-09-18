/**
 * Domain model shared by the discovery engine, the API and the UI.
 */

import type { BoundingBox, Geometry, FeatureProperties } from '@/lib/geo/types';
import type { CrsIdentification } from '@/lib/geo/crs';
import type { GeometryValidation } from '@/lib/geo/geometry';

/** Every kind of endpoint the discovery engine knows how to recognise. */
export type EndpointKind =
  | 'arcgis-feature-server'
  | 'arcgis-map-server'
  | 'arcgis-image-server'
  | 'arcgis-rest-root'
  | 'ogc-wfs'
  | 'ogc-wms'
  | 'ogc-wmts'
  | 'ogc-api-features'
  | 'geojson'
  | 'topojson'
  | 'kml'
  | 'kmz'
  | 'gpx'
  | 'maplibre-style'
  | 'tilejson'
  | 'vector-tiles'
  | 'raster-tiles'
  | 'geopackage'
  | 'shapefile-archive'
  | 'raster-image'
  | 'unknown';

/**
 * Whether an endpoint carries real coordinate geometry, pixels, or something
 * we could not classify. This is the distinction the whole product turns on.
 */
export type DataNature = 'vector' | 'raster' | 'metadata' | 'unknown';

export type DiscoveredEndpoint = {
  id: string;
  url: string;
  kind: EndpointKind;
  nature: DataNature;
  /** Where the URL was found: which document, and by what rule. */
  discoveredIn: string;
  evidence: string[];
  /** Populated once the endpoint has been probed. */
  probe?: EndpointProbe;
};

export type EndpointProbe = {
  reachable: boolean;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  /** Free-form service metadata retained for the data-source panel. */
  detail: Record<string, string | number | boolean | null>;
  failureKind?: string;
  failureReason?: string;
};

/** A city / municipal area offered by the source. */
export type LocationRecord = {
  id: string;
  name: string;
  kind: 'city' | 'area';
  parentId: string | null;
  /** Where this name came from, so nothing appears without provenance. */
  sourceUrl: string;
  sourceField?: string;
  bbox?: BoundingBox | null;
  featureCount?: number | null;
};

export type LayerGeometryAvailability =
  | { status: 'vector'; geometryTypes: string[]; note: string }
  | { status: 'raster'; note: string }
  | { status: 'restricted'; note: string }
  | { status: 'unknown'; note: string };

/** A map layer discovered behind a location. */
export type LayerRecord = {
  id: string;
  /** Identifier as the upstream service knows it. */
  sourceLayerId: string;
  name: string;
  description: string | null;
  /** Broad planning category inferred from the layer's own name/metadata. */
  category: 'tp-scheme' | 'development-plan' | 'village-boundary' | 'land-parcel' | 'other';
  endpointId: string;
  endpointKind: EndpointKind;
  serviceUrl: string;
  availability: LayerGeometryAvailability;
  crs: CrsIdentification;
  featureCount: number | null;
  /** Attribute names the service advertises, used to build the attribute table. */
  fields: LayerField[];
  bbox: BoundingBox | null;
  locationId: string | null;
  kmlExportable: boolean;
  /** Why KML is or is not available for this layer. */
  kmlNote: string;
  attribution: string | null;
};

export type LayerField = {
  name: string;
  /** Label the service gave the field, when it differs from the name. */
  alias: string | null;
  type: string | null;
};

/** How trustworthy a feature's geometry is. Never upgraded by guesswork. */
export type Provenance =
  | 'source-geometry'        // coordinates exactly as the source published them
  | 'crs-converted'          // source coordinates, transformed to WGS84
  | 'tile-decoded'           // decoded from vector tiles: quantised to tile grid
  | 'image-only'             // raster source; no geometry
  | 'unverified'             // geometry present but could not be checked
  | 'synthetic-fixture';     // offline demo data; never from the source

export type FeatureRecord = {
  id: string;
  layerId: string;
  /** Identifier as the source knows it, when it exposes one. */
  sourceFeatureId: string | null;
  name: string;
  geometryType: string | null;
  properties: FeatureProperties;
  /** Populated once geometry is fetched; list views leave this null. */
  geometry: Geometry | null;
  crs: CrsIdentification;
  provenance: Provenance;
  provenanceNote: string;
  areaSquareMetres: number | null;
  bbox: BoundingBox | null;
  kmlAvailable: boolean;
  kmlNote: string;
  sourceUrl: string;
  validation?: GeometryValidation;
};

/** Result of a full connect + discovery scan. */
export type ScanResult = {
  id: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  connected: boolean;
  mapInterfaceDetected: boolean;
  geographicLayersDetected: boolean;
  endpoints: DiscoveredEndpoint[];
  documentsFetched: string[];
  requestsSpent: number;
  bytesDownloaded: number;
  notes: string[];
  warnings: string[];
  /** Populated when the scan could not reach the source at all. */
  failure: { kind: string; reason: string } | null;
};
