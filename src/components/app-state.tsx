'use client';

/**
 * Client-side workflow state.
 *
 * The product is a linear workflow — connect, city, area, layer, feature — and
 * every screen needs to know where the user is in it. That lives here, in one
 * context, and is mirrored into sessionStorage so a page refresh does not throw
 * the user back to the start.
 *
 * Only *selections* are stored. Discovered data is always re-read from the API
 * so the browser can never show a stale catalog as if it were live.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LayerRecord, LocationRecord } from '@/lib/discovery/types';

export type ConnectionState =
  | { status: 'unknown' }
  | { status: 'connecting' }
  | {
      status: 'connected';
      scanId: string;
      /** False when only a stand-in dataset is available. */
      sourceReachable: boolean;
      mapInterfaceDetected: boolean;
      geographicLayersDetected: boolean;
      endpointCount: number;
      vectorEndpointCount: number;
      rasterEndpointCount: number;
      storage: { kind: string; durable: boolean };
      notes: string[];
      warnings: string[];
      /** Concrete next steps from the scan, shown when a result is thin. */
      advice: string[];
      /** Whether this scan watched the site in a real browser. */
      browserUsed: boolean;
    }
  | { status: 'failed'; error: string; detail?: string };

/** Whether a browser is available on this machine for a deep scan. */
export type BrowserAvailability = { available: boolean; defaultOn: boolean };

export type ConnectOptions = {
  useBrowser?: boolean;
  /** URLs the user pasted in, typically from their own network panel. */
  extraUrls?: string[];
};

type Selection = {
  cityId: string | null;
  cityName: string | null;
  areaId: string | null;
  areaName: string | null;
  layerId: string | null;
  layerName: string | null;
  featureIds: string[];
};

const EMPTY_SELECTION: Selection = {
  cityId: null,
  cityName: null,
  areaId: null,
  areaName: null,
  layerId: null,
  layerName: null,
  featureIds: [],
};

type AppState = {
  connection: ConnectionState;
  selection: Selection;
  browser: BrowserAvailability;
  connect: (options?: ConnectOptions) => Promise<void>;
  refreshConnection: () => Promise<void>;
  selectCity: (city: LocationRecord | null) => void;
  selectArea: (area: LocationRecord | null) => void;
  selectLayer: (layer: Pick<LayerRecord, 'id' | 'name'> | null) => void;
  toggleFeature: (featureId: string) => void;
  setFeatureSelection: (featureIds: string[]) => void;
  clearFeatureSelection: () => void;
};

const AppStateContext = createContext<AppState | null>(null);

const STORAGE_KEY = 'tpm-extractor-selection';

function loadSelection(): Selection {
  if (typeof window === 'undefined') return EMPTY_SELECTION;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SELECTION;
    const parsed = JSON.parse(raw) as Partial<Selection>;
    return {
      ...EMPTY_SELECTION,
      ...parsed,
      featureIds: Array.isArray(parsed.featureIds) ? parsed.featureIds : [],
    };
  } catch {
    // A corrupt or unreadable value should reset the workflow, not break it.
    return EMPTY_SELECTION;
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'unknown' });
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [browser, setBrowser] = useState<BrowserAvailability>({ available: false, defaultOn: false });
  const [hydrated, setHydrated] = useState(false);

  // Restore after mount so the server and client render the same initial markup.
  useEffect(() => {
    setSelection(loadSelection());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
    } catch {
      // Private browsing can refuse storage; the workflow still works in-memory.
    }
  }, [selection, hydrated]);

  const refreshConnection = useCallback(async () => {
    try {
      const response = await fetch('/api/connect', { method: 'GET' });
      const data = (await response.json()) as {
        connected: boolean;
        sourceReachable?: boolean;
        scan: {
          id: string;
          mapInterfaceDetected: boolean;
          geographicLayersDetected: boolean;
          endpoints: Array<{ nature: string }>;
          notes: string[];
          warnings: string[];
          diagnostics?: { advice?: string[]; mode?: string };
        } | null;
        browser?: BrowserAvailability;
        storage?: { kind: string; durable: boolean };
      };

      if (data.browser) setBrowser(data.browser);

      if (data.connected && data.scan) {
        setConnection({
          status: 'connected',
          scanId: data.scan.id,
          sourceReachable: data.sourceReachable !== false,
          mapInterfaceDetected: data.scan.mapInterfaceDetected,
          geographicLayersDetected: data.scan.geographicLayersDetected,
          endpointCount: data.scan.endpoints.length,
          vectorEndpointCount: data.scan.endpoints.filter((endpoint) => endpoint.nature === 'vector').length,
          rasterEndpointCount: data.scan.endpoints.filter((endpoint) => endpoint.nature === 'raster').length,
          storage: data.storage ?? { kind: 'unknown', durable: false },
          notes: data.scan.notes,
          warnings: data.scan.warnings,
          advice: data.scan.diagnostics?.advice ?? [],
          browserUsed: data.scan.diagnostics?.mode === 'browser',
        });
      }
    } catch {
      // A failed status check is not a failed connection; leave the state alone.
    }
  }, []);

  useEffect(() => {
    void refreshConnection();
  }, [refreshConnection]);

  const connect = useCallback(async (options: ConnectOptions = {}) => {
    setConnection({ status: 'connecting' });
    try {
      const response = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(options.useBrowser === undefined ? {} : { useBrowser: options.useBrowser }),
          ...(options.extraUrls?.length ? { extraUrls: options.extraUrls } : {}),
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        setConnection({
          status: 'failed',
          error: String(data.error ?? 'Unable to connect to TownPlanMap.'),
          detail: data.detail ? String(data.detail) : undefined,
        });
        return;
      }

      setConnection({
        status: 'connected',
        scanId: String(data.scanId),
        sourceReachable: data.sourceReachable !== false,
        mapInterfaceDetected: Boolean(data.mapInterfaceDetected),
        geographicLayersDetected: Boolean(data.geographicLayersDetected),
        endpointCount: Number(data.endpointCount ?? 0),
        vectorEndpointCount: Number(data.vectorEndpointCount ?? 0),
        rasterEndpointCount: Number(data.rasterEndpointCount ?? 0),
        storage: (data.storage as { kind: string; durable: boolean }) ?? { kind: 'unknown', durable: false },
        notes: Array.isArray(data.notes) ? (data.notes as string[]) : [],
        warnings: Array.isArray(data.warnings) ? (data.warnings as string[]) : [],
        advice: Array.isArray((data.diagnostics as { advice?: unknown })?.advice)
          ? ((data.diagnostics as { advice: string[] }).advice)
          : [],
        browserUsed: (data.diagnostics as { mode?: string } | null)?.mode === 'browser',
      });
    } catch (error) {
      setConnection({
        status: 'failed',
        error: 'Unable to connect to TownPlanMap.',
        detail:
          error instanceof Error
            ? error.message
            : 'Please check the website availability or try again later.',
      });
    }
  }, []);

  // Choosing a city invalidates everything downstream of it, and so on down the
  // chain; leaving a stale layer selected under a new city would be a lie.
  const selectCity = useCallback((city: LocationRecord | null) => {
    setSelection({
      ...EMPTY_SELECTION,
      cityId: city?.id ?? null,
      cityName: city?.name ?? null,
    });
  }, []);

  const selectArea = useCallback((area: LocationRecord | null) => {
    setSelection((current) => ({
      ...current,
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
      layerId: null,
      layerName: null,
      featureIds: [],
    }));
  }, []);

  const selectLayer = useCallback((layer: Pick<LayerRecord, 'id' | 'name'> | null) => {
    setSelection((current) => ({
      ...current,
      layerId: layer?.id ?? null,
      layerName: layer?.name ?? null,
      featureIds: [],
    }));
  }, []);

  const toggleFeature = useCallback((featureId: string) => {
    setSelection((current) => ({
      ...current,
      featureIds: current.featureIds.includes(featureId)
        ? current.featureIds.filter((id) => id !== featureId)
        : [...current.featureIds, featureId],
    }));
  }, []);

  const setFeatureSelection = useCallback((featureIds: string[]) => {
    setSelection((current) => ({ ...current, featureIds }));
  }, []);

  const clearFeatureSelection = useCallback(() => {
    setSelection((current) => ({ ...current, featureIds: [] }));
  }, []);

  const value = useMemo<AppState>(
    () => ({
      connection,
      selection,
      browser,
      connect,
      refreshConnection,
      selectCity,
      selectArea,
      selectLayer,
      toggleFeature,
      setFeatureSelection,
      clearFeatureSelection,
    }),
    [
      connection,
      selection,
      browser,
      connect,
      refreshConnection,
      selectCity,
      selectArea,
      selectLayer,
      toggleFeature,
      setFeatureSelection,
      clearFeatureSelection,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const context = useContext(AppStateContext);
  if (!context) throw new Error('useAppState must be used inside an AppStateProvider.');
  return context;
}
