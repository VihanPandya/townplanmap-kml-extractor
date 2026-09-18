/** Export job model shared by the job runner, the API and the UI. */

import type { KmlValidationReport } from '@/lib/kml/validate';

export type ExportFormat = 'kml' | 'kmz' | 'geojson' | 'bundle';

export type ExportStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled';

export type ExportScope =
  | { type: 'features'; layerId: string; featureIds: string[] }
  | { type: 'layer'; layerId: string }
  | { type: 'location'; locationId: string; layerIds: string[] }
  | { type: 'combined'; layerIds: string[]; featureIds?: string[] };

export type ExportRequest = {
  scope: ExportScope;
  format: ExportFormat;
  /** One KML per feature, packaged as a ZIP, instead of a single document. */
  individualFiles?: boolean;
  /** Document title; defaults to the layer or location name. */
  name?: string;
};

export type ExportProgress = {
  /** What the job is doing right now, for the progress display. */
  phase: 'queued' | 'reading' | 'validating-geometry' | 'generating' | 'validating-kml' | 'packaging' | 'done';
  featuresProcessed: number;
  featuresTotal: number | null;
  /** 0-100 for each pipeline stage the UI shows a bar for. */
  geometryValidationPercent: number;
  generationPercent: number;
  message: string;
};

export type ExportArtifact = {
  filename: string;
  contentType: string;
  bytes: number;
  /** Where the bytes live. Small results are held in memory; large ones on disk. */
  storage: { kind: 'memory' } | { kind: 'file'; path: string };
};

export type ExportJob = {
  id: string;
  label: string;
  status: ExportStatus;
  format: ExportFormat;
  request: ExportRequest;
  progress: ExportProgress;
  featureCount: number;
  skipped: Array<{ featureId: string; reason: string }>;
  validation: KmlValidationReport | null;
  artifact: ExportArtifact | null;
  error: string | null;
  notes: string[];
  createdAt: string;
  completedAt: string | null;
};

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  geojson: 'application/geo+json',
  bundle: 'application/zip',
};

export const EXTENSIONS: Record<ExportFormat, string> = {
  kml: 'kml',
  kmz: 'kmz',
  geojson: 'geojson',
  bundle: 'zip',
};
