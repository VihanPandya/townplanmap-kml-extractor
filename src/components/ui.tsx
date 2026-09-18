'use client';

/**
 * Small shared presentation pieces.
 *
 * The provenance and availability badges live here because they are the most
 * important UI in the product: they are what stops a user mistaking a
 * generalised tile boundary, or a synthetic sample, for a surveyed one.
 */

import type { ReactNode } from 'react';
import type { LayerGeometryAvailability, Provenance } from '@/lib/discovery/types';

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          {typeof title === 'string' ? <h2 className="label">{title}</h2> : title}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center">
      <p className="text-sm font-medium text-[var(--color-ink-muted)]">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-ink-subtle)]">{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
      <span
        aria-hidden
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-accent)]"
      />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'good' | 'warn' | 'bad';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: 'border-[var(--color-border-strong)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]',
    good: 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-ink)]',
    warn: 'border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-ink)]',
    bad: 'border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-ink)]',
  } as const;

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${tones[tone]}`} role={tone === 'bad' ? 'alert' : undefined}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-[var(--color-ink-muted)]">{children}</div>
    </div>
  );
}

/**
 * The provenance badge.
 *
 * Every wording here is chosen so that nothing approximate can read as exact.
 */
const PROVENANCE: Record<Provenance, { label: string; tone: string; detail: string }> = {
  'source-geometry': {
    label: '✓ Source geometry',
    tone: 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]',
    detail: 'Coordinates exactly as the source published them.',
  },
  'crs-converted': {
    label: '✓ Converted from source CRS',
    tone: 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]',
    detail: 'Source coordinates, transformed into WGS84 for KML.',
  },
  'tile-decoded': {
    label: '⚠ Generalised from vector tiles',
    tone: 'border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
    detail:
      'Decoded from vector tiles and quantised to the tile grid. This is a rendering of the boundary, not the surveyed geometry.',
  },
  'image-only': {
    label: '⚠ Image only — KML unavailable',
    tone: 'border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-bad)]',
    detail: 'The source exposes only rendered imagery for this feature.',
  },
  unverified: {
    label: '⚠ Geometry could not be independently verified',
    tone: 'border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
    detail: 'Geometry is present but this tool could not confirm it against the source.',
  },
  'synthetic-fixture': {
    label: '⚠ Synthetic sample — not real data',
    tone: 'border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-bad)]',
    detail: 'Invented demonstration data. Not from TownPlanMap and not a land record.',
  },
};

export function ProvenanceBadge({ provenance, showDetail }: { provenance: Provenance; showDetail?: boolean }) {
  const entry = PROVENANCE[provenance];
  return (
    <span className="inline-flex flex-col gap-1">
      <span className={`chip ${entry.tone}`} title={entry.detail}>
        {entry.label}
      </span>
      {showDetail && <span className="text-xs text-[var(--color-ink-subtle)]">{entry.detail}</span>}
    </span>
  );
}

export function AvailabilityBadge({ availability }: { availability: LayerGeometryAvailability }) {
  switch (availability.status) {
    case 'vector':
      return (
        <span
          className="chip border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]"
          title={availability.note}
        >
          {'✓'} Geographic data detected
        </span>
      );
    case 'raster':
      return (
        <span
          className="chip border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
          title={availability.note}
        >
          {'⚠'} Only map imagery
        </span>
      );
    case 'restricted':
      return (
        <span
          className="chip border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-bad)]"
          title={availability.note}
        >
          {'✕'} Authorised access required
        </span>
      );
    default:
      return (
        <span
          className="chip border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]"
          title={availability.note}
        >
          Geometry availability unknown
        </span>
      );
  }
}

export function KmlBadge({ available, note }: { available: boolean; note?: string }) {
  return (
    <span
      className={`chip ${
        available
          ? 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]'
          : 'border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] text-[var(--color-bad)]'
      }`}
      title={note}
    >
      {available ? '✓ KML supported' : '✕ KML not available'}
    </span>
  );
}

/** A label/value row, used throughout the inspector panels. */
export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] py-1.5 last:border-0">
      <dt className="text-xs text-[var(--color-ink-subtle)]">{label}</dt>
      <dd className={`text-right text-sm ${mono ? 'mono' : ''} text-[var(--color-ink)]`}>{value}</dd>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      {label && (
        <div className="mb-1 flex justify-between text-xs text-[var(--color-ink-subtle)]">
          <span>{label}</span>
          <span className="mono">{clamped}%</span>
        </div>
      )}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
