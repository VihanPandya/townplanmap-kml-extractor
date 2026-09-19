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
  /**
   * True when the classification came from bytes that were actually received,
   * rather than from the shape of the URL. A browser that read the response
   * has settled the question; a later probe that cannot reproduce the read
   * does not unsettle it.
   */
  bodyVerified?: boolean;
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

/**
 * One request the site's own front-end made while it was open in a browser.
 *
 * This is the record that makes a client-side application legible: the URLs an
 * SPA assembles at runtime never appear literally in its source, but every one
 * of them shows up here.
 */
export type ObservedRequest = {
  url: string;
  method: string;
  /** Chromium's own classification: `xhr`, `fetch`, `document`, `image`… */
  resourceType: string;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  /** Set when this tool's own safety rules stopped the request. */
  blockedReason?: string;
  /** Set when the network, not this tool, ended the request. */
  failureReason?: string;
  /**
   * What the bytes the browser received actually were.
   *
   * The browser already holds the response, so reading it here settles the
   * question outright: no second request, no reliance on a declared content
   * type, and no dependence on the endpoint answering a server-side fetch the
   * same way it answered the site's own.
   */
  detected?: { kind: EndpointKind; nature: DataNature; evidence: string[] };
};

/** Why a harvested URL was not pursued. */
export type RejectedCandidate = {
  url: string;
  reason: string;
};

/** One document the scan actually fetched, and how that went. */
export type ScanDocument = {
  url: string;
  role: 'landing' | 'script' | 'style' | 'service-directory' | 'config' | 'probe';
  status: number | null;
  bytes: number | null;
  ok: boolean;
  reason?: string;
};

export type BrowserDiagnostics = {
  /** Whether this scan asked for a browser at all. */
  attempted: boolean;
  /** Whether a browser was actually driven. */
  used: boolean;
  executablePath: string | null;
  requestsObserved: number;
  requestsBlocked: number;
  /** Populated when the browser could not be used, with what to do about it. */
  reason?: string;
  hint?: string;
  observed: ObservedRequest[];
};

/**
 * Everything the scan saw, so an empty result is evidence rather than a shrug.
 *
 * When discovery finds nothing, this is what tells the difference between "the
 * site was unreachable", "the site was read but its data URLs are built at
 * runtime" and "candidates were found but every one of them was refused".
 */
export type ScanDiagnostics = {
  mode: 'text' | 'browser';
  documents: ScanDocument[];
  scriptsSeen: number;
  scriptsRead: number;
  candidatesHarvested: number;
  candidatesProbed: number;
  rejected: RejectedCandidate[];
  /** URLs the caller supplied by hand. */
  seeds: string[];
  browser: BrowserDiagnostics | null;
  /** Concrete next steps, written for the person looking at an empty result. */
  advice: string[];
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
  /**
   * Optional on older stored scans, which were written before diagnostics
   * existed; always present on a scan run by this build.
   */
  diagnostics?: ScanDiagnostics;
};
