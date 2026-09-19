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
import length from '@turf/length';
import area from '@turf/area';
import type { BoundingBox, Geometry, Position } from '@/lib/geo/types';

export type MapFeature = {
  id: string;
  name: string;
  geometry: Geometry;
  properties?: Record<string, string | number | boolean | null>;
  /** Drawn in the selection colour when true. */
  selected?: boolean;
};

export type BasemapId = 'map' | 'satellite' | 'terrain' | 'none';

/** The optional GIS tools offered on the map. */
export type MapTool = 'none' | 'measure-distance' | 'measure-area' | 'select-box';

const TOOL_LABELS: Record<Exclude<MapTool, 'none'>, string> = {
  'measure-distance': 'Measure distance',
  'measure-area': 'Measure area',
  'select-box': 'Select by rectangle',
};

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
const MEASURE_SOURCE = 'tpm-measure';
const MEASURE_FILL = 'tpm-measure-fill';
const MEASURE_LINE = 'tpm-measure-line';
const MEASURE_POINTS = 'tpm-measure-points';
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

/**
 * Wrap a callback so its identity is stable while it always calls the latest
 * version.
 *
 * The map's effects attach DOM and MapLibre listeners. If they depended on
 * callback props directly, a caller passing an inline arrow — which is the
 * normal thing to do — would tear those listeners down and rebuild them on
 * every render, dropping in-progress drags and resetting any state the
 * listeners had set.
 */
function useStableCallback<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): (...args: A) => R | undefined {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  }, [callback]);
  return useCallback((...args: A) => ref.current?.(...args), []);
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
  onSelectMany,
  onBoundsChange,
  fitKey,
  height = '100%',
  showAttributionNotice = true,
  tools = false,
}: {
  features: MapFeature[];
  selectedIds?: string[];
  onSelect?: (featureId: string) => void;
  /** Called by the spatial selection tools with every feature they matched. */
  onSelectMany?: (featureIds: string[], mode: 'replace' | 'add') => void;
  onBoundsChange?: (bbox: BoundingBox) => void;
  /** Changing this value refits the map to the current features. */
  fitKey?: string | number;
  height?: string;
  showAttributionNotice?: boolean;
  /** Show the measurement and spatial-selection tools. */
  tools?: boolean;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const popup = useRef<Popup | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('map');
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);
  const [tool, setTool] = useState<MapTool>('none');
  const [measured, setMeasured] = useState<Position[]>([]);
  const [boxHint, setBoxHint] = useState<string | null>(null);

  const handleSelect = useStableCallback(onSelect);
  const handleSelectMany = useStableCallback(onSelectMany);
  const handleBoundsChange = useStableCallback(onBoundsChange);

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

    // The measurement overlay lives in its own source so it never mixes with
    // extracted geometry — a measurement is the user's annotation, not data
    // from the source, and must never end up in an export.
    if (!instance.getSource(MEASURE_SOURCE)) {
      instance.addSource(MEASURE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!instance.getLayer(MEASURE_FILL)) {
      instance.addLayer({
        id: MEASURE_FILL,
        type: 'fill',
        source: MEASURE_SOURCE,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#34d399', 'fill-opacity': 0.18 },
      });
    }
    if (!instance.getLayer(MEASURE_LINE)) {
      instance.addLayer({
        id: MEASURE_LINE,
        type: 'line',
        source: MEASURE_SOURCE,
        filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
        paint: { 'line-color': '#34d399', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
    }
    if (!instance.getLayer(MEASURE_POINTS)) {
      instance.addLayer({
        id: MEASURE_POINTS,
        type: 'circle',
        source: MEASURE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#34d399',
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

  // --- measurement overlay -------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource(MEASURE_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;

    const drawn: GeoJSON.Feature[] = measured.map((position) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position as number[] },
      properties: {},
    }));

    if (tool === 'measure-area' && measured.length >= 3) {
      drawn.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...measured, measured[0]!] as number[][]] },
        properties: {},
      });
    } else if (measured.length >= 2) {
      drawn.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: measured as number[][] },
        properties: {},
      });
    }

    source.setData({ type: 'FeatureCollection', features: drawn });
  }, [measured, tool, ready]);

  // Leaving a tool clears whatever it drew.
  useEffect(() => {
    if (tool === 'none') setMeasured([]);
  }, [tool]);

  // --- measurement clicks ---------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    if (tool !== 'measure-distance' && tool !== 'measure-area') return;

    const onClick = (event: MapMouseEvent) => {
      setMeasured((current) => [...current, [event.lngLat.lng, event.lngLat.lat]]);
    };
    const onDoubleClick = (event: MapMouseEvent) => {
      // Finish the measurement rather than zooming.
      event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool('none');
      if (event.key === 'Backspace') setMeasured((current) => current.slice(0, -1));
    };

    instance.on('click', onClick);
    instance.on('dblclick', onDoubleClick);
    instance.getCanvas().style.cursor = 'crosshair';
    window.addEventListener('keydown', onKey);

    return () => {
      instance.off('click', onClick);
      instance.off('dblclick', onDoubleClick);
      instance.getCanvas().style.cursor = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [tool, ready]);

  // --- rectangle selection ---------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || tool !== 'select-box') return;

    const canvas = instance.getCanvasContainer();
    let start: { x: number; y: number } | null = null;
    let box: HTMLDivElement | null = null;

    // Panning has to give way while a box is being dragged.
    instance.dragPan.disable();
    instance.boxZoom.disable();
    instance.getCanvas().style.cursor = 'crosshair';
    setBoxHint('Drag a rectangle over the features to select them. Hold Shift to add to the selection.');

    const pointOf = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      start = pointOf(event);
      box = document.createElement('div');
      box.style.cssText =
        'position:absolute;border:1.5px dashed #fbbf24;background:rgba(251,191,36,0.12);pointer-events:none;z-index:5';
      canvas.appendChild(box);
      event.preventDefault();
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!start || !box) return;
      const current = pointOf(event);
      const left = Math.min(start.x, current.x);
      const top = Math.min(start.y, current.y);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(current.x - start.x)}px`;
      box.style.height = `${Math.abs(current.y - start.y)}px`;
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!start) return;
      const current = pointOf(event);
      box?.remove();
      box = null;

      const from = start;
      start = null;

      // A click rather than a drag: leave it to the ordinary select handler.
      if (Math.abs(current.x - from.x) < 4 && Math.abs(current.y - from.y) < 4) return;

      // MapLibre does the spatial query itself, against what is actually
      // rendered, which is both correct and exactly what the user sees.
      const hits = instance.queryRenderedFeatures(
        [
          [Math.min(from.x, current.x), Math.min(from.y, current.y)],
          [Math.max(from.x, current.x), Math.max(from.y, current.y)],
        ],
        { layers: [FILL_LAYER, LINE_LAYER, POINT_LAYER] },
      ) as MapGeoJSONFeature[];

      const ids = [
        ...new Set(
          hits
            .map((hit) => hit.properties?.__id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];

      handleSelectMany(ids, event.shiftKey ? 'add' : 'replace');
      setBoxHint(
        ids.length === 0
          ? 'No features fell inside that rectangle.'
          : `${ids.length.toLocaleString()} feature(s) selected.`,
      );
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool('none');
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKey);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKey);
      box?.remove();
      instance.dragPan.enable();
      instance.boxZoom.enable();
      instance.getCanvas().style.cursor = '';
      setBoxHint(null);
    };
    // Deliberately not depending on the selection handler: it is stable, and a
    // caller's inline arrow must not tear down a drag that is under way.
  }, [tool, ready, handleSelectMany]);

  /** Select every feature currently drawn in the viewport. */
  const selectVisible = useCallback(() => {
    const instance = map.current;
    if (!instance) return;
    const hits = instance.queryRenderedFeatures(undefined, {
      layers: [FILL_LAYER, LINE_LAYER, POINT_LAYER],
    }) as MapGeoJSONFeature[];

    const ids = [
      ...new Set(
        hits.map((hit) => hit.properties?.__id).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    handleSelectMany(ids, 'replace');
    setBoxHint(
      ids.length === 0
        ? 'No features are visible in the current view.'
        : `${ids.length.toLocaleString()} visible feature(s) selected.`,
    );
  }, [handleSelectMany]);

  // --- interaction --------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    // A tool owns the pointer while it is active; selecting a feature by
    // accident mid-measurement would be its own kind of wrong.
    if (tool !== 'none') return;

    const interactive = [FILL_LAYER, LINE_LAYER, POINT_LAYER];

    const handleClick = (event: MapMouseEvent) => {
      const hits = instance.queryRenderedFeatures(event.point, { layers: interactive }) as MapGeoJSONFeature[];
      const hit = hits[0];
      if (!hit) return;
      const id = hit.properties?.__id;
      if (typeof id === 'string') handleSelect(id);
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
      const bounds = instance.getBounds();
      handleBoundsChange([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
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
  }, [ready, handleSelect, handleBoundsChange, tool]);

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

  /**
   * The measurement readout.
   *
   * Distance is geodesic and area is on the ellipsoid, both from turf, rather
   * than anything planar computed on screen coordinates.
   */
  const measurement = useMemo((): string | null => {
    if (tool === 'measure-distance' && measured.length >= 2) {
      const metres = length(
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: measured as number[][] } },
        { units: 'meters' },
      );
      return metres >= 1000 ? `${(metres / 1000).toFixed(3)} km` : `${metres.toFixed(1)} m`;
    }

    if (tool === 'measure-area' && measured.length >= 3) {
      const squareMetres = area({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[...measured, measured[0]!] as number[][]] },
      });
      return squareMetres >= 10_000
        ? `${(squareMetres / 10_000).toFixed(3)} ha`
        : `${Math.round(squareMetres).toLocaleString()} m\u00b2`;
    }

    return null;
  }, [tool, measured]);

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

        {tools && (
          <div className="flex flex-col gap-2">
            <div className="flex overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 backdrop-blur">
              {(Object.keys(TOOL_LABELS) as Array<Exclude<MapTool, 'none'>>).map((id) => (
                <button
                  key={id}
                  type="button"
                  title={TOOL_LABELS[id]}
                  aria-pressed={tool === id}
                  onClick={() => setTool(tool === id ? 'none' : id)}
                  className={`px-2.5 py-1.5 text-xs transition-colors ${
                    tool === id
                      ? 'bg-[var(--color-accent-strong)] text-white'
                      : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {id === 'measure-distance' ? 'Distance' : id === 'measure-area' ? 'Area' : 'Box select'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={selectVisible}
              disabled={decorated.length === 0}
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] backdrop-blur transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
            >
              Select visible
            </button>
          </div>
        )}
      </div>

      {tools && (tool !== 'none' || measurement) && (
        <div className="absolute bottom-10 right-3 max-w-xs rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)]/95 px-3 py-2 text-xs backdrop-blur">
          {measurement ? (
            <>
              <p className="label mb-0.5">
                {tool === 'measure-area' ? 'Area' : 'Distance'}
              </p>
              <p className="mono text-sm text-[var(--color-good)]">{measurement}</p>
              <p className="mt-1 text-[var(--color-ink-subtle)]">
                {measured.length} point(s). Backspace removes the last, Esc finishes.
              </p>
              <p className="mt-1 text-[var(--color-ink-subtle)]">
                A measurement is your own annotation and is never included in an export.
              </p>
            </>
          ) : tool === 'select-box' ? (
            <p className="text-[var(--color-ink-muted)]">
              {boxHint ?? 'Drag a rectangle over the features to select them.'}
            </p>
          ) : (
            <p className="text-[var(--color-ink-muted)]">
              Click on the map to add points. Esc finishes.
            </p>
          )}
        </div>
      )}

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
