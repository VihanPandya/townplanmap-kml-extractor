'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAppState } from './app-state';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/cities', label: 'Cities' },
  { href: '/layers', label: 'Map Layers' },
  { href: '/features', label: 'Features' },
  { href: '/export', label: 'KML Export' },
  { href: '/history', label: 'Export History' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[var(--color-canvas)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          >
            {/* A simple parcel-outline mark. */}
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4.5 6 2.5l4 2 4-2v9l-4 2-4-2-4 2z" strokeLinejoin="round" />
              <path d="M6 2.5v9M10 4.5v9" />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-tight">TownPlanMap KML Extractor</span>
        </Link>

        <nav aria-label="Main" className="order-3 w-full sm:order-2 sm:w-auto">
          <ul className="flex flex-wrap items-center gap-1">
            {LINKS.map((link) => {
              const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                      active
                        ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="order-2 ml-auto sm:order-3">
          <ConnectionPill />
        </div>
      </div>
    </header>
  );
}

function ConnectionPill() {
  const { connection } = useAppState();

  if (connection.status === 'connected') {
    return (
      <span className="chip border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-good)]" />
        Connected
      </span>
    );
  }
  if (connection.status === 'connecting') {
    return (
      <span className="chip border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
        Connecting…
      </span>
    );
  }
  if (connection.status === 'failed') {
    return (
      <span className="chip border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-bad)]">
        Not connected
      </span>
    );
  }
  return (
    <span className="chip border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-subtle)]">
      Not connected
    </span>
  );
}
