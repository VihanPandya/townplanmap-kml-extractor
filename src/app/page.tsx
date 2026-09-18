'use client';

/**
 * Dashboard — the connection screen and the top of the workflow.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAppState } from '@/components/app-state';
import { Empty, Notice, Panel, Spinner } from '@/components/ui';
import type { LocationRecord } from '@/lib/discovery/types';

export default function DashboardPage() {
  const router = useRouter();
  const { connection, connect, selection, selectCity, selectArea } = useAppState();

  const [cities, setCities] = useState<LocationRecord[]>([]);
  const [areas, setAreas] = useState<LocationRecord[]>([]);
  const [areaNote, setAreaNote] = useState<string | null>(null);
  const [loadingCities, setLoadingCities] = useState(false);
  const [loadingAreas, setLoadingAreas] = useState(false);

  useEffect(() => {
    if (connection.status !== 'connected') return;
    let cancelled = false;
    setLoadingCities(true);
    fetch('/api/cities')
      .then((response) => response.json())
      .then((data: { cities?: LocationRecord[] }) => {
        if (!cancelled) setCities(data.cities ?? []);
      })
      .catch(() => {
        if (!cancelled) setCities([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status]);

  useEffect(() => {
    if (!selection.cityId) {
      setAreas([]);
      setAreaNote(null);
      return;
    }
    let cancelled = false;
    setLoadingAreas(true);
    fetch(`/api/cities/${encodeURIComponent(selection.cityId)}/areas`)
      .then((response) => response.json())
      .then((data: { areas?: LocationRecord[]; note?: string }) => {
        if (cancelled) return;
        setAreas(data.areas ?? []);
        setAreaNote(data.note ?? null);
      })
      .catch(() => {
        if (!cancelled) setAreas([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingAreas(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.cityId]);

  const connected = connection.status === 'connected';

  return (
    <div className="space-y-6">
      <header className="max-w-3xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">TownPlanMap KML Extractor</h1>
        <p className="text-[var(--color-ink-muted)]">
          Extract publicly accessible geographic map data and export it as KML.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ConnectionPanel />

        <Panel title="Explore geographic data">
          {!connected ? (
            <Empty title="Connect first">
              The city list is read from the source during a discovery scan. Nothing here is hard-coded, so it stays
              empty until a scan has run.
            </Empty>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="city" className="label mb-1.5 block">
                  Select city
                </label>
                {loadingCities ? (
                  <Spinner label="Reading the city list from the source…" />
                ) : cities.length === 0 ? (
                  <Notice tone="warn">
                    No city list was found. The source may not expose one in a form this tool can read, or the map may
                    populate it only after a user interaction that a server-side read cannot reproduce. You can still
                    browse every discovered layer from{' '}
                    <Link href="/layers" className="underline">
                      Map Layers
                    </Link>
                    .
                  </Notice>
                ) : (
                  <select
                    id="city"
                    className="field"
                    value={selection.cityId ?? ''}
                    onChange={(event) => {
                      const city = cities.find((entry) => entry.id === event.target.value) ?? null;
                      selectCity(city);
                    }}
                  >
                    <option value="">Choose a city…</option>
                    {cities.map((city) => (
                      <option key={city.id} value={city.id}>
                        {city.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label htmlFor="area" className="label mb-1.5 block">
                  Select area
                </label>
                <select
                  id="area"
                  className="field"
                  disabled={!selection.cityId || loadingAreas}
                  value={selection.areaId ?? ''}
                  onChange={(event) => {
                    if (event.target.value === '') {
                      selectArea(null);
                      return;
                    }
                    const area = areas.find((entry) => entry.id === event.target.value) ?? null;
                    selectArea(area);
                  }}
                >
                  <option value="">
                    {loadingAreas ? 'Reading areas…' : areas.length === 0 ? 'All areas' : 'All areas'}
                  </option>
                  {areas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
                {areaNote && <p className="mt-1.5 text-xs text-[var(--color-ink-subtle)]">{areaNote}</p>}
              </div>

              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={!connected}
                onClick={() => router.push('/layers')}
              >
                Explore geographic data
              </button>

              <p className="text-xs text-[var(--color-ink-subtle)]">
                Cities and areas are discovered from the source itself — from its page markup, its bootstrap data, or
                the attribute values of a boundary layer. Nothing on this screen is a built-in list.
              </p>
            </div>
          )}
        </Panel>
      </div>

      <WorkflowStrip />
    </div>
  );
}

function ConnectionPanel() {
  const { connection, connect } = useAppState();

  return (
    <Panel title="Connection">
      {connection.status === 'connected' ? (
        <div className="space-y-3">
          <ul className="space-y-1.5 text-sm">
            <Check ok={connection.sourceReachable}>
              {connection.sourceReachable
                ? 'TownPlanMap connected'
                : 'TownPlanMap could not be reached \u2014 working from a stand-in dataset'}
            </Check>
            <Check ok={connection.mapInterfaceDetected}>
              {connection.mapInterfaceDetected ? 'Map interface detected' : 'No map interface was detected'}
            </Check>
            <Check ok={connection.geographicLayersDetected}>
              {connection.geographicLayersDetected
                ? 'Geographic layers detected'
                : 'No geographic vector layers were detected'}
            </Check>
          </ul>

          <dl className="grid grid-cols-3 gap-3 border-t border-[var(--color-border)] pt-3">
            <Stat label="Endpoints" value={connection.endpointCount} />
            <Stat label="Vector" value={connection.vectorEndpointCount} tone="good" />
            <Stat label="Raster" value={connection.rasterEndpointCount} tone="warn" />
          </dl>

          {connection.warnings.map((warning) => (
            <Notice key={warning} tone="warn">
              {warning}
            </Notice>
          ))}
          {connection.notes.map((note) => (
            <p key={note} className="text-xs text-[var(--color-ink-subtle)]">
              {note}
            </p>
          ))}

          {!connection.storage.durable && (
            <Notice tone="info" title="Catalog is not persisted">
              No database is configured, so discovered layers and export history are held in memory and lost on
              restart. See Settings.
            </Notice>
          )}

          <button type="button" className="btn btn-secondary w-full" onClick={() => void connect()}>
            Re-scan the source
          </button>
        </div>
      ) : connection.status === 'connecting' ? (
        <div className="space-y-3 py-2">
          <Spinner label="Reading the landing page, its scripts and its data endpoints…" />
          <p className="text-xs text-[var(--color-ink-subtle)]">
            The scan reads the page and its JavaScript as text, harvests candidate data endpoints, then probes the most
            promising ones to see whether they serve real geometry or only imagery.
          </p>
        </div>
      ) : connection.status === 'failed' ? (
        <div className="space-y-3">
          <Notice tone="bad" title="Unable to connect to TownPlanMap.">
            {connection.detail ?? 'Please check the website availability or try again later.'}
          </Notice>
          <p className="text-xs text-[var(--color-ink-subtle)]">
            This tool does not attempt to bypass access controls, authentication, paywalls or anti-bot systems. If the
            source is refusing requests, that refusal is reported as-is.
          </p>
          <button type="button" className="btn btn-primary w-full" onClick={() => void connect()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-ink-muted)]">
            Connect to inspect the publicly accessible map data behind TownPlanMap and find out which layers expose real
            geographic geometry.
          </p>
          <button type="button" className="btn btn-primary w-full" onClick={() => void connect()}>
            Connect to TownPlanMap
          </button>
        </div>
      )}
    </Panel>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={ok ? 'text-[var(--color-good)]' : 'text-[var(--color-warn)]'}
      >
        {ok ? '✓' : '⚠'}
      </span>
      <span className="text-[var(--color-ink)]">{children}</span>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' }) {
  const colour =
    tone === 'good' ? 'text-[var(--color-good)]' : tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-ink)]';
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={`mono text-lg ${colour}`}>{value.toLocaleString()}</dd>
    </div>
  );
}

const STEPS = [
  'Connect',
  'City',
  'Area',
  'Layers',
  'Features',
  'Geometry',
  'KML',
  'Download',
];

function WorkflowStrip() {
  const { connection, selection } = useAppState();

  const reached = [
    connection.status === 'connected',
    Boolean(selection.cityId),
    Boolean(selection.areaId) || Boolean(selection.cityId),
    Boolean(selection.layerId),
    selection.featureIds.length > 0 || Boolean(selection.layerId),
    selection.featureIds.length > 0,
    false,
    false,
  ];

  return (
    <Panel title="Workflow">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`chip ${
                reached[index]
                  ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-subtle)]'
              }`}
            >
              {step}
            </span>
            {index < STEPS.length - 1 && (
              <span aria-hidden className="text-[var(--color-ink-subtle)]">
                {'→'}
              </span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
