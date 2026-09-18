'use client';

/**
 * Layer discovery: what the source exposes, grouped by planning category, with
 * an honest statement of whether each one carries geometry or only imagery.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppState } from '@/components/app-state';
import { AvailabilityBadge, Empty, KmlBadge, Notice, Panel, Row, Spinner } from '@/components/ui';
import { CATEGORY_LABELS } from '@/lib/discovery/providers/base';
import type { LayerRecord } from '@/lib/discovery/types';

const CATEGORY_ORDER: LayerRecord['category'][] = [
  'tp-scheme',
  'development-plan',
  'village-boundary',
  'land-parcel',
  'other',
];

export default function LayersPage() {
  const router = useRouter();
  const { connection, selection, selectLayer } = useAppState();

  const [layers, setLayers] = useState<LayerRecord[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [rasterOnly, setRasterOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      try {
        const target = selection.areaId ?? 'all';
        const response = await fetch(
          `/api/areas/${encodeURIComponent(target)}/layers${refresh ? '?refresh=1' : ''}`,
        );
        const data = (await response.json()) as {
          layers?: LayerRecord[];
          notes?: string[];
          rasterOnly?: boolean;
        };
        setLayers(data.layers ?? []);
        setNotes(data.notes ?? []);
        setRasterOnly(Boolean(data.rasterOnly));
      } catch {
        setLayers([]);
        setNotes(['The layer list could not be loaded.']);
      } finally {
        setLoading(false);
      }
    },
    [selection.areaId],
  );

  useEffect(() => {
    if (connection.status !== 'connected') {
      setLoading(false);
      return;
    }
    void load(false);
  }, [connection.status, load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return layers;
    return layers.filter(
      (layer) =>
        layer.name.toLowerCase().includes(needle) ||
        (layer.description ?? '').toLowerCase().includes(needle) ||
        layer.serviceUrl.toLowerCase().includes(needle),
    );
  }, [layers, query]);

  const grouped = useMemo(() => {
    const map = new Map<LayerRecord['category'], LayerRecord[]>();
    for (const layer of filtered) {
      const list = map.get(layer.category) ?? [];
      list.push(layer);
      map.set(layer.category, list);
    }
    return map;
  }, [filtered]);

  const vectorCount = layers.filter((layer) => layer.availability.status === 'vector').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Available map layers</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            {selection.areaName
              ? `Layers discovered for ${selection.areaName}.`
              : selection.cityName
                ? `Layers discovered for ${selection.cityName}.`
                : 'Every layer discovered behind the source.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            className="field max-w-xs"
            placeholder="Search layers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search layers"
          />
          <button type="button" className="btn btn-secondary" onClick={() => void load(true)} disabled={loading}>
            Re-discover
          </button>
        </div>
      </header>

      {connection.status !== 'connected' && (
        <Notice tone="warn">Not connected. Run a discovery scan from the Dashboard first.</Notice>
      )}

      {rasterOnly && (
        <Notice tone="warn" title="Map image detected.">
          Underlying vector geometry was not found. KML export cannot be generated reliably from imagery, so no export
          is offered for these layers. You can still open the source map directly.
        </Notice>
      )}

      {notes.map((note) => (
        <Notice key={note} tone="info">
          {note}
        </Notice>
      ))}

      {loading ? (
        <Panel>
          <Spinner label="Enumerating layers from the discovered services…" />
        </Panel>
      ) : layers.length === 0 ? (
        <Panel>
          <Empty title="No layers discovered">
            No service behind the source reported a layer this tool could read. If the map loads its data only after a
            user interaction, a server-side scan will not see it.
          </Empty>
        </Panel>
      ) : (
        <>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {layers.length.toLocaleString()} layer{layers.length === 1 ? '' : 's'} discovered,{' '}
            <span className="text-[var(--color-good)]">{vectorCount.toLocaleString()}</span> with vector geometry.
          </p>

          <div className="space-y-6">
            {CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
              <section key={category}>
                <h2 className="label mb-3">{CATEGORY_LABELS[category]}</h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {(grouped.get(category) ?? []).map((layer) => (
                    <LayerCard
                      key={layer.id}
                      layer={layer}
                      expanded={expanded === layer.id}
                      onToggleDetail={() => setExpanded(expanded === layer.id ? null : layer.id)}
                      onExplore={() => {
                        selectLayer(layer);
                        router.push('/features');
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LayerCard({
  layer,
  expanded,
  onToggleDetail,
  onExplore,
}: {
  layer: LayerRecord;
  expanded: boolean;
  onToggleDetail: () => void;
  onExplore: () => void;
}) {
  const explorable = layer.availability.status === 'vector';

  return (
    <article className="panel flex flex-col gap-3 p-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">{layer.name}</h3>
        {layer.description && (
          <p className="mt-1 line-clamp-2 text-xs text-[var(--color-ink-muted)]">{layer.description}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <AvailabilityBadge availability={layer.availability} />
        <KmlBadge available={layer.kmlExportable} note={layer.kmlNote} />
      </div>

      <dl className="text-xs">
        <Row label="Source type" value={layer.endpointKind} mono />
        <Row
          label="Coordinate system"
          value={layer.crs.code ?? 'Unknown'}
          mono
        />
        <Row
          label="Features"
          value={layer.featureCount === null ? 'Not reported' : layer.featureCount.toLocaleString()}
        />
      </dl>

      {expanded && (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-xs">
          <p className="text-[var(--color-ink-muted)]">{layer.availability.note}</p>
          <p className="text-[var(--color-ink-muted)]">{layer.crs.note}</p>
          <p className="text-[var(--color-ink-muted)]">{layer.kmlNote}</p>
          {layer.attribution && (
            <p className="text-[var(--color-ink-subtle)]">Attribution: {layer.attribution}</p>
          )}
          <p className="mono break-all text-[var(--color-ink-subtle)]">{layer.serviceUrl}</p>
          {layer.fields.length > 0 && (
            <p className="text-[var(--color-ink-subtle)]">
              Attributes: {layer.fields.slice(0, 12).map((field) => field.name).join(', ')}
              {layer.fields.length > 12 ? ` and ${layer.fields.length - 12} more` : ''}
            </p>
          )}
        </div>
      )}

      <div className="mt-auto flex gap-2 pt-1">
        <button type="button" className="btn btn-primary flex-1" onClick={onExplore} disabled={!explorable}>
          Explore
        </button>
        <button type="button" className="btn btn-ghost" onClick={onToggleDetail}>
          {expanded ? 'Less' : 'Details'}
        </button>
      </div>
    </article>
  );
}
