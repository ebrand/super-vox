import { parentPort, workerData } from 'node:worker_threads';
import { PlateStageCache, type TerrainStroke, type WorldConfig } from '@super-vox/shared';
import { saveBuild } from './plateBuilds.js';
import { generatorFor, type WorldSpec } from './worldFile.js';

/**
 * Builds a plate world and saves the build (see plateBuilds.ts), off the main thread: for a world
 * just made or changed, so it's ready on disk before anyone plays it. Says when it's done (or why
 * not) and stops.
 */
export interface BuildJob {
  spec: WorldSpec;
  config: WorldConfig;
  strokes: TerrainStroke[];
  file: string;
}

const job = workerData as BuildJob;
const t0 = performance.now();
try {
  const cache = new PlateStageCache();
  generatorFor(job.spec, job.config, job.strokes, cache);
  await saveBuild(job.file, cache.share());
  parentPort!.postMessage({ ok: true, ms: performance.now() - t0 });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
