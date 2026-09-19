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

> **How does it actually work?** [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) walks a single land parcel
> through the whole system — discovery, classification, CRS handling, validation and export — and explains why
> each step is built the way it is.

---

## What it does

1. **Connects** to the source and reads its landing page and bundled JavaScript *as text* — nothing fetched is
   ever executed.
2. **Discovers** the data endpoints behind the map: ArcGIS REST services, OGC WFS/WMS, GeoJSON, TopoJSON and
   KML documents, map style documents, TileJSON and vector tiles.
3. **Classifies** each one as vector geometry, raster imagery, metadata, or unknown — from the response body's
   magic bytes and structure, not from the URL or the server's declared content type, both of which are
   frequently wrong.
4. **Enumerates** layers and features, paging through the service with a request budget.
5. **Validates** geometry: NaN/Infinity, coordinate range, ring closure, vertex counts.
6. **Transforms** coordinates to WGS84 with proj4 when the source publishes in another CRS.
7. **Generates** KML with folders, `ExtendedData`, neutral styling and source attribution.
8. **Validates the generated document** by parsing it back, then lets you preview it on the map before download.
9. **Preserves the source's own KML/KMZ files** byte for byte, separately from anything it generates — see
   [Original files versus reconstructions](#original-files-versus-reconstructions).

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

`npm install` also pulls in `playwright-core`, an optional dependency used by the deep scan described below. It
drives a browser **you already have** — Chrome, Chromium or Edge — and downloads nothing. If it is missing, or
no browser is installed, the app still runs; only the deep scan is unavailable, and it says so.

For production:

```bash
npm run build
npm run start
```

No configuration is required to start. See [`.env.example`](.env.example) for everything that can be tuned.

### When a scan finds nothing

This is the common case against a real map site, and it has a cause worth understanding.

A plain scan reads the landing page and its JavaScript bundles **as text** and pulls out anything that looks
like a data URL. That works when the URLs are written into the source. Most modern map front-ends do not write
them there: they hold a base path, a layer id and a template, and assemble the request at the moment they make
it. Nothing a server-side read can see ever contains the URL.

So when the dashboard says `ENDPOINTS 1 · VECTOR 0`, work through this in order.

**1. Turn on the deep scan.** On the dashboard, open **Scan options** and tick **Watch the site in a browser**,
then scan again. This opens the source in a browser on your machine, lets the site's own code run, and writes
down every request it makes. If the map draws real geometry, the URL that serves it will be in that list. Those
URLs then go through exactly the same guarded fetch path as everything else.

```bash
TPM_BROWSER_SCAN=1 npm run dev          # on for every scan
TPM_BROWSER_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run dev
TPM_BROWSER_HEADED=1 npm run dev        # watch it happen
TPM_BROWSER_SETTLE_MS=20000 npm run dev # a slow site needs longer
```

**2. Read the Diagnostics screen.** It lists every document the scan fetched and what each one answered, every
request the browser watched the site make, and every URL that was seen and dropped *with the reason*. An empty
result stops being a dead end there. **Copy as JSON** puts the whole record on the clipboard.

**3. Find the URL yourself and paste it in.** This always works:

1. Open the source in your browser and press <kbd>F12</kbd>.
2. Choose the **Network** tab and tick **Fetch/XHR**.
3. Reload the page, then pan and click around the map.
4. Look for a response that is GeoJSON, an ArcGIS `query`, or a WFS document. Right-click → **Copy link
   address**.
5. Paste it into **Add an endpoint** on the dashboard and scan again.

A hand-supplied URL skips pattern matching entirely and goes straight to the probe, which classifies it from
the body it actually returns. The same URLs can be posted directly:

```bash
curl -X POST localhost:3000/api/connect \
  -H 'content-type: application/json' \
  -d '{"useBrowser":true,"extraUrls":["https://example.gov.in/arcgis/rest/services/TP/FeatureServer/0"]}'
```

**4. If the source refuses.** A `401` or `403` is reported exactly as it arrived. The deep scan does not change
that: it carries no credentials and no stored session, and it does not click through a login, a consent wall or
a captcha. If a dataset needs authorised access through TownPlanMap, that is where to get it.

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
│   ├── source-files/           Preserved original KML/KMZ
│   ├── diagnostics/            What the last scan fetched, observed and rejected
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
    │   ├── browser.ts          The deep scan: watching the site in a real browser
    │   ├── harvest.ts          Candidate URL extraction from HTML, JS and observations
    │   ├── probe.ts            Endpoint probing and classification
    │   ├── locations.ts        City/village discovery from the source
    │   └── providers/          ArcGIS, WFS, GML, GeoJSON/TopoJSON/KML, vector tiles
    ├── geo/
    │   ├── detect.ts           Vector versus raster
    │   ├── crs.ts              CRS identification and proj4 transforms
    │   └── geometry.ts         Validation, ring closure, area
    ├── kml/
    │   ├── builder.ts          KML generation
    │   ├── validate.ts         Post-generation validation
    │   ├── parse.ts            KML reading, for the viewer and KML sources
    │   ├── links.ts            NetworkLink/Icon/styleUrl extraction
    │   └── package.ts          KMZ and ZIP packaging
    ├── preservation/           Original-file sweep, and the origin model
    ├── db/                     PostGIS and in-memory catalog stores
    └── exports/                Job manager and the export pipeline
```

### The provider model

A provider knows how to talk to one family of GIS service and turns it into the same `LayerRecord` /
`FeatureRecord` shapes the rest of the application uses:

| Provider | Handles | Notes |
|---|---|---|
| `ArcGisProvider` | FeatureServer, MapServer | Prefers `f=geojson`; falls back to Esri JSON on older deployments |
| `WfsProvider` | OGC WFS 1.x/2.x | Prefers GeoJSON output; falls back to GML 2 / GML 3.2 when the deployment cannot emit it |
| `GeoJsonFileProvider` | GeoJSON documents | |
| `TopoJsonFileProvider` | TopoJSON topologies | Reconstructs geometry from shared arcs; each top-level object is a layer |
| `KmlFileProvider` | KML and KMZ | The source geometry is already what we want |
| `VectorTileProvider` | Mapbox Vector Tiles | Last resort — see the provenance note below |

Dispatch is first-match-wins, most specific first.

---

## Original files versus reconstructions

The tool produces two kinds of artefact, and it never lets them blur:

| | **Original** | **Reconstructed** |
|---|---|---|
| What it is | A file the source published | A document this tool generated from map geometry |
| Where it lives | **Source Files** | **KML Export** / **Export History** |
| Bytes | Preserved exactly as received, SHA-256 recorded | Written by the KML builder |
| In the file | — | `origin=reconstructed` in `ExtendedData`, plus a plain-English statement |
| Download header | `x-artifact-origin: original` | `x-artifact-origin: reconstructed` |
| In a bundle | `Original/` | `Reconstructed/` |

The separation is structural, not a convention:

- `SourceFileRecord.origin` has the **literal type** `'original'`, so no value of that type can describe a
  generated document. The PostGIS table enforces the same with a `CHECK (origin = 'original')`.
- Original bytes never pass through the KML builder, and the two download routes are entirely separate, so
  there is no code path by which a regenerated document could be served wearing an original's identity.
- Every generated document is stamped inside itself, so the label survives the file leaving the tool.

### Finding files the interface does not expose

A sweep (`POST /api/preserve`) looks for KML and KMZ beyond what the visible UI offers:

- hrefs buried in JavaScript bundles and inline bootstrap config
- sources named by a map style document or a service catalog
- **`<NetworkLink>` chains inside KML documents, followed transitively** — a root document routinely points at
  per-ward files that appear nowhere else
- `styleUrl` and overlay `<Icon>` references into further documents

Each preserved file records the route it was reached by, and the UI flags the ones the visible interface
offers no way to reach. Cycles are detected, byte-identical duplicates are stored once, and link depth,
file count, file size and request budget are all bounded.

**"Publicly accessible" is meant strictly.** The sweep reads what the source serves to an ordinary
unauthenticated request. A `401` or `403` is recorded as a refusal and the file is left alone; nothing
attempts to bypass authentication, paywalls, tokens or access controls.

---

## GIS tools

The feature explorer's map carries the optional tools from the specification:

| Tool | What it does |
|---|---|
| **Distance** | Click points to measure a geodesic distance. Backspace removes the last point, Esc finishes. |
| **Area** | Click three or more points to measure an ellipsoidal area, in hectares or square metres. |
| **Box select** | Drag a rectangle to select every feature inside it. Hold Shift to add to the current selection. |
| **Select visible** | Selects every feature currently drawn in the viewport. |
| **Select by attribute** | Selects every loaded feature matching the current search across its attributes. |

Spatial selection is delegated to MapLibre's own `queryRenderedFeatures`, so it matches exactly what is drawn
rather than a reimplemented predicate. Measurements live in their own map source and are never part of an
export — a measurement is the user's annotation, not data from the source.

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

### GML and the axis-order trap

WFS deployments that cannot emit GeoJSON are read as GML, which brings the one genuinely dangerous ambiguity in
GIS interchange. `EPSG:4326` defines latitude as its first axis, but the short form `EPSG:4326` was used by
almost everyone to mean longitude first, so OGC introduced the URN form `urn:ogc:def:crs:EPSG::4326` to mean the
authority's real order. **The two spellings of "the same" CRS imply opposite coordinate orders.**

Reading this wrong does not throw and does not look broken — it silently transposes every coordinate, putting a
parcel in Gujarat into the Indian Ocean. The order is therefore derived from the declared `srsName` by explicit
rule (CRS84 → lon/lat; URN or OGC URI → lat/lon; short form → lon/lat; projected CRS → easting/northing), and:

- GML requests ask for `urn:ogc:def:crs:OGC:1.3:CRS84`, whose order is unambiguous by definition.
- A server that declares **no** `srsName` leaves the order unknowable. Because asking for CRS84 is not the same
  as the server confirming it, that geometry is marked CRS-unknown and is **not** offered for KML export —
  rather than quietly claiming EPSG:4326.
- A plausibility check flags geometry that only makes sense transposed. It reports the suspicion; it never
  silently "corrects" the coordinates.

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

### The browser pass

The deep scan is the one place the source's own code runs, so it is worth being precise about what it does.

- It is **opt-in per scan** and uses a browser already on the machine. Nothing is downloaded.
- Every request the browser makes is checked against **the same address rules** as the server-side fetcher, per
  host and cached per host. One aimed at a private, loopback or link-local address is aborted before it leaves
  the machine, and appears in Diagnostics as refused.
- It sends the **browser's own user agent with this tool's identity appended**. Nothing is disguised, no
  fingerprint is spoofed, no stealth patch is applied, and `Headless` is not scrubbed out. A source that wants
  to refuse this tool can see it and refuse it.
- It carries **no credentials, cookies, storage state or session**, and it does not click through a login, a
  consent wall or a captcha.
- It is **one visit** with one settle period, then it closes. There is no retry loop.
- It **observes**; it never extracts. URLs it records are fetched afterwards through the guarded path above.

Limits are configured through environment variables and clamped to hard ceilings in code, so they cannot be
raised from the browser. They are all listed on the Settings screen.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/connect` | Run a discovery scan. Optional body: `{ useBrowser, browserSettleMs, extraUrls[] }` |
| `GET` | `/api/connect` | Last scan, without spending requests |
| `GET` | `/api/diagnostics` | What the last scan fetched, observed and rejected |
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
| `POST` | `/api/preserve` | Sweep the source for original KML/KMZ and preserve it |
| `GET` | `/api/source-files` · `/:id` | The preserved originals |
| `GET` | `/api/source-files/:id/download` | An original, byte for byte |
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
├── Original/                   Files the source published, byte for byte
│   └── <source filename>.kml
├── Reconstructed/              Generated by this tool from map geometry
│   ├── KML/<Location>.kml      Combined, with folders
│   └── Individual/<Location>_<Feature>.kml
├── README.txt                  What the two directories mean
└── metadata.json               Provenance for both, including SHA-256 of each original
```

---

## Testing

```bash
npm test          # 286 unit tests
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

- **Discovery is best-effort.** A plain scan reads the page and its scripts server-side, so it cannot see a URL
  the application assembles at runtime; the deep scan exists for exactly that and is the first thing to reach
  for when a scan comes back empty. Even then, a map that loads its data only after a specific user interaction
  — a search, a form submission, a click on one parcel — may not be caught, because the deep scan loads the
  page and watches; it does not drive the interface. Paste the URL in by hand when that happens. Whatever is
  missed is reported as missed, with the evidence, rather than papered over.
- **GeoPackage and shapefile archives are detected but not yet read.**
- **Vector tiles are a fallback, not an equal.** See the provenance table.
- **A raster-only source yields no KML.** By design.
- **Box selection acts on rendered geometry**, so a feature scrolled out of view is not selected by it. "Select
  visible" is explicit about this; use the attribute search to reach features beyond the viewport.

---

## Data use

> This tool extracts or converts geographic information that is publicly accessible through the authorised
> source. Users are responsible for complying with TownPlanMap's terms, applicable licences, copyright,
> database rights and other applicable laws. Extracted geographic data should be independently verified before
> use in legal, surveying, property or other high-stakes decisions.

TownPlanMap describes its service as an informational and decision-support platform and recommends verifying
information with the relevant government authority for legal or official purposes. This project is an
independent extractor and is not affiliated with TownPlanMap.
