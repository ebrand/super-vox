/// <reference lib="webworker" />
import { PlateStageCache, WORLD_SHAPES, type PlateTerrainConfig, type WorldShape } from '@super-vox/shared';
import { previewSteps, type Preview } from './generatorPreview.js';

export interface PreviewRequest {
  id: number;
  config: PlateTerrainConfig;
  size: number;
  shape: WorldShape;
}

/** The answer to the newest request only: older ones are dropped unanswered. */
export type PreviewResponse = { id: number; ok: true; preview: Preview } | { id: number; ok: false; error: string };

/** The plate stages of earlier builds: a change redoes only the stages it affects. */
const cache = new PlateStageCache();
// Builds stop after each stage they make, to check for newer settings.
cache.pauseAfterEach = true;
/** The newest request (null once it's answered). */
let latest: PreviewRequest | null = null;
let running = false;

self.onmessage = (ev: MessageEvent<PreviewRequest>) => {
  latest = ev.data;
  if (!running) void run();
};

/**
 * Lets messages that arrived meanwhile in (a newer request replaces `latest`). Through a message
 * channel rather than setTimeout, which browsers may throttle in background tabs.
 */
const channel = new MessageChannel();
let resume: (() => void) | null = null;
channel.port1.onmessage = () => resume?.();
const pause = () =>
  new Promise<void>((resolve) => {
    resume = resolve;
    channel.port2.postMessage(null);
  });

async function run(): Promise<void> {
  running = true;
  while (latest) {
    const req = latest;
    let res: PreviewResponse | null = null;
    try {
      const steps = previewSteps(req.config, req.size, WORLD_SHAPES[req.shape], cache);
      for (;;) {
        const r = steps.next();
        if (r.done) {
          res = { id: req.id, ok: true, preview: r.value };
          break;
        }
        await pause();
        // Overtaken: drop it (the stages it built stay in the cache).
        if (latest !== req) break;
      }
    } catch (err) {
      res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (latest !== req) continue;
    latest = null;
    if (!res) continue;
    const transfer = res.ok ? [res.preview.map.heights.buffer, res.preview.map.materials.buffer, res.preview.plateOf.buffer, ...(res.preview.biome ? [res.preview.biome.buffer] : [])] : [];
    self.postMessage(res, transfer);
  }
  running = false;
}
