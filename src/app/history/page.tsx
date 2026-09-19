'use client';

/** Export history: every job this instance has run, with its validation verdict. */

import { useEffect, useState } from 'react';
import { Empty, Notice, Panel, Spinner } from '@/components/ui';
import { OriginBadge } from '@/components/origin-badge';

type HistoryEntry = {
  exportId: string;
  label: string;
  status: string;
  format: string;
  featureCount: number;
  skippedCount: number;
  valid: boolean | null;
  size: string | null;
  filename: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  downloadUrl: string | null;
};

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [durable, setDurable] = useState<boolean | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch('/api/exports').then((response) => response.json()),
      fetch('/api/settings').then((response) => response.json()),
    ])
      .then(([history, settings]: [{ exports?: HistoryEntry[] }, { storage?: { durable: boolean } }]) => {
        setEntries(history.exports ?? []);
        setDurable(settings.storage?.durable ?? null);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Export history</h1>
          <OriginBadge origin="reconstructed" />
        </div>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ink-muted)]">
          Every export this instance has <em>generated</em>, newest first. These are reconstructions built from
          map geometry, not files the source published — those are under <strong>Source Files</strong>.
        </p>
      </header>

      {durable === false && (
        <Notice tone="info" title="History is not persisted">
          No database is configured, so this list and the generated files are held in memory and are lost when the
          server restarts. See Settings.
        </Notice>
      )}

      <Panel>
        {loading ? (
          <Spinner label="Loading…" />
        ) : entries.length === 0 ? (
          <Empty title="No exports yet">Generated KML files will appear here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  {['Export', 'Format', 'Features', 'Validation', 'Size', 'Created', ''].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-ink-muted)]"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.exportId} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-3 py-2">
                      <span className="block text-[var(--color-ink)]">{entry.label}</span>
                      <span className="mono block text-xs text-[var(--color-ink-subtle)]">
                        {entry.filename ?? entry.exportId}
                      </span>
                      {entry.error && <span className="block text-xs text-[var(--color-bad)]">{entry.error}</span>}
                    </td>
                    <td className="px-3 py-2 uppercase text-[var(--color-ink-muted)]">{entry.format}</td>
                    <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                      {entry.featureCount.toLocaleString()}
                      {entry.skippedCount > 0 && (
                        <span className="text-[var(--color-warn)]"> (+{entry.skippedCount} excluded)</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {entry.valid === null ? (
                        <span className="text-[var(--color-ink-subtle)]">—</span>
                      ) : entry.valid ? (
                        <span className="text-[var(--color-good)]">{'✓'} Passed</span>
                      ) : (
                        <span className="text-[var(--color-bad)]">{'✕'} Failed</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-ink-muted)]">{entry.size ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-ink-subtle)]">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {entry.downloadUrl && entry.valid !== false ? (
                        <a className="btn btn-secondary px-3 py-1 text-xs" href={entry.downloadUrl}>
                          Download
                        </a>
                      ) : (
                        <span className="text-xs capitalize text-[var(--color-ink-subtle)]">{entry.status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
