'use client';

/** Settings: the limits and access policies in force. Read-only by design. */

import { useEffect, useState } from 'react';
import { Notice, Panel, Row, Spinner } from '@/components/ui';

type Settings = {
  source: { name: string; baseUrl: string; homepage: string };
  userAgent: string;
  fixtureSourceEnabled: boolean;
  legalNotice: string;
  storage: { kind: string; durable: boolean; description: string };
  limits: Array<{ name: string; value: string | number; env: string }>;
  policies: string[];
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((response) => response.json())
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  if (!settings) {
    return (
      <Panel>
        <Spinner label="Loading settings…" />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          These limits are configured through environment variables so they cannot be raised from the browser.
        </p>
      </header>

      {settings.fixtureSourceEnabled && (
        <Notice tone="bad" title="Synthetic sample data is enabled">
          TPM_ENABLE_FIXTURE_SOURCE is set, so a built-in synthetic dataset appears alongside anything discovered from
          the source. Its geometry is invented for demonstration and is labelled as such everywhere, including inside
          exported KML. Unset the variable to remove it.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Source">
          <dl>
            <Row label="Name" value={settings.source.name} />
            <Row label="Base URL" value={settings.source.baseUrl} mono />
            <Row label="User agent" value={settings.userAgent} mono />
          </dl>
          <p className="mt-3 text-xs text-[var(--color-ink-subtle)]">
            The tool identifies itself honestly rather than impersonating a browser.
          </p>
        </Panel>

        <Panel title="Catalog storage">
          <dl>
            <Row label="Backend" value={settings.storage.kind} mono />
            <Row label="Persists across restarts" value={settings.storage.durable ? 'Yes' : 'No'} />
          </dl>
          <p className="mt-3 text-xs text-[var(--color-ink-subtle)]">{settings.storage.description}</p>
        </Panel>
      </div>

      <Panel title="Crawl and export limits">
        <dl className="grid gap-x-8 sm:grid-cols-2">
          {settings.limits.map((limit) => (
            <div key={limit.env} className="border-b border-[var(--color-border)] py-2 last:border-0">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-[var(--color-ink)]">{limit.name}</dt>
                <dd className="mono text-sm text-[var(--color-ink)]">{limit.value}</dd>
              </div>
              <p className="mono text-xs text-[var(--color-ink-subtle)]">{limit.env}</p>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Access and security policy">
        <ul className="space-y-2">
          {settings.policies.map((policy) => (
            <li key={policy} className="flex items-start gap-2 text-sm text-[var(--color-ink-muted)]">
              <span aria-hidden className="mt-0.5 text-[var(--color-good)]">
                {'✓'}
              </span>
              <span>{policy}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Data use">
        <p className="text-sm leading-relaxed text-[var(--color-ink-muted)]">{settings.legalNotice}</p>
      </Panel>
    </div>
  );
}
