'use client';

/**
 * City and area selection, with search and provenance for each entry.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppState } from '@/components/app-state';
import { Empty, Notice, Panel, Spinner } from '@/components/ui';
import type { LocationRecord } from '@/lib/discovery/types';

export default function CitiesPage() {
  const router = useRouter();
  const { connection, selection, selectCity, selectArea } = useAppState();

  const [cities, setCities] = useState<LocationRecord[]>([]);
  const [areas, setAreas] = useState<LocationRecord[]>([]);
  const [areaNote, setAreaNote] = useState<string | null>(null);
  const [cityQuery, setCityQuery] = useState('');
  const [areaQuery, setAreaQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingAreas, setLoadingAreas] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/cities')
      .then((response) => response.json())
      .then((data: { cities?: LocationRecord[] }) => {
        if (!cancelled) setCities(data.cities ?? []);
      })
      .catch(() => {
        if (!cancelled) setCities([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
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

  const filteredCities = useMemo(() => filterByName(cities, cityQuery), [cities, cityQuery]);
  const filteredAreas = useMemo(() => filterByName(areas, areaQuery), [areas, areaQuery]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Cities and areas</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Every name below was read from the source during discovery. Each shows where it came from.
        </p>
      </header>

      {connection.status !== 'connected' && (
        <Notice tone="warn">
          Not connected. Run a discovery scan from the Dashboard first — the lists here are populated from the source,
          never from a built-in list.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Select city">
          <div className="space-y-3">
            <input
              type="search"
              className="field"
              placeholder="Search cities…"
              value={cityQuery}
              onChange={(event) => setCityQuery(event.target.value)}
              aria-label="Search cities"
            />

            {loading ? (
              <Spinner label="Loading…" />
            ) : filteredCities.length === 0 ? (
              <Empty title={cities.length === 0 ? 'No cities discovered' : 'No match'}>
                {cities.length === 0
                  ? 'The source did not expose a city list in a form this tool could read. You can still browse every discovered layer from Map Layers.'
                  : 'No discovered city matches that search.'}
              </Empty>
            ) : (
              <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                {filteredCities.map((city) => (
                  <LocationRow
                    key={city.id}
                    location={city}
                    selected={selection.cityId === city.id}
                    onSelect={() => selectCity(city)}
                  />
                ))}
              </ul>
            )}
          </div>
        </Panel>

        <Panel title="Select area">
          <div className="space-y-3">
            {!selection.cityId ? (
              <Empty title="Choose a city first" />
            ) : (
              <>
                <input
                  type="search"
                  className="field"
                  placeholder="Search village / locality…"
                  value={areaQuery}
                  onChange={(event) => setAreaQuery(event.target.value)}
                  aria-label="Search areas"
                />

                <button
                  type="button"
                  onClick={() => selectArea(null)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selection.areaId === null
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                      : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
                  }`}
                >
                  All areas
                </button>

                {loadingAreas ? (
                  <Spinner label="Deriving the locality list from the source…" />
                ) : filteredAreas.length === 0 ? (
                  <Empty title="No areas available">{areaNote}</Empty>
                ) : (
                  <ul className="max-h-[24rem] space-y-1 overflow-y-auto pr-1">
                    {filteredAreas.map((area) => (
                      <LocationRow
                        key={area.id}
                        location={area}
                        selected={selection.areaId === area.id}
                        onSelect={() => selectArea(area)}
                      />
                    ))}
                  </ul>
                )}

                {areaNote && filteredAreas.length > 0 && (
                  <p className="text-xs text-[var(--color-ink-subtle)]">{areaNote}</p>
                )}
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          className="btn btn-primary"
          disabled={connection.status !== 'connected'}
          onClick={() => router.push('/layers')}
        >
          Discover map layers {'→'}
        </button>
      </div>
    </div>
  );
}

function filterByName(locations: LocationRecord[], query: string): LocationRecord[] {
  const needle = query.trim().toLowerCase();
  const sorted = [...locations].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!needle) return sorted;
  return sorted.filter((location) => location.name.toLowerCase().includes(needle));
}

function LocationRow({
  location,
  selected,
  onSelect,
}: {
  location: LocationRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
          selected
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
        }`}
      >
        <span className="block text-sm text-[var(--color-ink)]">{location.name}</span>
        <span className="mt-0.5 block truncate text-xs text-[var(--color-ink-subtle)]" title={location.sourceUrl}>
          {location.sourceField ? `from "${location.sourceField}" · ` : ''}
          {location.sourceUrl}
        </span>
      </button>
    </li>
  );
}
