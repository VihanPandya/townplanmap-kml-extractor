'use client';

/**
 * Export Centre.
 *
 * Choose what to export and in which form, watch the job progress, read the
 * validation report, preview the generated document on the map, then download.
 * Download is deliberately the last step, after validation and preview.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '@/components/app-state';
import { MapView, type MapFeature } from '@/components/map-view';
import { Empty, Notice, Panel, ProgressBar, Row, Spinner } from '@/components/ui';
import { OriginBadge } from '@/components/origin-badge';
import type { LayerRecord } from '@/lib/discovery/types';
import type { ExportProgress } from '@/lib/exports/types';
import type { KmlValidationReport } from '@/lib/kml/validate';
import type { Geometry } from '@/lib/geo/types';

type JobStatus = {
  exportId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';
  label: string;
  format: string;
  progress: ExportProgress;
  featureCount: number;
  skipped: Array<{ featureId: string; reason: string }>;
  skippedCount: number;
  validation: KmlValidationReport | null;
  notes: string[];
  error: string | null;
  artifact: { filename: string; bytes: number; size: string; contentType: string } | null;
  downloadUrl: string | null;
};

type ExportMode = 'selected' | 'layer' | 'location';
type OutputFormat = 'kml' | 'kmz' | 'geojson';

export default function ExportPage() {
  const { selection } = useAppState();

  const [layers, setLayers] = useState<LayerRecord[]>([]);
  const [chosenLayers, setChosenLayers] = useState<string[]>([]);
  const [mode, setMode] = useState<ExportMode>('selected');
  const [format, setFormat] = useState<OutputFormat>('kml');
  const [individualFiles, setIndividualFiles] = useState(false);
  const [name, setName] = useState('');
  const [job, setJob] = useState<JobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ features: MapFeature[]; documentName: string | null } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    fetch(`/api/layers${selection.areaId ? `?locationId=${encodeURIComponent(selection.areaId)}` : ''}`)
      .then((response) => response.json())
      .then((data: { layers?: LayerRecord[] }) => {
        const found = data.layers ?? [];
        setLayers(found);
        if (selection.layerId && found.some((layer) => layer.id === selection.layerId)) {
          setChosenLayers([selection.layerId]);
        }
      })
      .catch(() => setLayers([]));
  }, [selection.areaId, selection.layerId]);

  useEffect(() => {
    // Default to whichever mode the user's current selection supports.
    if (selection.featureIds.length > 0) setMode('selected');
    else if (selection.layerId) setMode('layer');
  }, [selection.featureIds.length, selection.layerId]);

  const exportableLayers = useMemo(
    () => layers.filter((layer) => layer.availability.status === 'vector'),
    [layers],
  );

  const totalFeatures = useMemo(() => {
    if (mode === 'selected') return selection.featureIds.length;
    const chosen = exportableLayers.filter((layer) => chosenLayers.includes(layer.id));
    const counts = chosen.map((layer) => layer.featureCount);
    if (counts.some((count) => count === null)) return null;
    return counts.reduce((sum: number, count) => sum + (count ?? 0), 0);
  }, [mode, selection.featureIds.length, exportableLayers, chosenLayers]);

  // --- poll a running job -------------------------------------------------
  useEffect(() => {
    if (!job || job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') return;
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/export/${encodeURIComponent(job.exportId)}/status`);
        const payload = (await response.json()) as JobStatus;
        if (!cancelled) setJob(payload);
      } catch {
        // Transient failures are fine; the next tick will retry.
      }
    };

    const timer = setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job]);

  const scope = useCallback(() => {
    if (mode === 'selected') {
      if (!selection.layerId || selection.featureIds.length === 0) return null;
      return { type: 'features' as const, layerId: selection.layerId, featureIds: selection.featureIds };
    }
    if (mode === 'layer') {
      const layerId = chosenLayers[0] ?? selection.layerId;
      if (!layerId) return null;
      return { type: 'layer' as const, layerId };
    }
    if (!selection.areaId && !selection.cityId) return null;
    if (chosenLayers.length === 0) return null;
    return {
      type: 'location' as const,
      locationId: (selection.areaId ?? selection.cityId) as string,
      layerIds: chosenLayers,
    };
  }, [mode, selection, chosenLayers]);

  const start = async () => {
    const built = scope();
    if (!built) {
      setError('Choose what to export first.');
      return;
    }

    setStarting(true);
    setError(null);
    setPreview(null);

    try {
      const endpoint = individualFiles
        ? '/api/export/bulk'
        : format === 'kmz'
          ? '/api/export/kmz'
          : format === 'geojson'
            ? '/api/export/geojson'
            : '/api/export/kml';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: built,
          format,
          individualFiles,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });

      const payload = (await response.json()) as { exportId?: string; error?: string; detail?: string };
      if (!response.ok || !payload.exportId) {
        setError(payload.detail ?? payload.error ?? 'The export could not be started.');
        return;
      }

      const status = await fetch(`/api/export/${encodeURIComponent(payload.exportId)}/status`);
      setJob((await status.json()) as JobStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The export could not be started.');
    } finally {
      setStarting(false);
    }
  };

  const loadPreview = async () => {
    if (!job) return;
    setPreviewing(true);
    try {
      const response = await fetch('/api/kml/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exportId: job.exportId }),
      });
      const payload = (await response.json()) as {
        documentName?: string | null;
        featureCollection?: { features: Array<{ geometry: Geometry | null; properties: Record<string, unknown> }> };
        error?: string;
        detail?: string;
      };

      if (!response.ok || !payload.featureCollection) {
        setError(payload.detail ?? payload.error ?? 'The generated document could not be previewed.');
        return;
      }

      setPreview({
        documentName: payload.documentName ?? null,
        features: payload.featureCollection.features
          .filter((feature): feature is { geometry: Geometry; properties: Record<string, unknown> } =>
            feature.geometry !== null,
          )
          .map((feature, index) => ({
            id: `preview_${index}`,
            name: typeof feature.properties.name === 'string' ? feature.properties.name : `Feature ${index + 1}`,
            geometry: feature.geometry,
          })),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The preview failed.');
    } finally {
      setPreviewing(false);
    }
  };

  const running = job?.status === 'queued' || job?.status === 'processing';

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Export Centre</h1>
          <OriginBadge origin="reconstructed" />
        </div>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ink-muted)]">
          Everything generated here is built from geometry read out of the source. It is not a file the source
          published. For the source&rsquo;s own KML and KMZ files, see <strong>Source Files</strong>.
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          {selection.cityName ?? 'No city selected'}
          {selection.areaName ? ` · ${selection.areaName}` : ''}
          {totalFeatures !== null ? ` · ${totalFeatures.toLocaleString()} feature(s)` : ''}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="What to export">
            <div className="space-y-3">
              <fieldset className="space-y-2">
                <legend className="sr-only">Export scope</legend>
                <ModeOption
                  checked={mode === 'selected'}
                  onChange={() => setMode('selected')}
                  disabled={selection.featureIds.length === 0}
                  label="Selected features"
                  detail={
                    selection.featureIds.length > 0
                      ? `${selection.featureIds.length.toLocaleString()} feature(s) selected in the explorer`
                      : 'Select features in the Features screen first'
                  }
                />
                <ModeOption
                  checked={mode === 'layer'}
                  onChange={() => setMode('layer')}
                  disabled={exportableLayers.length === 0}
                  label="Entire layer"
                  detail="Every feature the layer exposes"
                />
                <ModeOption
                  checked={mode === 'location'}
                  onChange={() => setMode('location')}
                  disabled={!selection.cityId || exportableLayers.length === 0}
                  label={selection.areaName ? 'This village / area' : 'This city'}
                  detail="Chosen layers, organised into folders"
                />
              </fieldset>

              {(mode === 'layer' || mode === 'location') && (
                <div className="space-y-1.5">
                  <p className="label">Layers</p>
                  {exportableLayers.length === 0 ? (
                    <Empty title="No exportable layers">
                      No discovered layer exposes vector geometry, so there is nothing to convert to KML.
                    </Empty>
                  ) : (
                    <ul className="max-h-60 space-y-1 overflow-y-auto pr-1">
                      {exportableLayers.map((layer) => (
                        <li key={layer.id}>
                          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-2 hover:border-[var(--color-border-strong)]">
                            <input
                              type={mode === 'layer' ? 'radio' : 'checkbox'}
                              name={mode === 'layer' ? 'layer-choice' : undefined}
                              checked={chosenLayers.includes(layer.id)}
                              onChange={() => {
                                if (mode === 'layer') {
                                  setChosenLayers([layer.id]);
                                } else {
                                  setChosenLayers((current) =>
                                    current.includes(layer.id)
                                      ? current.filter((id) => id !== layer.id)
                                      : [...current, layer.id],
                                  );
                                }
                              }}
                              className="mt-1 accent-[var(--color-accent)]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{layer.name}</span>
                              <span className="text-xs text-[var(--color-ink-subtle)]">
                                {layer.featureCount === null
                                  ? 'Feature count not reported'
                                  : `${layer.featureCount.toLocaleString()} features`}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Output">
            <div className="space-y-3">
              <div>
                <label htmlFor="format" className="label mb-1.5 block">
                  Format
                </label>
                <select
                  id="format"
                  className="field"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as OutputFormat)}
                  disabled={individualFiles}
                >
                  <option value="kml">KML — the primary output</option>
                  <option value="kmz">KMZ — compressed KML</option>
                  <option value="geojson">GeoJSON</option>
                </select>
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={individualFiles}
                  onChange={(event) => setIndividualFiles(event.target.checked)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <span>
                  Export individual KML files
                  <span className="block text-xs text-[var(--color-ink-subtle)]">
                    A ZIP with one file per feature plus a combined document under <code>Reconstructed/</code>,
                    any preserved source files under <code>Original/</code>, and a metadata.json recording the
                    provenance and hashes of both.
                  </span>
                </span>
              </label>

              <div>
                <label htmlFor="name" className="label mb-1.5 block">
                  Document name (optional)
                </label>
                <input
                  id="name"
                  className="field"
                  placeholder={selection.areaName ?? selection.cityName ?? 'TownPlanMap export'}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              {error && <Notice tone="bad">{error}</Notice>}

              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary flex-1"
                  disabled={starting || running}
                  onClick={() => void start()}
                >
                  {starting || running ? 'Working…' : `Export ${individualFiles ? 'bundle' : format.toUpperCase()}`}
                </button>
                {running && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      if (job) void fetch(`/api/export/${encodeURIComponent(job.exportId)}/cancel`, { method: 'POST' });
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          {!job ? (
            <Panel title="Result">
              <Empty title="No export yet">
                Choose a scope and a format, then start the export. The generated document is validated before it can be
                downloaded.
              </Empty>
            </Panel>
          ) : (
            <>
              <JobPanel job={job} onPreview={() => void loadPreview()} previewing={previewing} />
              {preview && (
                <Panel title={`KML preview${preview.documentName ? ` — ${preview.documentName}` : ''}`}>
                  <p className="mb-3 text-xs text-[var(--color-ink-subtle)]">
                    This is the generated document parsed back and drawn on the map — not the in-memory features it was
                    built from — so what you see is what the file contains.
                  </p>
                  <div className="h-[420px]">
                    <MapView features={preview.features} fitKey={preview.features.length} height="100%" />
                  </div>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeOption({
  checked,
  onChange,
  disabled,
  label,
  detail,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  detail: string;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
        disabled
          ? 'cursor-not-allowed border-[var(--color-border)] opacity-50'
          : checked
            ? 'cursor-pointer border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'cursor-pointer border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      <input
        type="radio"
        name="export-mode"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 accent-[var(--color-accent)]"
      />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-[var(--color-ink-subtle)]">{detail}</span>
      </span>
    </label>
  );
}

function JobPanel({
  job,
  onPreview,
  previewing,
}: {
  job: JobStatus;
  onPreview: () => void;
  previewing: boolean;
}) {
  const running = job.status === 'queued' || job.status === 'processing';
  const validationFailed = job.validation ? !job.validation.valid : false;

  return (
    <Panel title={`Export — ${job.label}`}>
      <div className="space-y-4">
        {running && (
          <div className="space-y-3">
            <Spinner label={job.progress.message || 'Preparing…'} />
            <dl className="text-xs">
              <Row
                label="Features processed"
                value={`${job.progress.featuresProcessed.toLocaleString()}${
                  job.progress.featuresTotal !== null ? ` / ${job.progress.featuresTotal.toLocaleString()}` : ''
                }`}
                mono
              />
            </dl>
            <ProgressBar value={job.progress.geometryValidationPercent} label="Geometry validation" />
            <ProgressBar value={job.progress.generationPercent} label="KML generation" />
          </div>
        )}

        {job.status === 'failed' && <Notice tone="bad" title="Export failed">{job.error}</Notice>}
        {job.status === 'cancelled' && <Notice tone="warn">This export was cancelled.</Notice>}

        {job.status === 'complete' && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p className="text-sm text-[var(--color-good)]">{'✓'} Export complete</p>
              {job.artifact && (
                <p className="mono text-sm text-[var(--color-ink-muted)]">
                  {job.artifact.filename} · {job.artifact.size}
                </p>
              )}
            </div>

            {job.validation && <ValidationReport report={job.validation} />}

            {job.skippedCount > 0 && (
              <details className="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] p-3">
                <summary className="cursor-pointer text-sm text-[var(--color-warn)]">
                  {job.skippedCount.toLocaleString()} feature(s) were excluded
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-[var(--color-ink-muted)]">
                  {job.skipped.map((entry) => (
                    <li key={entry.featureId}>
                      <span className="mono">{entry.featureId}</span>: {entry.reason}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-[var(--color-ink-subtle)]">
                  Excluded features had no usable geometry, an unresolvable coordinate system, or geometry that failed
                  validation. Nothing was approximated to keep them in the output.
                </p>
              </details>
            )}

            {job.notes.map((note) => (
              <Notice key={note} tone="info">
                {note}
              </Notice>
            ))}

            {validationFailed && (
              <Notice tone="bad" title="Validation failed">
                The generated document did not pass validation, so it is not offered for download. This is a bug worth
                reporting — the checks above say which one failed.
              </Notice>
            )}

            <div className="flex flex-wrap gap-2">
              {job.format !== 'geojson' && job.format !== 'bundle' && (
                <button type="button" className="btn btn-secondary" onClick={onPreview} disabled={previewing}>
                  {previewing ? 'Loading…' : 'View KML'}
                </button>
              )}
              <a
                className={`btn btn-primary ${validationFailed ? 'pointer-events-none opacity-40' : ''}`}
                href={job.downloadUrl ?? '#'}
                aria-disabled={validationFailed}
              >
                Download
              </a>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

export function ValidationReport({ report }: { report: KmlValidationReport }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3">
      <p className="label">KML validation</p>
      <ul className="space-y-1">
        {report.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2 text-sm">
            <span aria-hidden className={check.passed ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}>
              {check.passed ? '✓' : '✕'}
            </span>
            <span>
              <span className="text-[var(--color-ink)]">{check.label}</span>
              <span className="block text-xs text-[var(--color-ink-subtle)]">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-x-4 border-t border-[var(--color-border)] pt-2 sm:grid-cols-4">
        <Row label="Features" value={report.summary.features.toLocaleString()} mono />
        <Row label="Polygons" value={report.summary.polygons.toLocaleString()} mono />
        <Row label="Lines" value={report.summary.lines.toLocaleString()} mono />
        <Row label="Points" value={report.summary.points.toLocaleString()} mono />
      </dl>
      <p className="text-xs text-[var(--color-ink-subtle)]">
        Coordinate system: {report.summary.coordinateSystem}
      </p>
    </div>
  );
}
