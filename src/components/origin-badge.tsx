'use client';

/**
 * The origin badge.
 *
 * The one piece of UI that must never be wrong: it states whether an artefact
 * is a file the source published or a document this tool generated. It takes
 * the closed `ArtifactOrigin` union, so there is no string a caller could pass
 * that would produce a misleading label.
 */

import { ORIGIN_DESCRIPTIONS, ORIGIN_LABELS, type ArtifactOrigin } from '@/lib/preservation/types';

const TONES: Record<ArtifactOrigin, string> = {
  original: 'border-[var(--color-good)]/40 bg-[var(--color-good-soft)] text-[var(--color-good)]',
  reconstructed: 'border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
};

const MARKS: Record<ArtifactOrigin, string> = {
  original: '◉',
  reconstructed: '◌',
};

export function OriginBadge({ origin, showDetail }: { origin: ArtifactOrigin; showDetail?: boolean }) {
  return (
    <span className="inline-flex flex-col gap-1">
      <span className={`chip ${TONES[origin]}`} title={ORIGIN_DESCRIPTIONS[origin]}>
        <span aria-hidden>{MARKS[origin]}</span>
        {ORIGIN_LABELS[origin]}
      </span>
      {showDetail && (
        <span className="text-xs text-[var(--color-ink-subtle)]">{ORIGIN_DESCRIPTIONS[origin]}</span>
      )}
    </span>
  );
}
