/**
 * The provider contract.
 *
 * A provider knows how to talk to one family of GIS service. The discovery
 * engine classifies an endpoint, picks the matching provider, and from then on
 * the rest of the application deals only in `LayerRecord` / `FeatureRecord`.
 */

import type { RequestBudget } from '@/lib/net/budget';
import type { LayerRecord, FeatureRecord, DiscoveredEndpoint, LayerField } from '../types';

export type ProviderContext = {
  budget: RequestBudget;
  signal?: AbortSignal;
  /** Location the user selected, when one narrows the query. */
  locationId?: string | null;
  locationName?: string | null;
};

export type FeaturePage = {
  features: FeatureRecord[];
  /** Cursor for the next page, or null at the end of the layer. */
  nextCursor: string | null;
  /** Total the service reports, when it reports one. */
  total: number | null;
  /** True when a limit stopped the read before the layer was exhausted. */
  truncated: boolean;
  notes: string[];
};

export type FeatureQuery = {
  cursor?: string | null;
  limit?: number;
  /** Free-text filter applied server-side when the service supports it. */
  search?: string | null;
  /** Restrict to specific source feature ids. */
  ids?: string[] | null;
  /** Whether geometry is needed; list views can skip it for speed. */
  includeGeometry?: boolean;
  bbox?: [number, number, number, number] | null;
};

export interface GeoProvider {
  readonly id: string;
  /** Whether this provider handles the given endpoint. */
  supports(endpoint: DiscoveredEndpoint): boolean;
  /** Enumerate the layers an endpoint exposes. */
  listLayers(endpoint: DiscoveredEndpoint, context: ProviderContext): Promise<LayerRecord[]>;
  /** Read a page of features from a layer. */
  listFeatures(layer: LayerRecord, query: FeatureQuery, context: ProviderContext): Promise<FeaturePage>;
}

/** Categorise a layer from its own name and description, never from a hard-coded list. */
export function categoriseLayer(
  name: string,
  description?: string | null,
): LayerRecord['category'] {
  const haystack = `${name} ${description ?? ''}`.toLowerCase();
  if (/\btp\b|town\s*plan|townplan|t\.?p\.?\s*scheme|final plot|op\b/.test(haystack)) return 'tp-scheme';
  if (/development\s*plan|\bdp\b|zoning|zone|land\s*use|landuse/.test(haystack)) return 'development-plan';
  if (/village|gram|revenue\s*boundary|taluka|tehsil|ward|municipal\s*boundary/.test(haystack)) {
    return 'village-boundary';
  }
  if (/parcel|survey|khasra|khata|plot|cadastr|property|land\s*record/.test(haystack)) return 'land-parcel';
  return 'other';
}

export const CATEGORY_LABELS: Record<LayerRecord['category'], string> = {
  'tp-scheme': 'Town Planning Schemes',
  'development-plan': 'Development Plan',
  'village-boundary': 'Village Boundaries',
  'land-parcel': 'Land / Parcel Data',
  other: 'Other Public Layers',
};

/**
 * Pick the most human-meaningful attribute to use as a feature's display name.
 *
 * Only attributes the source actually provided are considered; when none of
 * them looks like a name the feature is labelled by its id rather than being
 * given an invented one.
 */
const NAME_FIELD_PATTERNS = [
  /^(name|label|title)$/i,
  /^(feature_?name|layer_?name)$/i,
  /survey.*(no|num|number)/i,
  /(no|num|number).*survey/i,
  /^(sy_?no|svy_?no|s_?no)$/i,
  /(plot|final_?plot|fp).*(no|num|number)/i,
  /(scheme|tp).*(no|num|name|number)/i,
  /(village|gram|ward|zone|city).*(name)?/i,
  /^(khasra|khata|khewat|cts|survey|plot|parcel)/i,
  /_?name$/i,
];

export function deriveFeatureName(
  properties: Record<string, string | number | boolean | null>,
  fallbackId: string | null,
  layerName: string,
): { name: string; field: string | null } {
  for (const pattern of NAME_FIELD_PATTERNS) {
    for (const [key, value] of Object.entries(properties)) {
      if (!pattern.test(key)) continue;
      if (value === null || value === '') continue;
      const text = String(value).trim();
      if (!text || text.toLowerCase() === 'null') continue;
      return { name: text, field: key };
    }
  }
  if (fallbackId) return { name: `${layerName} #${fallbackId}`, field: null };
  return { name: layerName, field: null };
}

/** Normalise a service's field descriptors into our shape. */
export function toLayerFields(
  raw: Array<{ name?: unknown; alias?: unknown; type?: unknown }> | undefined,
): LayerField[] {
  if (!Array.isArray(raw)) return [];
  const fields: LayerField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.name !== 'string') continue;
    fields.push({
      name: entry.name,
      alias: typeof entry.alias === 'string' && entry.alias !== entry.name ? entry.alias : null,
      type: typeof entry.type === 'string' ? entry.type : null,
    });
  }
  return fields;
}
