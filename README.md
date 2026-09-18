# TownPlanMap KML Extractor

Extract publicly accessible geographic map data from [TownPlanMap](https://townplanmap.com) and export it as
validated KML.

This is a **conversion tool, not a boundary-reconstruction tool**. It finds the vector geometry a map already
publishes, validates it, transforms it into the coordinate system KML requires, and writes it out. Where only
rendered imagery is available it says so and offers no export, because a polygon traced from a picture of a map
is not a land boundary and should never be presented as one.

```
TownPlanMap → City → Village → Layer → Land/Feature → Geometry → KML
```

---

## What it does

1. **Connects** to the source and reads its landing page and bundled JavaScript *as text* — nothing fetched is
   ever executed.
2. **Discovers** the data endpoints behind the map: ArcGIS REST services, OGC WFS/WMS, GeoJSON and KML
   documents, map style documents, TileJSON and vector tiles.
3. **Classifies** each one as vector geometry, raster imagery, metadata, or unknown — from the response body's
   magic bytes and structure, not from the URL or the server's declared content type, both of which are
   frequently wrong.
4. **Enumerates** layers and features, paging through the service with a request budget.
5. **Validates** geometry: NaN/Infinity, coordinate range, ring closure, vertex counts.
6. **Transforms** coordinates to WGS84 with proj4 when the source publishes in another CRS.
7. **Generates** KML with folders, `ExtendedData`, neutral styling and source attribution.
8. **Validates the generated document** by parsing it back, then lets you preview it on the map before download.

## What it deliberately does not do

- It does not trace, digitise or infer geometry from map images.
- It does not assume an undeclared coordinate system is WGS84. If the CRS is unknown, the geometry is not
  exported, and the reason is shown.
- It does not bypass authentication, paywalls, access tokens, anti-bot systems or rate limits. A `401`/`403` is
  reported as-is.
- It does not invent attributes, survey numbers, place names or colours that would imply a zoning meaning the
  source never stated.
- It does not silently drop features. Anything excluded from an export is listed with the reason.

---

## Running it

```bash
npm install
npm run dev            # http://localhost:3000
```

For production:

```bash
npm run build
npm run start
```

No configuration is required to start. See [`.env.example`](.env.example) for everything that can be tuned.

### With PostGIS (recommended)

Without a database the catalog lives in memory and is lost on restart. With one, discovered layers, features
and export history persist, and PostGIS does the spatial work:

```bash
export DATABASE_URL=postgres://user:password@localhost:5432/townplanmap
npm run db:init        # idempotent; applies src/lib/db/schema.sql
npm run start
```

Geometry is stored in a `geometry(Geometry, 4326)` column with a GiST index, and feature attributes in `JSONB`
with a GIN index so attribute search works across whatever fields the source happens to expose.

### Trying it without network access to the source

```bash
TPM_ENABLE_FIXTURE_SOURCE=1 npm run dev
```

This adds a small **synthetic** dataset so the whole workflow can be exercised offline. Its geometry is
invented. It is labelled as synthetic in the interface, in the provenance badge, and inside every exported KML
file, and it is placed in open sea so it cannot be mistaken for a real parcel. Never enable it in production.

---

## Architecture

```
src/
├── app/
│   ├── api/                    Route handlers (see API below)
│   ├── page.tsx                Dashboard and connection screen
│   ├── cities/                 City and area selection
│   ├── layers/                 Layer discovery, grouped by planning category
│   ├── features/               Map, feature explorer, inspector, attribute table
│   ├── export/                 Export Centre, validation report, KML viewer
│   ├── history/                Export history
│   └── settings/               Limits and access policy
├── components/                 App state, map, shared UI
└── lib/
    ├── config.ts               Every limit, in one place
    ├── net/
    │   ├── ssrf.ts             Protocol, host and resolved-address checks
    │   ├── safe-fetch.ts       The only outbound HTTP path in the codebase
    │   └── budget.ts           Request budget, concurrency, per-host throttle
    ├── xml/safe-parse.ts       XML parsing with DTD and entity declarations refused
    ├── discovery/
    │   ├── engine.ts           The discovery scan
    │   ├── harvest.ts          Candidate URL extraction from HTML and JS
    │   ├── probe.ts            Endpoint probing and classification
    │   ├── locations.ts        City/village discovery from the source
    │   └── providers/          ArcGIS, WFS, GeoJSON/KML files, vector tiles
    ├── geo/
    │   ├── detect.ts           Vector versus raster
    │   ├── crs.ts              CRS identification and proj4 transforms
    │   └── geometry.ts         Validation, ring closure, area
    ├── kml/
    │   ├── builder.ts          KML generation
    │   ├── validate.ts         Post-generation validation
    │   ├── parse.ts            KML reading, for the viewer and KML sources
    │   └── package.ts          KMZ and ZIP packaging
    ├── db/                     PostGIS and in-memory catalog stores
    └── exports/                Job manager and the export pipeline
```

### The provider model

A provider knows how to talk to one family of GIS service and turns it into the same `LayerRecord` /
`FeatureRecord` shapes the rest of the application uses:

| Provider | Handles | Notes |
|---|---|---|
| `ArcGisProvider` | FeatureServer, MapServer | Prefers `f=geojson`; falls back to Esri JSON on older deployments |
| `WfsProvider` | OGC WFS 1.x/2.x | Requests GeoJSON output; GML-only servers are reported, not guessed at |
| `GeoJsonFileProvider` | GeoJSON documents | |
| `KmlFileProvider` | KML and KMZ | The source geometry is already what we want |
| `VectorTileProvider` | Mapbox Vector Tiles | Last resort — see the provenance note below |

Dispatch is first-match-wins, most specific first.

---

## Provenance

Every feature carries a provenance status that follows it all the way into the exported file:

| Status | Meaning |
|---|---|
| `source-geometry` | Coordinates exactly as the source published them. |
| `crs-converted` | Source coordinates, transformed into WGS84. |
| `tile-decoded` | Decoded from vector tiles, so **quantised to the tile grid** — a generalised rendering of the boundary, not the surveyed geometry. |
| `image-only` | Raster source. No geometry, no KML. |
| `unverified` | Geometry present but not independently checkable. |
| `synthetic-fixture` | Invented demonstration data. Not from the source. |

Nothing approximate is ever described as exact.

---

## Security

The tool takes URLs out of third-party HTML and JavaScript and fetches them server-side, which is the classic
shape of an SSRF. The controls are:

- **Protocol allowlist.** Only `http:` and `https:`. `file:`, `ftp:`, `gopher:` and everything else are refused
  before a socket is opened.
- **Address filtering.** Loopback, RFC1918, link-local (including `169.254.169.254`), CGNAT, multicast and
  reserved ranges are blocked — by hostname, by IP literal, and by *every* address a hostname resolves to,
  including IPv4-mapped IPv6 forms.
- **Redirects followed manually.** Each hop is re-validated, so a `Location` header cannot walk past the filter.
- **Bounded responses.** Transfers abort once the cap is passed, and a `Content-Length` above it is refused
  before the first chunk.
- **Request budget.** Concurrency, per-host throttling and a hard request count per operation.
- **XML hardening.** Documents declaring a `DOCTYPE`, entities or external references are rejected before
  parsing, which closes both XXE and entity-expansion ("billion laughs").
- **Archive safety.** Every path written into a ZIP or KMZ has its segments sanitised and `..` dropped, so an
  extracted archive cannot escape its directory.
- **Output escaping.** Source attributes are XML-escaped and control characters XML forbids are stripped;
  filenames are sanitised for every platform, including Windows reserved device names.

Limits are configured through environment variables and clamped to hard ceilings in code, so they cannot be
raised from the browser. They are all listed on the Settings screen.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/connect` | Run a discovery scan |
| `GET` | `/api/connect` | Last scan, without spending requests |
| `GET` | `/api/cities` | Discovered cities |
| `GET` | `/api/cities/:id/areas` | Villages/localities in a city |
| `GET` | `/api/areas/:id/layers` | Layers for an area (`:id` may be `all`) |
| `GET` | `/api/layers` · `/api/layers/:id` | Layer catalog and detail |
| `GET` | `/api/layers/:id/features` | A page of features |
| `GET` | `/api/features/:id` | Attributes and metadata |
| `GET` | `/api/features/:id/geometry` | Geometry plus inspector detail |
| `POST` | `/api/export/kml` · `/kmz` · `/geojson` · `/bulk` | Start an export job |
| `GET` | `/api/export/:id/status` | Progress and validation |
| `GET` | `/api/export/:id/download` | Download the result |
| `POST` | `/api/export/:id/cancel` | Cancel a running job |
| `GET` | `/api/exports` | Export history |
| `POST` | `/api/kml/preview` | Parse a generated document back to GeoJSON |
| `GET` | `/api/settings` | Limits and policies in force |

Export requests take either an explicit scope:

```json
{
  "scope": { "type": "features", "layerId": "layer_123", "featureIds": ["feature_1", "feature_2"] },
  "format": "kml"
}
```

or the flatter form:

```json
{ "layerId": "layer_123", "featureIds": ["feature_1"], "format": "kml" }
```

and respond `202` with `{ "exportId": "export_...", "status": "queued" }`.

### Bulk export layout

```
TownPlanMap_Export.zip
├── KML/
│   └── <Location>.kml          Combined, with folders
├── Individual/
│   ├── <Location>_<Feature>.kml
│   └── …
└── metadata.json               Source, layers, CRS, exclusions, extraction date
```

---

## Testing

```bash
npm test          # 122 unit tests
npm run typecheck
npm run lint
npm run build
```

Coverage focuses on the parts where a silent error would be dangerous: the provenance and attribution
guarantees above, SSRF rejection, CRS transforms
(cross-checked against the closed-form Mercator inverse), geometry validation, Esri ring-winding reconstruction,
KML round-tripping, XML hardening and filename/path sanitisation.

---

## Limitations

- **Discovery is best-effort.** It reads the page and its scripts server-side. A map that loads its endpoints
  only after a user interaction, or from an endpoint shape this build does not recognise, will not be found —
  and the tool says so rather than inventing a result.
- **GML-only WFS servers are not parsed.** GeoJSON output is requested; a server that offers only GML is
  reported as such.
- **TopoJSON, GeoPackage and shapefile archives are detected but not yet read.**
- **Vector tiles are a fallback, not an equal.** See the provenance table.
- **A raster-only source yields no KML.** By design.

---

## Data use

> This tool extracts or converts geographic information that is publicly accessible through the authorised
> source. Users are responsible for complying with TownPlanMap's terms, applicable licences, copyright,
> database rights and other applicable laws. Extracted geographic data should be independently verified before
> use in legal, surveying, property or other high-stakes decisions.

TownPlanMap describes its service as an informational and decision-support platform and recommends verifying
information with the relevant government authority for legal or official purposes. This project is an
independent extractor and is not affiliated with TownPlanMap.
