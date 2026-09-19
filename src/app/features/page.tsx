'use client';

/**
 * The feature explorer.
 *
 * The working screen of the product: the discovered features on an interactive
 * map, a searchable list with multi-select, the geometry inspector, and a
 * GIS-style attribute table whose columns are generated from whatever the
 * source actually provides.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppState } from '@/components/app-state';
import { MapView, type MapFeature } from '@/components/map-view';
import { Empty, KmlBadge, Notice, Panel, ProvenanceBadge, Row, Spinner } from '@/components/ui';
import type { FeatureRecord, LayerField, LayerRecord } from '@/lib/discovery/types';
import type { BoundingBox, Geometry } from '@/lib/geo/types';

type FeatureResponse = {
  layer: Pick<
    LayerRecord,
    'id' | 'name' | 'category' | 'fields' | 'availability' | 'crs' | 'kmlExportable' | 'kmlNote' | 'bbox' | 'attribution'
  >;
  features: FeatureRecord[];
  nextCursor: string | null;
  total: number | null;
  notes: string[];
  truncated: boolean;
};

type GeometryResponse = {
  feature: FeatureRecord;
  geometry: Geometry | null;
  inspector: Record<string, unknown>;
  areaLabel: string | null;
  kmlAvailable: boolean;
  kmlNote: string;
};

export default function FeaturesPage() {
  const router = useRouter();
  const { selection, toggleFeature, setFeatureSelection, clearFeatureSelection } = useAppState();

  const [data, setData] = useState<FeatureResponse | null>(null);
  const [features, setFeatures] = useState<FeatureRecord[]>([]);
  const [geometries, setGeometries] = useState<Map<string, Geometry>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GeometryResponse | null>(null);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [viewport, setViewport] = useState<BoundingBox | null>(null);

  const layerId = selection.layerId;

  // --- load a page of features -------------------------------------------
  const loadFeatures = useCallback(
    async (options: { cursor?: string | null; search?: string } = {}) => {
      if (!layerId) return;
      const isFirstPage = !options.cursor;
      if (isFirstPage) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const params = new URLSearchParams({ limit: '200', geometry: '1' });
        if (options.cursor) params.set('cursor', options.cursor);
        if (options.search) params.set('search', options.search);

        const response = await fetch(`/api/layers/${encodeURIComponent(layerId)}/features?${params}`);
        const payload = (await response.json()) as FeatureResponse & { error?: string; detail?: string };

        if (!response.ok) {
          setError(payload.detail ?? payload.error ?? 'The features could not be read.');
          return;
        }

        setData(payload);
        setFeatures((current) => (isFirstPage ? payload.features : [...current, ...payload.features]));

        // Cache whatever geometry came back with the list so the map can draw
        // without a second round trip per feature.
        setGeometries((current) => {
          const next = isFirstPage ? new Map<string, Geometry>() : new Map(current);
          for (const feature of payload.features) {
            if (feature.geometry) next.set(feature.id, feature.geometry);
          }
          return next;
        });

        if (isFirstPage) setFitKey((value) => value + 1);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'The features could not be read.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [layerId],
  );

  useEffect(() => {
    if (!layerId) return;
    setFeatures([]);
    setGeometries(new Map());
    setActiveId(null);
    setDetail(null);
    void loadFeatures({ search: submittedSearch });
  }, [layerId, submittedSearch, loadFeatures]);

  // --- load one feature's geometry and inspector detail -------------------
  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/features/${encodeURIComponent(activeId)}/geometry`)
      .then((response) => response.json())
      .then((payload: GeometryResponse) => {
        if (cancelled) return;
        setDetail(payload);
        if (payload.geometry) {
          setGeometries((current) => new Map(current).set(activeId, payload.geometry as Geometry));
        }
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const mapFeatures = useMemo<MapFeature[]>(() => {
    const out: MapFeature[] = [];
    for (const feature of features) {
      const geometry = geometries.get(feature.id) ?? feature.geometry;
      if (!geometry) continue;
      out.push({ id: feature.id, name: feature.name, geometry, properties: feature.properties });
    }
    return out;
  }, [features, geometries]);

  const columns = useMemo(() => buildColumns(data?.layer.fields ?? [], features), [data, features]);

  // Memoised: a fresh array each render would give the map a new prop identity
  // every time and make it recompute its whole source on every keystroke.
  const highlightedIds = useMemo(
    () => (activeId ? [activeId, ...selection.featureIds] : selection.featureIds),
    [activeId, selection.featureIds],
  );

  if (!layerId) {
    return (
      <Panel>
        <Empty title="No layer selected">
          Choose a layer from{' '}
          <button type="button" className="underline" onClick={() => router.push('/layers')}>
            Map Layers
          </button>{' '}
          to explore its features.
        </Empty>
      </Panel>
    );
  }

  const selectedCount = selection.featureIds.length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{data?.layer.name ?? selection.layerName}</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            {features.length.toLocaleString()} feature{features.length === 1 ? '' : 's'} loaded
            {data?.total !== null && data?.total !== undefined ? ` of ${data.total.toLocaleString()}` : ''}
            {selectedCount > 0 ? ` · ${selectedCount.toLocaleString()} selected` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmittedSearch(search.trim());
            }}
            className="flex gap-2"
          >
            <input
              type="search"
              className="field w-64"
              placeholder="Search name, survey no., plot, ID…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search features"
            />
            <button type="submit" className="btn btn-secondary">
              Search
            </button>
          </form>

          <button
            type="button"
            className="btn btn-ghost"
            title="Select every loaded feature matching the current search"
            disabled={!submittedSearch || features.length === 0}
            onClick={() => {
              const needle = submittedSearch.toLowerCase();
              setFeatureSelection(
                features
                  .filter(
                    (feature) =>
                      feature.name.toLowerCase().includes(needle) ||
                      Object.values(feature.properties).some(
                        (value) => value !== null && String(value).toLowerCase().includes(needle),
                      ),
                  )
                  .map((feature) => feature.id),
              );
            }}
          >
            Select by attribute
          </button>

          <button type="button" className="btn btn-ghost" onClick={() => setShowTable((value) => !value)}>
            {showTable ? 'Hide table' : 'Attribute table'}
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={selectedCount === 0 && !data?.layer.kmlExportable}
            onClick={() => router.push('/export')}
          >
            KML export {'→'}
          </button>
        </div>
      </header>

      {error && <Notice tone="bad" title="Could not read features">{error}</Notice>}
      {data?.notes.map((note) => (
        <Notice key={note} tone="info">
          {note}
        </Notice>
      ))}
      {data?.truncated && (
        <Notice tone="warn">
          The service reported that it returned fewer features than match. Load more pages to read the rest.
        </Notice>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,340px)]">
        {/* --- feature list --- */}
        <Panel
          title="Features"
          action={
            <div className="flex gap-1">
              <button
                type="button"
                className="btn btn-ghost px-2 py-1 text-xs"
                onClick={() => setFeatureSelection(features.map((feature) => feature.id))}
                disabled={features.length === 0}
              >
                All
              </button>
              <button
                type="button"
                className="btn btn-ghost px-2 py-1 text-xs"
                onClick={clearFeatureSelection}
                disabled={selectedCount === 0}
              >
                None
              </button>
            </div>
          }
        >
          {loading ? (
            <Spinner label="Reading features from the source…" />
          ) : features.length === 0 ? (
            <Empty title="No features">
              {submittedSearch
                ? 'No feature matched that search. Only attributes the source actually exposes can be searched.'
                : 'This layer returned no features.'}
            </Empty>
          ) : (
            <div className="space-y-2">
              <ul className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
                {features.map((feature) => {
                  const checked = selection.featureIds.includes(feature.id);
                  const isActive = activeId === feature.id;
                  return (
                    <li key={feature.id}>
                      <div
                        className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                          isActive
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFeature(feature.id)}
                          className="mt-1 accent-[var(--color-accent)]"
                          aria-label={`Select ${feature.name}`}
                        />
                        <button
                          type="button"
                          onClick={() => setActiveId(feature.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm text-[var(--color-ink)]">{feature.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-ink-subtle)]">
                            {feature.sourceFeatureId && <span className="mono">#{feature.sourceFeatureId}</span>}
                            {feature.geometryType && <span>{feature.geometryType}</span>}
                          </span>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {data?.nextCursor && (
                <button
                  type="button"
                  className="btn btn-secondary w-full"
                  disabled={loadingMore}
                  onClick={() => void loadFeatures({ cursor: data.nextCursor, search: submittedSearch })}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}
        </Panel>

        {/* --- map --- */}
        <div className="min-h-[52vh]">
          <MapView
            features={mapFeatures}
            selectedIds={highlightedIds}
            onSelect={(id) => setActiveId(id)}
            onSelectMany={(ids, mode) =>
              setFeatureSelection(
                mode === 'add' ? [...new Set([...selection.featureIds, ...ids])] : ids,
              )
            }
            onBoundsChange={setViewport}
            fitKey={fitKey}
            height="100%"
            tools
          />
        </div>

        {/* --- inspector --- */}
        <div className="space-y-4">
          <Panel title="Selected feature">
            {!activeId ? (
              <Empty title="No feature selected">Click a feature on the map or in the list.</Empty>
            ) : !detail ? (
              <Spinner label="Reading geometry…" />
            ) : (
              <FeatureDetail detail={detail} />
            )}
          </Panel>

          {detail?.feature.geometry && <GeometryInspector detail={detail} />}
        </div>
      </div>

      {showTable && (
        <Panel title="Attribute table">
          {features.length === 0 ? (
            <Empty title="Nothing to show" />
          ) : (
            <AttributeTable
              features={features}
              columns={columns}
              selectedIds={selection.featureIds}
              activeId={activeId}
              onToggle={toggleFeature}
              onActivate={setActiveId}
            />
          )}
        </Panel>
      )}
    </div>
  );
}

function FeatureDetail({ detail }: { detail: GeometryResponse }) {
  const { feature } = detail;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportOne = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch('/api/export/kml', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: { type: 'features', layerId: feature.layerId, featureIds: [feature.id] },
          format: 'kml',
          name: feature.name,
        }),
      });
      const payload = (await response.json()) as { exportId?: string; error?: string; detail?: string };
      if (!response.ok || !payload.exportId) {
        setExportError(payload.detail ?? payload.error ?? 'The export could not be started.');
        return;
      }
      await pollAndDownload(payload.exportId, setExportError);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{feature.name}</h3>
        <p className="mono mt-0.5 text-xs text-[var(--color-ink-subtle)]">{feature.id}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <ProvenanceBadge provenance={feature.provenance} />
        <KmlBadge available={detail.kmlAvailable} note={detail.kmlNote} />
      </div>

      <dl>
        <Row label="Geometry" value={feature.geometryType ?? 'Not available'} />
        <Row label="Area" value={detail.areaLabel ?? 'Not applicable'} />
        <Row label="Source ID" value={feature.sourceFeatureId ?? 'Not exposed'} mono />
        <Row label="Coordinate system" value={feature.crs.code ?? 'Unknown'} mono />
      </dl>

      {!detail.kmlAvailable && <Notice tone="warn">{detail.kmlNote}</Notice>}
      <p className="text-xs text-[var(--color-ink-subtle)]">{feature.provenanceNote}</p>

      <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3">
        <summary className="cursor-pointer text-xs font-medium text-[var(--color-ink-muted)]">
          View attributes ({Object.keys(feature.properties).length})
        </summary>
        <dl className="mt-2 max-h-56 overflow-y-auto">
          {Object.entries(feature.properties)
            .filter(([, value]) => value !== null && value !== '')
            .map(([key, value]) => (
              <Row key={key} label={key} value={String(value)} />
            ))}
        </dl>
      </details>

      {exportError && <Notice tone="bad">{exportError}</Notice>}

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={!detail.kmlAvailable || exporting}
        onClick={() => void exportOne()}
      >
        {exporting ? 'Generating…' : 'Export KML'}
      </button>
    </div>
  );
}

function GeometryInspector({ detail }: { detail: GeometryResponse }) {
  const inspector = detail.inspector as Record<string, string | number | boolean | null>;

  return (
    <Panel title="Geometry">
      <dl>
        <Row label="Type" value={String(inspector.type ?? 'Unknown')} />
        <Row label="Coordinates" value={String(inspector.coordinates ?? 'Not available')} />
        <Row label="Vertices" value={Number(inspector.vertices ?? 0).toLocaleString()} mono />
        <Row label="Rings" value={Number(inspector.rings ?? 0).toLocaleString()} mono />
        <Row label="Outer boundary" value={String(inspector.outerBoundary ?? 'Not applicable')} />
        <Row label="Inner boundaries" value={Number(inspector.innerBoundaries ?? 0).toLocaleString()} mono />
        <Row label="Parts" value={Number(inspector.parts ?? 1).toLocaleString()} mono />
        <Row label="Elevation" value={inspector.hasElevation ? 'Present' : 'Not present'} />
        <Row label="CRS" value={String(inspector.crs ?? 'Unknown')} mono />
        <Row
          label="CRS confidence"
          value={
            inspector.crsConfidence === 'declared'
              ? 'Declared by the source'
              : inspector.crsConfidence === 'assumed-by-spec'
                ? 'Fixed by the format specification'
                : 'Unknown'
          }
        />
        {inspector.transformed ? <Row label="Transformation" value="Applied, to WGS84" /> : null}
      </dl>
      {typeof inspector.crsNote === 'string' && (
        <p className="mt-2 text-xs text-[var(--color-ink-subtle)]">{inspector.crsNote}</p>
      )}
    </Panel>
  );
}

/**
 * Build the attribute table's columns.
 *
 * Columns come from the service's own field list where it published one, plus
 * any attribute key that actually appears on a loaded feature. Nothing is
 * invented: a column exists only because the source produced it.
 */
function buildColumns(fields: LayerField[], features: FeatureRecord[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const field of fields) {
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    columns.push(field.name);
  }

  for (const feature of features.slice(0, 400)) {
    for (const key of Object.keys(feature.properties)) {
      if (key.startsWith('_') || seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }

  return columns.slice(0, 40);
}

function AttributeTable({
  features,
  columns,
  selectedIds,
  activeId,
  onToggle,
  onActivate,
}: {
  features: FeatureRecord[];
  columns: string[];
  selectedIds: string[];
  activeId: string | null;
  onToggle: (id: string) => void;
  onActivate: (id: string) => void;
}) {
  const selected = new Set(selectedIds);

  return (
    <div className="max-h-[50vh] overflow-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-[var(--color-surface-raised)]">
          <tr>
            <th scope="col" className="w-10 px-2 py-2" />
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-ink-muted)]">
              Feature
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-[var(--color-ink-muted)]"
              >
                {column}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-ink-muted)]">
              Geometry
            </th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-ink-muted)]">
              KML
            </th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <tr
              key={feature.id}
              className={`border-t border-[var(--color-border)] transition-colors ${
                activeId === feature.id ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-raised)]'
              }`}
            >
              <td className="px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(feature.id)}
                  onChange={() => onToggle(feature.id)}
                  className="accent-[var(--color-accent)]"
                  aria-label={`Select ${feature.name}`}
                />
              </td>
              <td className="px-3 py-1.5">
                <button type="button" className="text-left hover:underline" onClick={() => onActivate(feature.id)}>
                  {feature.name}
                </button>
              </td>
              {columns.map((column) => {
                const value = feature.properties[column];
                return (
                  <td key={column} className="whitespace-nowrap px-3 py-1.5 text-[var(--color-ink-muted)]">
                    {value === null || value === undefined || value === '' ? (
                      <span className="text-[var(--color-ink-subtle)]">—</span>
                    ) : (
                      String(value)
                    )}
                  </td>
                );
              })}
              <td className="whitespace-nowrap px-3 py-1.5 text-[var(--color-ink-muted)]">
                {feature.geometryType ?? '—'}
              </td>
              <td className="px-3 py-1.5">
                {feature.kmlAvailable ? (
                  <span className="text-[var(--color-good)]" title={feature.kmlNote}>
                    {'✓'}
                  </span>
                ) : (
                  <span className="text-[var(--color-bad)]" title={feature.kmlNote}>
                    {'✕'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Poll an export to completion, then trigger the browser download. */
async function pollAndDownload(exportId: string, onError: (message: string) => void): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`/api/export/${encodeURIComponent(exportId)}/status`);
    const payload = (await response.json()) as {
      status: string;
      downloadUrl: string | null;
      error: string | null;
      validation: { valid: boolean } | null;
    };

    if (payload.status === 'complete' && payload.downloadUrl) {
      if (payload.validation && !payload.validation.valid) {
        onError('The generated document did not pass validation, so it was not downloaded. See Export History.');
        return;
      }
      window.location.href = payload.downloadUrl;
      return;
    }
    if (payload.status === 'failed') {
      onError(payload.error ?? 'The export failed.');
      return;
    }
    if (payload.status === 'cancelled') {
      onError('The export was cancelled.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  onError('The export is taking longer than expected. Check Export History.');
}
