/**
 * Recorded wire formats from real GIS servers.
 *
 * These mirror the exact response shapes ArcGIS Server and GeoServer emit,
 * including the awkward parts: `latestWkid` differing from `wkid`, Esri's flat
 * `rings` array with winding-order nesting, `exceededTransferLimit`, an
 * ArcGIS error returned with HTTP 200, and GeoServer's namespaced capabilities
 * document.
 *
 * The provider code has no other way to be exercised end to end in this
 * environment, so the fidelity of these fixtures is what the provider tests are
 * worth.
 */

/** GET /rest/services/Planning/TPScheme/FeatureServer?f=json */
export const ARCGIS_SERVICE_INFO = {
  currentVersion: 10.91,
  serviceDescription: 'Town planning schemes and development plan zones.',
  hasVersionedData: false,
  supportsDisconnectedEditing: false,
  hasStaticData: true,
  maxRecordCount: 2000,
  supportedQueryFormats: 'JSON, geoJSON, PBF',
  capabilities: 'Query',
  description: '',
  copyrightText: 'Municipal Corporation, 2024',
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  fullExtent: {
    xmin: 8059000,
    ymin: 2620000,
    xmax: 8090000,
    ymax: 2650000,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
  layers: [
    { id: 0, name: 'TP Scheme Boundary', parentLayerId: -1, defaultVisibility: true, subLayerIds: null, geometryType: 'esriGeometryPolygon' },
    { id: 1, name: 'Final Plots', parentLayerId: -1, defaultVisibility: true, subLayerIds: null, geometryType: 'esriGeometryPolygon' },
    { id: 2, name: 'Village Boundary', parentLayerId: -1, defaultVisibility: true, subLayerIds: null, geometryType: 'esriGeometryPolygon' },
    // A group layer has no geometry of its own and must be skipped.
    { id: 3, name: 'Reference', type: 'Group Layer', parentLayerId: -1, subLayerIds: [4] },
  ],
  tables: [],
};

/** GET /rest/services/Planning/TPScheme/FeatureServer/1?f=json */
export const ARCGIS_LAYER_INFO = {
  currentVersion: 10.91,
  id: 1,
  name: 'Final Plots',
  type: 'Feature Layer',
  description: 'Final plot boundaries as sanctioned.',
  geometryType: 'esriGeometryPolygon',
  copyrightText: 'Municipal Corporation, 2024',
  displayField: 'FP_NO',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2000,
  capabilities: 'Query,Data',
  supportsPagination: true,
  advancedQueryCapabilities: { supportsPagination: true, supportsStatistics: true },
  extent: {
    xmin: 72.5,
    ymin: 23.0,
    xmax: 72.6,
    ymax: 23.1,
    spatialReference: { wkid: 4326, latestWkid: 4326 },
  },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID' },
    { name: 'FP_NO', type: 'esriFieldTypeString', alias: 'Final Plot No', length: 32 },
    { name: 'SURVEY_NO', type: 'esriFieldTypeString', alias: 'Survey Number', length: 32 },
    { name: 'VILLAGE', type: 'esriFieldTypeString', alias: 'Village', length: 64 },
    { name: 'AREA_SQM', type: 'esriFieldTypeDouble', alias: 'Area (sq.m)' },
    { name: 'Shape__Area', type: 'esriFieldTypeDouble', alias: 'Shape__Area' },
  ],
};

/** GET .../FeatureServer/1/query?f=geojson&outSR=4326&... */
export const ARCGIS_QUERY_GEOJSON = {
  type: 'FeatureCollection',
  properties: { exceededTransferLimit: false },
  features: [
    {
      type: 'Feature',
      id: 101,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [72.5, 23.0],
            [72.51, 23.0],
            [72.51, 23.01],
            [72.5, 23.01],
            [72.5, 23.0],
          ],
        ],
      },
      properties: {
        OBJECTID: 101,
        FP_NO: '12',
        SURVEY_NO: '125/2',
        VILLAGE: 'Example Village',
        AREA_SQM: 23400.5,
        Shape__Area: 23400.5,
      },
    },
    {
      type: 'Feature',
      id: 102,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [72.52, 23.0],
            [72.53, 23.0],
            [72.53, 23.01],
            [72.52, 23.01],
            [72.52, 23.0],
          ],
        ],
      },
      properties: {
        OBJECTID: 102,
        FP_NO: '13',
        SURVEY_NO: '126/1',
        VILLAGE: 'Example Village',
        AREA_SQM: 18200,
        Shape__Area: 18200,
      },
    },
  ],
};

/**
 * The same query against a server too old for `f=geojson`.
 *
 * Note the flat `rings` array: the second ring is counter-clockwise, so it is a
 * hole in the first polygon, and the third is clockwise, so it opens a second
 * polygon. Reconstructing that nesting is the part worth testing.
 */
export const ARCGIS_QUERY_ESRI_JSON = {
  objectIdFieldName: 'OBJECTID',
  globalIdFieldName: '',
  geometryType: 'esriGeometryPolygon',
  spatialReference: { wkid: 4326, latestWkid: 4326 },
  fields: ARCGIS_LAYER_INFO.fields,
  features: [
    {
      attributes: {
        OBJECTID: 201,
        FP_NO: '20',
        SURVEY_NO: '127/4',
        VILLAGE: 'Example Village',
        AREA_SQM: 31000,
      },
      geometry: {
        rings: [
          // Outer ring, clockwise in Esri's convention.
          [
            [72.5, 23.0],
            [72.5, 23.02],
            [72.52, 23.02],
            [72.52, 23.0],
            [72.5, 23.0],
          ],
          // Hole, counter-clockwise.
          [
            [72.505, 23.005],
            [72.515, 23.005],
            [72.515, 23.015],
            [72.505, 23.015],
            [72.505, 23.005],
          ],
          // A second, separate part: clockwise again.
          [
            [72.53, 23.0],
            [72.53, 23.01],
            [72.54, 23.01],
            [72.54, 23.0],
            [72.53, 23.0],
          ],
        ],
      },
    },
  ],
  exceededTransferLimit: true,
};

/** ArcGIS returns errors with HTTP 200 and an `error` member. */
export const ARCGIS_ERROR = {
  error: {
    code: 400,
    message: 'Unable to complete operation.',
    details: ["Invalid 'where' parameter."],
  },
};

/** GET .../query?returnCountOnly=true&f=json */
export const ARCGIS_COUNT = { count: 1284 };

/** GET .../query?returnDistinctValues=true&outFields=VILLAGE&f=json */
export const ARCGIS_DISTINCT_VILLAGES = {
  objectIdFieldName: '',
  fields: [{ name: 'VILLAGE', type: 'esriFieldTypeString', alias: 'Village' }],
  features: [
    { attributes: { VILLAGE: 'Bhat' } },
    { attributes: { VILLAGE: 'Chandkheda' } },
    { attributes: { VILLAGE: 'Motera' } },
    // Duplicates and junk values a real attribute column carries.
    { attributes: { VILLAGE: 'Motera' } },
    { attributes: { VILLAGE: '' } },
    { attributes: { VILLAGE: null } },
  ],
};

/** GET /rest/services?f=json — the services directory. */
export const ARCGIS_DIRECTORY = {
  currentVersion: 10.91,
  folders: ['Ahmedabad', 'Gandhinagar', 'Surat'],
  services: [
    { name: 'Planning/TPScheme', type: 'FeatureServer' },
    { name: 'Planning/Basemap', type: 'MapServer' },
    { name: 'Imagery/Satellite', type: 'ImageServer' },
  ],
};

/** GET ...?service=WFS&request=GetCapabilities&version=2.0.0 — GeoServer. */
export const WFS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0"
    xmlns:wfs="http://www.opengis.net/wfs/2.0"
    xmlns:ows="http://www.opengis.net/ows/1.1"
    xmlns:gml="http://www.opengis.net/gml/3.2"
    xmlns:planning="http://example.org/planning">
  <ows:ServiceIdentification>
    <ows:Title>Municipal Planning WFS</ows:Title>
    <ows:Abstract>Town planning vector services.</ows:Abstract>
    <ows:ServiceType>WFS</ows:ServiceType>
    <ows:ServiceTypeVersion>2.0.0</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <ows:ServiceProvider>
    <ows:ProviderName>Municipal Corporation</ows:ProviderName>
  </ows:ServiceProvider>
  <FeatureTypeList>
    <FeatureType>
      <Name>planning:final_plots</Name>
      <Title>Final Plots</Title>
      <Abstract>Sanctioned final plot boundaries.</Abstract>
      <DefaultCRS>urn:ogc:def:crs:EPSG::4326</DefaultCRS>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>72.5 23.0</ows:LowerCorner>
        <ows:UpperCorner>72.6 23.1</ows:UpperCorner>
      </ows:WGS84BoundingBox>
    </FeatureType>
    <FeatureType>
      <Name>planning:village_boundary</Name>
      <Title>Village Boundaries</Title>
      <Abstract>Revenue village boundaries.</Abstract>
      <DefaultCRS>urn:ogc:def:crs:EPSG::32643</DefaultCRS>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>72.4 22.9</ows:LowerCorner>
        <ows:UpperCorner>72.7 23.2</ows:UpperCorner>
      </ows:WGS84BoundingBox>
    </FeatureType>
  </FeatureTypeList>
</wfs:WFS_Capabilities>`;

/** GET ...?service=WFS&request=GetFeature&outputFormat=application/json */
export const WFS_GETFEATURE_GEOJSON = {
  type: 'FeatureCollection',
  numberMatched: 842,
  numberReturned: 2,
  timeStamp: '2026-09-19T00:00:00.000Z',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
  features: [
    {
      type: 'Feature',
      id: 'final_plots.1',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [72.5, 23.0],
              [72.51, 23.0],
              [72.51, 23.01],
              [72.5, 23.01],
              [72.5, 23.0],
            ],
          ],
        ],
      },
      geometry_name: 'the_geom',
      properties: { fp_no: '12', survey_no: '125/2', village: 'Example Village' },
    },
    {
      type: 'Feature',
      id: 'final_plots.2',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [72.52, 23.0],
              [72.53, 23.0],
              [72.53, 23.01],
              [72.52, 23.01],
              [72.52, 23.0],
            ],
          ],
        ],
      },
      geometry_name: 'the_geom',
      properties: { fp_no: '13', survey_no: '126/1', village: 'Example Village' },
    },
  ],
};

/**
 * A GeoServer that only speaks GML: `outputFormat=application/json` is rejected
 * with an OGC exception report, delivered with HTTP 200.
 */
export const WFS_EXCEPTION = `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport version="2.0.0" xmlns:ows="http://www.opengis.net/ows/1.1">
  <ows:Exception exceptionCode="InvalidParameterValue" locator="outputFormat">
    <ows:ExceptionText>Failed to find response for output format application/json</ows:ExceptionText>
  </ows:Exception>
</ows:ExceptionReport>`;

/**
 * WFS 2.0 / GML 3.2 output from GeoServer.
 *
 * `srsName` is the URN form, which means the EPSG axis order — **latitude
 * first**. The posList below is therefore `lat lon lat lon ...`, and a reader
 * that assumes lon/lat will place these plots in the Indian Ocean.
 */
export const WFS_GML32_LATLON = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection numberMatched="842" numberReturned="2"
    xmlns:wfs="http://www.opengis.net/wfs/2.0"
    xmlns:gml="http://www.opengis.net/gml/3.2"
    xmlns:planning="http://example.org/planning">
  <wfs:member>
    <planning:final_plots gml:id="final_plots.1">
      <planning:fp_no>12</planning:fp_no>
      <planning:survey_no>125/2</planning:survey_no>
      <planning:village>Example Village</planning:village>
      <planning:area_sqm>23400.5</planning:area_sqm>
      <planning:the_geom>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2">
          <gml:surfaceMember>
            <gml:Polygon>
              <gml:exterior>
                <gml:LinearRing>
                  <gml:posList>23.0 72.5 23.0 72.51 23.01 72.51 23.01 72.5 23.0 72.5</gml:posList>
                </gml:LinearRing>
              </gml:exterior>
            </gml:Polygon>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </planning:the_geom>
    </planning:final_plots>
  </wfs:member>
  <wfs:member>
    <planning:final_plots gml:id="final_plots.2">
      <planning:fp_no>13</planning:fp_no>
      <planning:survey_no>126/1</planning:survey_no>
      <planning:village>Example Village</planning:village>
      <planning:the_geom>
        <gml:Polygon srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:exterior>
            <gml:LinearRing>
              <gml:posList>23.0 72.52 23.0 72.53 23.01 72.53 23.0 72.52</gml:posList>
            </gml:LinearRing>
          </gml:exterior>
          <gml:interior>
            <gml:LinearRing>
              <gml:posList>23.002 72.522 23.002 72.525 23.005 72.525 23.002 72.522</gml:posList>
            </gml:LinearRing>
          </gml:interior>
        </gml:Polygon>
      </planning:the_geom>
    </planning:final_plots>
  </wfs:member>
</wfs:FeatureCollection>`;

/**
 * WFS 1.1 / GML 2 output.
 *
 * The short `EPSG:4326` form, which by convention means longitude first, and
 * GML 2's comma-separated `<coordinates>` with outerBoundaryIs/innerBoundaryIs.
 */
export const WFS_GML2_LONLAT = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection
    xmlns:wfs="http://www.opengis.net/wfs"
    xmlns:gml="http://www.opengis.net/gml"
    xmlns:planning="http://example.org/planning">
  <gml:featureMember>
    <planning:final_plots fid="final_plots.7">
      <planning:fp_no>7</planning:fp_no>
      <planning:survey_no>127/4</planning:survey_no>
      <planning:the_geom>
        <gml:MultiPolygon srsName="EPSG:4326">
          <gml:polygonMember>
            <gml:Polygon>
              <gml:outerBoundaryIs>
                <gml:LinearRing>
                  <gml:coordinates>72.5,23.0 72.51,23.0 72.51,23.01 72.5,23.01 72.5,23.0</gml:coordinates>
                </gml:LinearRing>
              </gml:outerBoundaryIs>
            </gml:Polygon>
          </gml:polygonMember>
        </gml:MultiPolygon>
      </planning:the_geom>
    </planning:final_plots>
  </gml:featureMember>
</wfs:FeatureCollection>`;

/** A GML response that declares no srsName anywhere. */
export const WFS_GML_NO_SRS = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection
    xmlns:wfs="http://www.opengis.net/wfs/2.0"
    xmlns:gml="http://www.opengis.net/gml/3.2"
    xmlns:planning="http://example.org/planning">
  <wfs:member>
    <planning:final_plots gml:id="final_plots.9">
      <planning:fp_no>9</planning:fp_no>
      <planning:the_geom>
        <gml:Polygon>
          <gml:exterior>
            <gml:LinearRing>
              <gml:posList>72.5 23.0 72.51 23.0 72.51 23.01 72.5 23.0</gml:posList>
            </gml:LinearRing>
          </gml:exterior>
        </gml:Polygon>
      </planning:the_geom>
    </planning:final_plots>
  </wfs:member>
</wfs:FeatureCollection>`;
