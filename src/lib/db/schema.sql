-- TownPlanMap KML Extractor — PostGIS schema.
--
-- Geometry is stored in a real spatial column (SRID 4326, matching KML's
-- coordinate system) so that spatial queries, area calculations and bounding
-- box lookups are done by PostGIS rather than in application code.
--
-- Apply with:  psql "$DATABASE_URL" -f src/lib/db/schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- Cities and the areas/villages inside them. `parent_id` is null for a city.
CREATE TABLE IF NOT EXISTS locations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('city', 'area')),
  parent_id     TEXT REFERENCES locations (id) ON DELETE CASCADE,
  source_url    TEXT NOT NULL,
  source_field  TEXT,
  bbox          geometry(Polygon, 4326),
  feature_count INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS locations_parent_idx ON locations (parent_id);
CREATE INDEX IF NOT EXISTS locations_kind_idx ON locations (kind);
CREATE INDEX IF NOT EXISTS locations_name_idx ON locations (lower(name));

-- A discovered upstream service endpoint, with what the probe established.
CREATE TABLE IF NOT EXISTS source_datasets (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  nature         TEXT NOT NULL CHECK (nature IN ('vector', 'raster', 'metadata', 'unknown')),
  discovered_in  TEXT NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,
  probe          JSONB,
  scan_id        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_datasets_nature_idx ON source_datasets (nature);

-- A map layer behind an endpoint.
CREATE TABLE IF NOT EXISTS map_layers (
  id              TEXT PRIMARY KEY,
  source_layer_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,
  dataset_id      TEXT REFERENCES source_datasets (id) ON DELETE CASCADE,
  endpoint_kind   TEXT NOT NULL,
  service_url     TEXT NOT NULL,
  availability    JSONB NOT NULL,
  crs             JSONB NOT NULL,
  feature_count   INTEGER,
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  bbox            geometry(Polygon, 4326),
  location_id     TEXT REFERENCES locations (id) ON DELETE SET NULL,
  kml_exportable  BOOLEAN NOT NULL DEFAULT false,
  kml_note        TEXT NOT NULL DEFAULT '',
  attribution     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS map_layers_location_idx ON map_layers (location_id);
CREATE INDEX IF NOT EXISTS map_layers_category_idx ON map_layers (category);
CREATE INDEX IF NOT EXISTS map_layers_bbox_idx ON map_layers USING GIST (bbox);

-- Features, with their geometry in a spatial column.
--
-- `geometry` is nullable on purpose: a feature that the source exposes without
-- usable geometry is still recorded, so the UI can show it and explain why no
-- KML is available rather than omitting it.
CREATE TABLE IF NOT EXISTS features (
  id                TEXT PRIMARY KEY,
  layer_id          TEXT NOT NULL REFERENCES map_layers (id) ON DELETE CASCADE,
  source_id         TEXT,
  feature_name      TEXT NOT NULL,
  feature_type      TEXT,
  properties        JSONB NOT NULL DEFAULT '{}'::jsonb,
  geometry          geometry(Geometry, 4326),
  provenance        TEXT NOT NULL,
  provenance_note   TEXT NOT NULL DEFAULT '',
  source_crs        TEXT,
  kml_available     BOOLEAN NOT NULL DEFAULT false,
  kml_note          TEXT NOT NULL DEFAULT '',
  source_url        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS features_layer_idx ON features (layer_id);
CREATE INDEX IF NOT EXISTS features_name_idx ON features (lower(feature_name));
CREATE INDEX IF NOT EXISTS features_source_id_idx ON features (source_id);
CREATE INDEX IF NOT EXISTS features_geometry_idx ON features USING GIST (geometry);
-- Attribute search across whatever fields the source happened to provide.
CREATE INDEX IF NOT EXISTS features_properties_idx ON features USING GIN (properties);

-- Discovery scans.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id            TEXT PRIMARY KEY,
  base_url      TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  connected     BOOLEAN NOT NULL DEFAULT false,
  requests_spent INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  result        JSONB NOT NULL
);

-- Export jobs and their generated artefacts.
CREATE TABLE IF NOT EXISTS exports (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'complete', 'failed', 'cancelled')),
  format          TEXT NOT NULL CHECK (format IN ('kml', 'kmz', 'geojson', 'bundle')),
  label           TEXT NOT NULL,
  filename        TEXT,
  requested       JSONB NOT NULL,
  progress        JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation      JSONB,
  feature_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  byte_size       BIGINT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS exports_status_idx ON exports (status);
CREATE INDEX IF NOT EXISTS exports_created_idx ON exports (created_at DESC);

-- Original KML/KMZ files retrieved from the source and preserved verbatim.
--
-- `content` holds the exact bytes the source served. They are never rewritten,
-- re-serialised or normalised: `sha256` is what makes a preserved copy provably
-- identical to the original, so any transformation would destroy the point.
--
-- `origin` is fixed to 'original' by a CHECK constraint. Generated documents
-- belong in `exports`, and the constraint makes it impossible to file a
-- reconstructed artefact here by mistake.
-- Responses the browser received and the tool kept, so they can be read back
-- without asking the source to repeat a request made by a session that no
-- longer exists. Kept apart from source_files: those are documents the source
-- publishes, these are API responses it returned to one browser.
CREATE TABLE IF NOT EXISTS captured_responses (
  id                     TEXT PRIMARY KEY,
  url                    TEXT NOT NULL UNIQUE,
  content_type           TEXT,
  kind                   TEXT NOT NULL,
  byte_size              BIGINT NOT NULL,
  content                BYTEA NOT NULL,
  captured_at            TIMESTAMPTZ NOT NULL,
  -- Whether the window was signed in by the person using it at the time.
  -- Recorded so the interface can say where data came from; this tool never
  -- performs the sign-in and never stores a credential.
  from_signed_in_session BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS source_files (
  id             TEXT PRIMARY KEY,
  origin         TEXT NOT NULL DEFAULT 'original' CHECK (origin = 'original'),
  url            TEXT NOT NULL,
  final_url      TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('kml', 'kmz')),
  filename       TEXT NOT NULL,
  content_type   TEXT,
  byte_size      BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  content        BYTEA NOT NULL,
  retrieved_at   TIMESTAMPTZ NOT NULL,
  last_modified  TEXT,
  etag           TEXT,
  discovered_in  TEXT NOT NULL,
  route          TEXT NOT NULL,
  parent_id      TEXT REFERENCES source_files (id) ON DELETE SET NULL,
  depth          INTEGER NOT NULL DEFAULT 0,
  inspection     JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- The same document is often reachable by several routes; the hash is what
-- identifies it, so duplicates are recognisable without a byte comparison.
CREATE INDEX IF NOT EXISTS source_files_sha_idx ON source_files (sha256);
CREATE INDEX IF NOT EXISTS source_files_route_idx ON source_files (route);
CREATE INDEX IF NOT EXISTS source_files_retrieved_idx ON source_files (retrieved_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS source_files_url_sha_idx ON source_files (url, sha256);
