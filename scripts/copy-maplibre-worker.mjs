#!/usr/bin/env node
/**
 * Publish MapLibre's worker bundle into `public/`.
 *
 * MapLibre GL JS 6 ships its web worker as a separate module and resolves it at
 * runtime with `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Once the
 * library has been through a bundler that URL points into the build's chunk
 * directory, where the worker file was never emitted — the request 404s, the
 * worker dies, and every GeoJSON source silently stays empty while the map
 * itself looks fine.
 *
 * Copying the worker (and the shared chunk it imports) to a stable public path
 * and pointing `setWorkerUrl` at it is the supported fix. Both files must sit in
 * the same directory, because the worker imports the shared chunk relatively.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const from = join(root, 'node_modules', 'maplibre-gl', 'dist');
const to = join(root, 'public', 'maplibre');

const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

if (!existsSync(from)) {
  console.error('maplibre-gl is not installed; skipping worker copy.');
  process.exit(0);
}

await mkdir(to, { recursive: true });

for (const file of FILES) {
  const source = join(from, file);
  if (!existsSync(source)) {
    console.error(`Expected ${file} in maplibre-gl/dist but it is not there.`);
    process.exit(1);
  }
  await copyFile(source, join(to, file));
}

console.log(`Copied ${FILES.length} MapLibre worker file(s) to public/maplibre/.`);
