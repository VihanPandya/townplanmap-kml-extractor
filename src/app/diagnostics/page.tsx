'use client';

/**
 * Scan Diagnostics — the evidence behind a scan result.
 *
 * When discovery comes back empty this is the screen that says why: what was
 * fetched and what it answered, what the site itself requested while it ran,
 * every URL that was seen and dropped with the reason it was dropped, and what
 * to do next. Everything here is a fact recorded during the scan; nothing is
 * inferred after the fact.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Empty, Notice, Panel, Row, Spinner } from '@/components/ui';
import type {
  DiscoveredEndpoint,
  ObservedRequest,
  RejectedCandidate,
  ScanDiagnostics,
  ScanDocument,
} from '@/lib/discovery/types';

type Environment = {
  baseUrl: string;
  browserAvailable: boolean;
  browserExecutablePath: string | null;
  browserDefaultOn: boolean;
  browserSettleMs: number;
  maxScriptsRead: number;
  maxProbes: number;
  maxRequestsPerScan: number;
};

type Payload = {
  scan: {
    id: string;
    baseUrl: string;
    startedAt: string;
    finishedAt: string;
    connected: boolean;
    failure: { kind: string; reason: string } | null;
    requestsSpent: number;
    bytesDownloaded: number;
    mapInterfaceDetected: boolean;
    geographicLayersDetected: boolean;
    notes: string[];
    warnings: string[];
    endpoints: DiscoveredEndpoint[];
  } | null;
  diagnostics: ScanDiagnostics | null;
  environment: Environment;
  note?: string;
};

export default function DiagnosticsPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/diagnostics')
      .then((response) => response.json())
      .then((data: Payload) => setPayload(data))
      .catch(() => setPayload(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const copy = useCallback(() => {
    if (!payload) return;
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_500);
      })
      .catch(() => setCopied(false));
  }, [payload]);

  if (loading && !payload) {
    return <Spinner label="Reading the last scan…" />;
  }

  const diagnostics = payload?.diagnostics ?? null;
  const scan = payload?.scan ?? null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Scan Diagnostics</h1>
          <p className="text-[var(--color-ink-muted)]">
            Exactly what the last discovery scan fetched, observed and rejected — so an empty result is evidence you
            can act on rather than a dead end.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost" onClick={load}>
            Refresh
          </button>
          <button type="button" className="btn btn-secondary" disabled={!payload} onClick={copy}>
            {copied ? 'Copied' : 'Copy as JSON'}
          </button>
        </div>
      </header>

      {payload?.note && <Notice tone="info">{payload.note}</Notice>}

      {!scan ? (
        <Empty title="No scan has been run yet">
          Connect to the source from the{' '}
          <Link href="/" className="underline">
            Dashboard
          </Link>{' '}
          and this screen will fill with what the scan saw.
        </Empty>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Result">
              <dl className="space-y-1">
                <Row label="Source" value={scan.baseUrl} mono />
                <Row label="Scan id" value={scan.id} mono />
                <Row label="Started" value={new Date(scan.startedAt).toLocaleString()} />
                <Row
                  label="Duration"
                  value={`${Math.max(
                    0,
                    Math.round((Date.parse(scan.finishedAt) - Date.parse(scan.startedAt)) / 100) / 10,
                  )} s`}
                />
                <Row label="Mode" value={diagnostics?.mode === 'browser' ? 'watched in a browser' : 'text read only'} />
                <Row label="Requests spent" value={`${scan.requestsSpent} of ${payload?.environment.maxRequestsPerScan}`} />
                <Row label="Bytes downloaded" value={scan.bytesDownloaded.toLocaleString()} />
                <Row label="Endpoints found" value={scan.endpoints.length} />
                <Row
                  label="Vector endpoints"
                  value={scan.endpoints.filter((endpoint) => endpoint.nature === 'vector').length}
                />
              </dl>
              {scan.failure && (
                <Notice tone="bad" title={`The source could not be read (${scan.failure.kind})`}>
                  {scan.failure.reason}
                </Notice>
              )}
            </Panel>

            <Panel title="What to do next">
              {diagnostics && diagnostics.advice.length > 0 ? (
                <ol className="list-decimal space-y-2 pl-4 text-sm text-[var(--color-ink-muted)]">
                  {diagnostics.advice.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-[var(--color-ink-muted)]">
                  The scan produced no specific advice, which means it did not hit a known dead end.
                </p>
              )}
            </Panel>
          </div>

          <BrowserPanel diagnostics={diagnostics} environment={payload?.environment} />

          {diagnostics && (
            <>
              <Panel
                title={`Harvest (${diagnostics.candidatesHarvested} candidate${
                  diagnostics.candidatesHarvested === 1 ? '' : 's'
                }, ${diagnostics.candidatesProbed} probed)`}
              >
                <dl className="grid gap-3 sm:grid-cols-4">
                  <Stat label="Scripts linked" value={diagnostics.scriptsSeen} />
                  <Stat label="Scripts read" value={diagnostics.scriptsRead} />
                  <Stat label="Candidates" value={diagnostics.candidatesHarvested} />
                  <Stat label="Probed" value={diagnostics.candidatesProbed} />
                </dl>
                {diagnostics.seeds.length > 0 && (
                  <div className="mt-4">
                    <p className="label mb-1.5">Supplied by hand</p>
                    <ul className="space-y-1">
                      {diagnostics.seeds.map((seed) => (
                        <li key={seed} className="mono break-all text-xs text-[var(--color-ink-muted)]">
                          {seed}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>

              <DocumentTable documents={diagnostics.documents} />
              <RejectedTable rejected={diagnostics.rejected} />
            </>
          )}

          <EndpointTable endpoints={scan.endpoints} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mono text-lg">{value.toLocaleString()}</dd>
    </div>
  );
}

function BrowserPanel({
  diagnostics,
  environment,
}: {
  diagnostics: ScanDiagnostics | null;
  environment?: Environment;
}) {
  const [filter, setFilter] = useState('');
  const browser = diagnostics?.browser ?? null;

  const observed = useMemo(() => {
    const all = browser?.observed ?? [];
    if (!filter.trim()) return all;
    const needle = filter.trim().toLowerCase();
    return all.filter(
      (request) =>
        request.url.toLowerCase().includes(needle) ||
        request.resourceType.toLowerCase().includes(needle) ||
        (request.contentType ?? '').toLowerCase().includes(needle),
    );
  }, [browser, filter]);

  if (!browser) {
    return (
      <Panel title="Browser pass">
        <Notice tone="info" title="This scan did not watch the site in a browser">
          A plain read only sees URLs written literally into the page or its bundles. If the site builds its data URLs
          while it runs — which most map applications do — nothing will be found that way.{' '}
          {environment?.browserAvailable
            ? 'A browser is available on this machine: switch on “Watch the site in a browser” under Scan options and scan again.'
            : 'No browser was found on this machine. Install Google Chrome, Chromium or Microsoft Edge, run ' +
              '`npm install playwright-core`, or set TPM_BROWSER_PATH to an executable.'}
        </Notice>
      </Panel>
    );
  }

  if (!browser.used) {
    return (
      <Panel title="Browser pass">
        <Notice tone="warn" title="A browser pass was requested but could not run">
          <p>{browser.reason}</p>
          {browser.hint && <p className="mt-1.5">{browser.hint}</p>}
        </Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={`Observed requests (${browser.requestsObserved})`}
      action={
        <input
          type="search"
          className="field max-w-xs text-xs"
          placeholder="Filter by URL or type…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      }
    >
      <dl className="mb-4 space-y-1">
        <Row label="Browser" value={browser.executablePath ?? 'unknown'} mono />
        <Row label="Requests recorded" value={browser.requestsObserved} />
        <Row label="Requests blocked by the safety rules" value={browser.requestsBlocked} />
      </dl>

      <p className="mb-3 text-xs text-[var(--color-ink-subtle)]">
        Every row is a request the site made for itself. If the map is drawing real geometry, the URL that serves it is
        in this list. Anything here can be pasted into “Add an endpoint” on the dashboard.
      </p>

      {observed.length === 0 ? (
        <Empty title="Nothing matched that filter" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-ink-subtle)]">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium">Content type</th>
                <th className="py-1.5 font-medium">URL</th>
              </tr>
            </thead>
            <tbody>
              {observed.slice(0, 400).map((request) => (
                <ObservedRow key={`${request.method} ${request.url}`} request={request} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ObservedRow({ request }: { request: ObservedRequest }) {
  const interesting = /json|xml|protobuf|octet-stream/i.test(request.contentType ?? '');
  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-ink-muted)]">
        {request.method === 'GET' ? request.resourceType : `${request.method} ${request.resourceType}`}
      </td>
      <td className="mono py-1.5 pr-3 whitespace-nowrap">
        {request.blockedReason ? (
          <span className="text-[var(--color-bad)]">blocked</span>
        ) : request.failureReason ? (
          <span className="text-[var(--color-warn)]">failed</span>
        ) : (
          (request.status ?? '—')
        )}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-ink-subtle)]">
        {request.contentType?.split(';')[0] ?? '—'}
      </td>
      <td className={`mono py-1.5 break-all ${interesting ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}>
        {request.url}
        {request.blockedReason && (
          <span className="block text-[var(--color-bad)]">
            Stopped by this tool’s safety rules: {request.blockedReason}
          </span>
        )}
        {request.failureReason && (
          <span className="block text-[var(--color-warn)]">
            The request failed on the network: {request.failureReason}
          </span>
        )}
      </td>
    </tr>
  );
}

function DocumentTable({ documents }: { documents: ScanDocument[] }) {
  if (documents.length === 0) {
    return (
      <Panel title="Documents fetched">
        <Empty title="No document was fetched" />
      </Panel>
    );
  }
  return (
    <Panel title={`Documents fetched (${documents.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[var(--color-ink-subtle)]">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Role</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 pr-3 font-medium">Bytes</th>
              <th className="py-1.5 font-medium">URL</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document, index) => (
              <tr key={`${document.role}-${document.url}-${index}`} className="border-t border-[var(--color-border)] align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--color-ink-muted)]">{document.role}</td>
                <td className="mono py-1.5 pr-3 whitespace-nowrap">
                  <span className={document.ok ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}>
                    {document.status ?? (document.ok ? 'ok' : 'failed')}
                  </span>
                </td>
                <td className="mono py-1.5 pr-3 whitespace-nowrap text-[var(--color-ink-subtle)]">
                  {document.bytes?.toLocaleString() ?? '—'}
                </td>
                <td className="mono py-1.5 break-all text-[var(--color-ink-muted)]">
                  {document.url}
                  {document.reason && <span className="block text-[var(--color-bad)]">{document.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function RejectedTable({ rejected }: { rejected: RejectedCandidate[] }) {
  const [expanded, setExpanded] = useState(false);
  if (rejected.length === 0) return null;
  const shown = expanded ? rejected : rejected.slice(0, 25);

  return (
    <Panel
      title={`Rejected URLs (${rejected.length})`}
      action={
        rejected.length > 25 && (
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded((current) => !current)}>
            {expanded ? 'Show fewer' : `Show all ${rejected.length}`}
          </button>
        )
      }
    >
      <p className="mb-3 text-xs text-[var(--color-ink-subtle)]">
        Seen and not pursued, with the reason. If a URL you know serves map data is listed here, paste it into “Add an
        endpoint” on the dashboard — a hand-supplied URL skips every filter below.
      </p>
      <ul className="space-y-2">
        {shown.map((entry) => (
          <li key={entry.url} className="border-t border-[var(--color-border)] pt-2 text-xs first:border-0 first:pt-0">
            <p className="mono break-all text-[var(--color-ink-muted)]">{entry.url}</p>
            <p className="text-[var(--color-ink-subtle)]">{entry.reason}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EndpointTable({ endpoints }: { endpoints: DiscoveredEndpoint[] }) {
  if (endpoints.length === 0) {
    return (
      <Panel title="Endpoints">
        <Empty title="No endpoint was found">
          Nothing on the page, in its scripts, or in the requests it made matched anything this tool can read.
        </Empty>
      </Panel>
    );
  }

  return (
    <Panel title={`Endpoints (${endpoints.length})`}>
      <ul className="space-y-3">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="border-t border-[var(--color-border)] pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip border-[var(--color-border-strong)] bg-[var(--color-surface-raised)]">
                {endpoint.kind}
              </span>
              <span
                className={`chip ${
                  endpoint.nature === 'vector'
                    ? 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]'
                    : endpoint.nature === 'raster'
                      ? 'border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-warn)]'
                      : 'border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-subtle)]'
                }`}
              >
                {endpoint.nature}
              </span>
              {endpoint.probe && (
                <span className="text-xs text-[var(--color-ink-subtle)]">
                  {endpoint.probe.reachable
                    ? `HTTP ${endpoint.probe.status ?? '?'}, ${endpoint.probe.contentType ?? 'no content type'}`
                    : `not read: ${endpoint.probe.failureReason ?? endpoint.probe.failureKind ?? 'unknown'}`}
                </span>
              )}
              {!endpoint.probe && <span className="text-xs text-[var(--color-ink-subtle)]">not probed</span>}
            </div>
            <p className="mono mt-1 break-all text-xs text-[var(--color-ink-muted)]">{endpoint.url}</p>
            <p className="mt-1 text-xs text-[var(--color-ink-subtle)]">Found in {endpoint.discoveredIn}.</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
