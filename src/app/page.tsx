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
  const { connection, selection, selectCity, selectArea } = useAppState();

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
  const { connection, connect, browser } = useAppState();

  // A deep scan is the answer when a plain read finds nothing, so it is on by
  // default whenever this machine has a browser to do it with. Derived rather
  // than stored, so it follows availability until the user decides otherwise.
  const [deepScanChoice, setDeepScanChoice] = useState<boolean | null>(null);
  const deepScan = deepScanChoice ?? browser.available;
  const [headed, setHeaded] = useState(false);
  const [manualUrls, setManualUrls] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const useBrowser = deepScan && browser.available;
  const driveIt = useBrowser && headed;

  const run = () =>
    void connect({
      useBrowser,
      browserHeaded: driveIt,
      extraUrls: manualUrls
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => /^https?:\/\//i.test(entry)),
    });

  // Signing in is the person's own act, in the source's own page. This tool
  // opens the window and reads what the site sends back; it never sees, types
  // or keeps a credential, and it says so where the button is.
  const signIn = () => void connect({ useBrowser: true, browserHeaded: true });

  const actions = (
    <div className="space-y-2">
      {browser.available && (
        <>
          <button type="button" className="btn btn-primary w-full" onClick={signIn}>
            Open TownPlanMap and sign in
          </button>
          <p className="text-xs text-[var(--color-ink-subtle)]">
            A browser window opens at townplanmap.com. Sign in yourself and use the map as you normally would —
            choose your city and area, open a parcel. Every dataset the site sends back is captured as you go.
            Close the window when you are done. Your password is typed into TownPlanMap&rsquo;s own page, never
            into this tool: nothing that signs you in is seen, stored or reused.
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`btn flex-1 ${browser.available ? 'btn-secondary' : 'btn-primary'}`}
          onClick={run}
        >
          {driveIt
            ? 'Open the site and record while I use it'
            : useBrowser
              ? 'Scan without signing in'
              : 'Scan the source'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((current) => !current)}
        >
          {showAdvanced ? 'Hide options' : 'Scan options'}
        </button>
      </div>
    </div>
  );

  const advanced = (
    <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={deepScan && browser.available}
          disabled={!browser.available}
          onChange={(event) => setDeepScanChoice(event.target.checked)}
        />
        <span>
          <span className="text-[var(--color-ink)]">Watch the site in a browser</span>
          <span className="block text-xs text-[var(--color-ink-subtle)]">
            {browser.available
              ? 'Opens the page in a browser on this machine and records the requests the site makes for itself. ' +
                'Most map applications build their data URLs while they run, so this is usually the only way to see ' +
                'them. Slower, and it runs the site’s own code.'
              : 'Unavailable: no Chrome, Chromium or Edge installation was found, or the optional ' +
                'playwright-core package is not installed. Run npm install playwright-core, or set TPM_BROWSER_PATH.'}
          </span>
        </span>
      </label>

      <label className={`flex items-start gap-2 text-sm ${useBrowser ? '' : 'opacity-50'}`}>
        <input
          type="checkbox"
          className="mt-0.5"
          checked={driveIt}
          disabled={!useBrowser}
          onChange={(event) => setHeaded(event.target.checked)}
        />
        <span>
          <span className="text-[var(--color-ink)]">Let me drive it</span>
          <span className="block text-xs text-[var(--color-ink-subtle)]">
            Opens a visible window instead of a hidden one and keeps recording until you close it. Use the map
            normally — choose your city and area, click a parcel — and every request the site makes while you do is
            recorded. This is how to reach data the map only loads in response to being used. Close the window when
            you are done.
          </span>
        </span>
      </label>

      <div>
        <label htmlFor="manual-urls" className="label mb-1.5 block">
          Add an endpoint
        </label>
        <textarea
          id="manual-urls"
          className="field min-h-[72px] font-mono text-xs"
          placeholder="https://example.gov.in/arcgis/rest/services/TP/FeatureServer/0"
          value={manualUrls}
          onChange={(event) => setManualUrls(event.target.value)}
        />
        <p className="mt-1.5 text-xs text-[var(--color-ink-subtle)]">
          Know the data URL already? Paste it here, one per line, and the scan will probe it directly. Open the source
          in your browser, press F12, choose Network, tick Fetch/XHR, reload, and copy any row that returns map data.
        </p>
      </div>
    </div>
  );

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

          <dl className="grid grid-cols-4 gap-3 border-t border-[var(--color-border)] pt-3">
            <Stat label="Endpoints" value={connection.endpointCount} />
            <Stat label="Vector" value={connection.vectorEndpointCount} tone="good" />
            <Stat label="Raster" value={connection.rasterEndpointCount} tone="warn" />
            <Stat label="Captured" value={connection.capturedCount} tone="good" />
          </dl>

          {connection.capturedCount > 0 && (
            <Notice tone="good" title={`${connection.capturedCount} dataset(s) captured from your browser`}>
              {connection.signedInCaptureCount > 0
                ? `${connection.signedInCaptureCount} of them were returned to your signed-in session. They are ` +
                  'held here as the source sent them, and can be read and exported without asking it again. ' +
                  'Nothing that authenticated that session was stored or reused.'
                : 'They are held here exactly as the source sent them, and can be read and exported without ' +
                  'asking it again.'}{' '}
              <Link href="/layers" className="underline">
                Open Map Layers
              </Link>{' '}
              to see what they hold.
            </Notice>
          )}

          {/* When the scan found nothing usable, what to do about it matters
              more than anything else on the screen, so it goes first. */}
          {connection.advice.length > 0 && !connection.geographicLayersDetected && (
            <Notice tone="warn" title="No vector geometry was found. Next steps:">
              <ol className="list-decimal space-y-1.5 pl-4">
                {connection.advice.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <p className="mt-2">
                <Link href="/diagnostics" className="underline">
                  Open Scan Diagnostics
                </Link>{' '}
                to see every document the scan read and every URL it rejected.
              </p>
            </Notice>
          )}

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

          {actions}
          {showAdvanced && advanced}
        </div>
      ) : connection.status === 'connecting' ? (
        <div className="space-y-3 py-2">
          <Spinner
            label={
              driveIt
                ? 'A browser window is open \u2014 sign in, use the map, then close the window\u2026'
                : useBrowser
                  ? 'Opening the site in a browser and recording what it loads\u2026'
                  : 'Reading the landing page, its scripts and its data endpoints\u2026'
            }
          />
          <p className="text-xs text-[var(--color-ink-subtle)]">
            {driveIt
              ? 'Go to the window that just opened and use the site as you normally would \u2014 sign in if you ' +
                'have an account, choose your city and area, and open a parcel. Every dataset it sends back is ' +
                'being captured. Close the window when you are done and the scan will carry on with what it saw.'
              : useBrowser
                ? 'The page is loaded in a browser on this machine so the requests it makes for itself can be ' +
                  'written down. Those URLs are then fetched through the usual guarded path. This takes up to a ' +
                  'minute.'
                : 'The scan reads the page and its JavaScript as text, harvests candidate data endpoints, then ' +
                  'probes the most promising ones to see whether they serve real geometry or only imagery.'}
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
          {actions}
          {showAdvanced && advanced}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-ink-muted)]">
            Connect to inspect the publicly accessible map data behind TownPlanMap and find out which layers expose real
            geographic geometry.
          </p>
          {actions}
          {showAdvanced && advanced}
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
