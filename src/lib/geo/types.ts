/** GeoJSON shapes used across the application. */

export type Position = number[];

export type GeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'GeometryCollection';

export type PointGeometry = { type: 'Point'; coordinates: Position };
export type MultiPointGeometry = { type: 'MultiPoint'; coordinates: Position[] };
export type LineStringGeometry = { type: 'LineString'; coordinates: Position[] };
export type MultiLineStringGeometry = { type: 'MultiLineString'; coordinates: Position[][] };
export type PolygonGeometry = { type: 'Polygon'; coordinates: Position[][] };
export type MultiPolygonGeometry = { type: 'MultiPolygon'; coordinates: Position[][][] };
export type GeometryCollection = { type: 'GeometryCollection'; geometries: Geometry[] };

export type Geometry =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry
  | GeometryCollection;

export type FeatureProperties = Record<string, string | number | boolean | null>;

export type GeoFeature = {
  type: 'Feature';
  id?: string | number;
  geometry: Geometry | null;
  properties: FeatureProperties;
};

export type FeatureCollection = {
  type: 'FeatureCollection';
  features: GeoFeature[];
  crs?: unknown;
};

export type BoundingBox = [west: number, south: number, east: number, north: number];
