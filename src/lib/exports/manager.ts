/**
 * Export job manager.
 *
 * Large exports run server-side as jobs rather than being assembled in the
 * browser: the client posts a request, gets a job id back immediately, and
 * polls for progress. Results small enough to hold are kept in memory; anything
 * larger is spilled to disk so a big city-wide export does not sit in the heap
 * until it is downloaded.
 */

import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getStore } from '@/lib/db';
import { runExport } from './pipeline';
import { CONTENT_TYPES, type ExportJob, type ExportProgress, type ExportRequest } from './types';

/** Above this, the artefact goes to disk instead of staying in memory. */
const SPILL_THRESHOLD_BYTES = 8 * 1024 * 1024;

const STORAGE_DIR = process.env.TPM_EXPORT_DIR ?? join(process.cwd(), 'storage', 'exports');

/** In-memory artefacts and abort handles, keyed by job id. */
const artifacts = new Map<string, Uint8Array>();
const controllers = new Map<string, AbortController>();

function initialProgress(): ExportProgress {
  return {
    phase: 'queued',
    featuresProcessed: 0,
    featuresTotal: null,
    geometryValidationPercent: 0,
    generationPercent: 0,
    message: 'Queued.',
  };
}

function labelFor(request: ExportRequest): string {
  if (request.name) return request.name;
  switch (request.scope.type) {
    case 'features':
      return `${request.scope.featureIds.length} selected feature(s)`;
    case 'layer':
      return 'Entire layer';
    case 'location':
      return `${request.scope.layerIds.length} layer(s) for one location`;
    case 'combined':
      return `${request.scope.layerIds.length} layer(s) combined`;
    default:
      return 'Export';
  }
}

/**
 * Start an export.
 *
 * Returns as soon as the job is registered; the work continues in the
 * background and progress is read back through `getJob`.
 */
export async function startExport(request: ExportRequest): Promise<ExportJob> {
  const store = await getStore();
  const id = `export_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const job: ExportJob = {
    id,
    label: labelFor(request),
    status: 'queued',
    format: request.individualFiles ? 'bundle' : request.format,
    request,
    progress: initialProgress(),
    featureCount: 0,
    skipped: [],
    validation: null,
    artifact: null,
    error: null,
    notes: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  await store.saveExport(job);

  const controller = new AbortController();
  controllers.set(id, controller);

  // Run detached. Errors are captured onto the job rather than becoming an
  // unhandled rejection.
  void execute(job, controller.signal).catch(async (error) => {
    const failed: ExportJob = {
      ...job,
      status: 'failed',
      error: error instanceof Error ? error.message : 'The export failed.',
      completedAt: new Date().toISOString(),
      progress: { ...job.progress, phase: 'done', message: 'Failed.' },
    };
    const inner = await getStore();
    await inner.saveExport(failed);
    controllers.delete(id);
  });

  return job;
}

async function execute(job: ExportJob, signal: AbortSignal): Promise<void> {
  const store = await getStore();
  let current: ExportJob = {
    ...job,
    status: 'processing',
    progress: { ...job.progress, phase: 'reading', message: 'Reading features from the source…' },
  };
  await store.saveExport(current);

  // Progress updates are frequent; persist at most a few times a second so a
  // database-backed store is not hammered by the reporter.
  let lastPersist = 0;
  const report = (partial: Partial<ExportProgress>) => {
    current = { ...current, progress: { ...current.progress, ...partial } };
    const now = Date.now();
    if (now - lastPersist > 300) {
      lastPersist = now;
      void store.saveExport(current);
    }
  };

  const output = await runExport(job.request, report, signal);

  if (signal.aborted) {
    await store.saveExport({
      ...current,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      progress: { ...current.progress, phase: 'done', message: 'Cancelled.' },
    });
    controllers.delete(job.id);
    return;
  }

  const bytes =
    typeof output.content === 'string' ? Buffer.from(output.content, 'utf8') : Buffer.from(output.content);

  let storage: ExportJob['artifact'];
  if (bytes.byteLength > SPILL_THRESHOLD_BYTES) {
    await mkdir(STORAGE_DIR, { recursive: true });
    // The path is built from the job id, which this process generated — never
    // from the user-supplied filename.
    const path = join(STORAGE_DIR, `${job.id}.bin`);
    await writeFile(path, bytes);
    storage = {
      filename: output.filename,
      contentType: output.contentType || CONTENT_TYPES[current.format],
      bytes: bytes.byteLength,
      storage: { kind: 'file', path },
    };
  } else {
    artifacts.set(job.id, new Uint8Array(bytes));
    storage = {
      filename: output.filename,
      contentType: output.contentType || CONTENT_TYPES[current.format],
      bytes: bytes.byteLength,
      storage: { kind: 'memory' },
    };
  }

  const complete: ExportJob = {
    ...current,
    status: 'complete',
    featureCount: output.featureCount,
    skipped: output.skipped,
    validation: output.validation,
    artifact: storage,
    notes: output.notes,
    completedAt: new Date().toISOString(),
    progress: {
      ...current.progress,
      phase: 'done',
      geometryValidationPercent: 100,
      generationPercent: 100,
      featuresProcessed: output.featureCount,
      featuresTotal: output.featureCount,
      message: 'Export complete.',
    },
  };

  await store.saveExport(complete);
  controllers.delete(job.id);
}

export async function getJob(id: string): Promise<ExportJob | null> {
  const store = await getStore();
  return store.getExport(id);
}

export async function listJobs(limit = 50): Promise<ExportJob[]> {
  const store = await getStore();
  return store.listExports(limit);
}

export async function cancelJob(id: string): Promise<boolean> {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  controllers.delete(id);
  return true;
}

/** Read a completed job's bytes back for download. */
export async function readArtifact(job: ExportJob): Promise<Uint8Array | null> {
  if (!job.artifact) return null;
  if (job.artifact.storage.kind === 'memory') {
    return artifacts.get(job.id) ?? null;
  }
  try {
    const buffer = await readFile(job.artifact.storage.path);
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/** Drop a job's artefact. Used when history is cleared. */
export async function discardArtifact(job: ExportJob): Promise<void> {
  artifacts.delete(job.id);
  if (job.artifact?.storage.kind === 'file') {
    await unlink(job.artifact.storage.path).catch(() => {});
  }
}

/**
 * Run an export inline and return the result.
 *
 * Used by the single-feature download path, where the work is small and a
 * round trip through the job queue would only add latency.
 */
export async function runExportInline(request: ExportRequest) {
  return runExport(request, () => {});
}
