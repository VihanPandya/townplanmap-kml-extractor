'use client';

/**
 * The interactive map.
 *
 * MapLibre GL renders the discovered geometry. Basemaps are raster tile
 * services chosen at runtime, and every one carries the attribution its
 * provider requires — a GIS tool has no business stripping that. All three are
 * overridable through `NEXT_PUBLIC_BASEMAP_*` environment variables so an
 * operator can point the tool at their own tile server instead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AttributionControl,
  GeoJSONSource,
  MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type LngLatBoundsLike,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { BoundingBox, Geometry } from '@/lib/geo/types';

export type MapFeature = {
  id: string;
  name: string;
  geometry: Geometry;
  properties?: Record<string, string | number | boolean | null>;
  /** Drawn in the selection colour when true. */
  selected?: boolean;
};

export type BasemapId = 'map' | 'satellite' | 'terrain' | 'none';

type BasemapDefinition = { label: string; tiles: string[] | null; attribution: string; maxzoom: number };

const BASEMAPS: Record<BasemapId, BasemapDefinition> = {
  map: {
    label: 'Map',
    tiles: [process.env.NEXT_PUBLIC_BASEMAP_MAP_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution:
      process.env.NEXT_PUBLIC_BASEMAP_MAP_ATTRIBUTION ??
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  satellite: {
    label: 'Satellite',
    tiles: [
      process.env.NEXT_PUBLIC_BASEMAP_SATELLITE_URL ??
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution:
      process.env.NEXT_PUBLIC_BASEMAP_SATELLITE_ATTRIBUTION ??
      'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community',
    maxzoom: 19,
  },
  terrain: {
    label: 'Terrain',
    tiles: [process.env.NEXT_PUBLIC_BASEMAP_TERRAIN_URL ?? 'https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution:
      process.env.NEXT_PUBLIC_BASEMAP_TERRAIN_ATTRIBUTION ??
      'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors, rendering &copy; <a href="https://opentopomap.org" target="_blank" rel="noreferrer">OpenTopoMap</a> (CC-BY-SA)',
    maxzoom: 17,
  },
  none: { label: 'No basemap', tiles: null, attribution: '', maxzoom: 22 },
};

/**
 * Point MapLibre at the worker bundle we publish under `public/maplibre/`.
 *
 * MapLibre 6 resolves its worker relative to its own module URL, which after
 * bundling points into the build's chunk directory where the worker file does
 * not exist. The request 404s, the worker dies, and GeoJSON sources then stay
 * silently empty — the map renders, pans and zooms, but never shows a feature.
 * `scripts/copy-maplibre-worker.mjs` puts the file where this URL expects it.
 */
if (typeof window !== 'undefined') {
  setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
}

const SOURCE_ID = 'tpm-features';
const FILL_LAYER = 'tpm-fill';
const LINE_LAYER = 'tpm-line';
const POINT_LAYER = 'tpm-point';
const BASEMAP_SOURCE = 'tpm-basemap';
const BASEMAP_LAYER = 'tpm-basemap-layer';

function buildStyle(basemap: BasemapId): StyleSpecification {
  const definition = BASEMAPS[basemap];
  const sources: StyleSpecification['sources'] = {};
  const layers: StyleSpecification['layers'] = [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0b0e14' },
    },
  ];

  if (definition.tiles) {
    sources[BASEMAP_SOURCE] = {
      type: 'raster',
      tiles: definition.tiles,
      tileSize: 256,
      maxzoom: definition.maxzoom,
      attribution: definition.attribution,
    };
    layers.push({
      id: BASEMAP_LAYER,
      type: 'raster',
      source: BASEMAP_SOURCE,
      // Dim the basemap slightly so extracted geometry reads as the subject.
      paint: { 'raster-opacity': basemap === 'satellite' ? 1 : 0.82 },
    });
  }

  // `glyphs` is omitted rather than set to undefined: MapLibre validates the key
  // as a string when it is present at all, and an undefined value aborts the
  // whole style load — leaving a map with no sources, no layers and no `load`
  // event. Nothing here renders text labels, so no glyph source is needed.
  return { version: 8, sources, layers };
}

function toCollection(features: MapFeature[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      type: 'Feature',
      // MapLibre needs a numeric or string id for feature state; the record id
      // is carried in properties so click handlers can read it back.
      id: feature.id,
      geometry: feature.geometry as GeoJSON.Geometry,
      properties: {
        ...feature.properties,
        __id: feature.id,
        __name: feature.name,
        __selected: feature.selected ? 1 : 0,
      },
    })),
  };
}

function boundsOf(features: MapFeature[]): BoundingBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (position: number[]) => {
    const [x, y] = position;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  };

  const walk = (geometry: Geometry) => {
    switch (geometry.type) {
      case 'Point':
        visit(geometry.coordinates);
        break;
      case 'MultiPoint':
      case 'LineString':
        geometry.coordinates.forEach(visit);
        break;
      case 'MultiLineString':
      case 'Polygon':
        geometry.coordinates.forEach((part) => part.forEach(visit));
        break;
      case 'MultiPolygon':
        geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
        break;
      case 'GeometryCollection':
        geometry.geometries.forEach(walk);
        break;
      default:
        break;
    }
  };

  features.forEach((feature) => walk(feature.geometry));

  if (![west, south, east, north].every(Number.isFinite)) return null;
  return [west, south, east, north];
}

export function MapView({
  features,
  selectedIds,
  onSelect,
  onBoundsChange,
  fitKey,
  height = '100%',
  showAttributionNotice = true,
}: {
  features: MapFeature[];
  selectedIds?: string[];
  onSelect?: (featureId: string) => void;
  onBoundsChange?: (bbox: BoundingBox) => void;
  /** Changing this value refits the map to the current features. */
  fitKey?: string | number;
  height?: string;
  showAttributionNotice?: boolean;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const popup = useRef<Popup | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('map');
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);

  const selection = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

  const decorated = useMemo(
    () => features.map((feature) => ({ ...feature, selected: selection.has(feature.id) })),
    [features, selection],
  );

  const collection = useMemo(() => toCollection(decorated), [decorated]);

  // The style-lifecycle effects below must not re-run when the data changes, or
  // every new feature page would tear the style down and rebuild it. They read
  // the current data through this ref instead of depending on it.
  //
  // The ref is updated in an effect rather than during render: a render-time
  // mutation is not safe under React's rules, and the map callbacks that read it
  // (`load`, `styledata`) all fire asynchronously, after effects have run.
  const collectionRef = useRef(collection);
  useEffect(() => {
    collectionRef.current = collection;
  }, [collection]);

  /** Add our source and layers on top of whatever basemap style is loaded. */
  const installLayers = useCallback((instance: MapLibreMap, data: GeoJSON.FeatureCollection) => {
    if (!instance.getSource(SOURCE_ID)) {
      instance.addSource(SOURCE_ID, { type: 'geojson', data, promoteId: '__id' });
    }

    if (!instance.getLayer(FILL_LAYER)) {
      instance.addLayer({
        id: FILL_LAYER,
        type: 'fill',
        source: SOURCE_ID,
        filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
        paint: {
          'fill-color': ['case', ['==', ['get', '__selected'], 1], '#fbbf24', '#4f8ff7'],
          'fill-opacity': ['case', ['==', ['get', '__selected'], 1], 0.4, 0.22],
        },
      });
    }

    if (!instance.getLayer(LINE_LAYER)) {
      instance.addLayer({
        id: LINE_LAYER,
        type: 'line',
        source: SOURCE_ID,
        filter: [
          'in',
          ['geometry-type'],
          ['literal', ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString']],
        ],
        paint: {
          'line-color': ['case', ['==', ['get', '__selected'], 1], '#fbbf24', '#4f8ff7'],
          'line-width': ['case', ['==', ['get', '__selected'], 1], 3, 1.6],
        },
      });
    }

    if (!instance.getLayer(POINT_LAYER)) {
      instance.addLayer({
        id: POINT_LAYER,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
        paint: {
          'circle-radius': ['case', ['==', ['get', '__selected'], 1], 7, 5],
          'circle-color': ['case', ['==', ['get', '__selected'], 1], '#fbbf24', '#4f8ff7'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b0e14',
        },
      });
    }
  }, []);

  // --- create the map once ------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new MapLibreMap({
      container: container.current,
      style: buildStyle('map'),
      center: [78.9629, 22.5937], // Centred on India until data arrives.
      zoom: 3.6,
      attributionControl: false,
    });

    instance.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
    instance.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    instance.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    instance.on('load', () => {
      installLayers(instance, collectionRef.current);
      setReady(true);
    });

    // `setStyle` discards every source and layer, so anything we added has to be
    // put back each time a style finishes loading. A persistent listener is used
    // rather than a one-shot, because a style can reload more than once.
    instance.on('styledata', () => {
      if (!instance.isStyleLoaded()) return;
      installLayers(instance, collectionRef.current);
    });

    // A basemap provider that refuses or rate-limits should be reported, not
    // left as a silently blank map.
    instance.on('error', (event: { error?: { message?: string } }) => {
      const message = event.error?.message ?? '';
      if (/tile|fetch|network|403|429/i.test(message)) {
        setTileError('Basemap tiles could not be loaded. Extracted geometry is still shown.');
      }
    });

    map.current = instance;

    return () => {
      popup.current?.remove();
      instance.remove();
      map.current = null;
    };
    // `installLayers` is a dependency-free useCallback, so it is stable and the
    // map is still created exactly once.
  }, [installLayers]);

  // --- basemap switching --------------------------------------------------
  const appliedBasemap = useRef<BasemapId>('map');

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    // The map is created with the default basemap already applied, so calling
    // setStyle for it again would tear the style down for no reason.
    if (appliedBasemap.current === basemap) return;

    appliedBasemap.current = basemap;
    setTileError(null);
    instance.setStyle(buildStyle(basemap));
    // The persistent styledata listener above reinstalls our layers once the
    // new style has loaded.
  }, [basemap, ready]);

  // --- data updates -------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const source = instance.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(collection);
    } else if (instance.isStyleLoaded()) {
      installLayers(instance, collection);
    }
    // When the style is mid-load there is nothing to do: the styledata listener
    // installs the layers with the current data as soon as it settles.
  }, [collection, ready, installLayers]);

  // --- interaction --------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    const interactive = [FILL_LAYER, LINE_LAYER, POINT_LAYER];

    const handleClick = (event: MapMouseEvent) => {
      const hits = instance.queryRenderedFeatures(event.point, { layers: interactive }) as MapGeoJSONFeature[];
      const hit = hits[0];
      if (!hit) return;
      const id = hit.properties?.__id;
      if (typeof id === 'string') onSelect?.(id);
    };

    const handleMove = (event: MapMouseEvent) => {
      const hits = instance.queryRenderedFeatures(event.point, { layers: interactive }) as MapGeoJSONFeature[];
      const hit = hits[0];

      instance.getCanvas().style.cursor = hit ? 'pointer' : '';

      if (!hit) {
        popup.current?.remove();
        popup.current = null;
        return;
      }

      const name = typeof hit.properties?.__name === 'string' ? hit.properties.__name : 'Feature';
      const type = hit.geometry.type;

      if (!popup.current) {
        popup.current = new Popup({ closeButton: false, closeOnClick: false, offset: 8 });
      }
      popup.current
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong style="display:block;margin-bottom:2px">${escapeHtml(name)}</strong>` +
            `<span style="color:#94a3b8">${escapeHtml(type)}</span>`,
        )
        .addTo(instance);
    };

    const handleLeave = () => {
      popup.current?.remove();
      popup.current = null;
      instance.getCanvas().style.cursor = '';
    };

    const handleMoveEnd = () => {
      if (!onBoundsChange) return;
      const bounds = instance.getBounds();
      onBoundsChange([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
    };

    instance.on('click', handleClick);
    instance.on('mousemove', handleMove);
    instance.on('mouseout', handleLeave);
    instance.on('moveend', handleMoveEnd);

    return () => {
      instance.off('click', handleClick);
      instance.off('mousemove', handleMove);
      instance.off('mouseout', handleLeave);
      instance.off('moveend', handleMoveEnd);
    };
  }, [ready, onSelect, onBoundsChange]);

  // --- fitting ------------------------------------------------------------
  const fit = useCallback(
    (target: MapFeature[]) => {
      const instance = map.current;
      if (!instance || target.length === 0) return;
      const bbox = boundsOf(target);
      if (!bbox) return;

      const [west, south, east, north] = bbox;
      // A single point has no extent; pad it so fitBounds does not zoom to max.
      const pad = east - west < 1e-6 && north - south < 1e-6 ? 0.002 : 0;
      const bounds: LngLatBoundsLike = [
        [west - pad, south - pad],
        [east + pad, north + pad],
      ];
      instance.fitBounds(bounds, { padding: 48, maxZoom: 18, duration: 600 });
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    fit(decorated);
    // `fitKey` is the caller's signal to refit; features alone would refit on
    // every pagination, fighting the user's own panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  const selectedFeatures = useMemo(
    () => decorated.filter((feature) => feature.selected),
    [decorated],
  );

  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--color-border)]" style={{ height }}>
      <div ref={container} className="h-full w-full" />

      <div className="absolute left-3 top-3 flex flex-col gap-2">
        <div className="flex overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 backdrop-blur">
          {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setBasemap(id)}
              aria-pressed={basemap === id}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                basemap === id
                  ? 'bg-[var(--color-accent-strong)] text-white'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {BASEMAPS[id].label}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fit(decorated)}
            disabled={decorated.length === 0}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] backdrop-blur transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            Fit all
          </button>
          <button
            type="button"
            onClick={() => fit(selectedFeatures)}
            disabled={selectedFeatures.length === 0}
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] backdrop-blur transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            Fit selection
          </button>
        </div>
      </div>

      {tileError && (
        <p className="absolute bottom-10 left-3 max-w-xs rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] px-2.5 py-1.5 text-xs text-[var(--color-warn)]">
          {tileError}
        </p>
      )}

      {decorated.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/90 px-4 py-2 text-sm text-[var(--color-ink-muted)] backdrop-blur">
            No geometry to display yet.
          </p>
        </div>
      )}

      {showAttributionNotice && (
        <p className="sr-only">
          Basemap imagery is provided by third parties and carries its own attribution, shown on the map.
        </p>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
