/// <reference lib="webworker" />
import { WORLD_SHAPES, defaultVoxelize, encodeClimate, type PlateTerrainConfig, type WorldShape } from '@super-vox/shared';
import { AreaMaker, buffersOf, type MadeArea } from './terraformArea.js';

/**
 * The generator's close-up (see generator.ts): an area of the world the settings make, as a
 * diorama (see AreaMaker), made again as settings change. The world is built once per shape and
 * kept: changes to surface settings (SURFACE_SETTINGS) reuse every stage of it.
 */
export interface CloseUpRequest {
  id: number;
  shape: WorldShape;
  config: PlateTerrainConfig;
  /** North-west corner, size and step between samples (units). */
  x0: number;
  z0: number;
  size: number;
  step: number;
}

/** The answer to the newest request only: older ones are dropped unanswered. */
export type CloseUpResponse =
  | ({ id: number; ok: true; ms: number; climate: Uint8Array | null; seaLevel: number; wrapX: boolean } & MadeArea)
  | { id: number; ok: false; error: string };

/** Below the area's lowest ground, the diorama's base (units). */
const BASE_DEPTH = 24 * 16;

let maker: { shape: WorldShape; maker: AreaMaker } | null = null;
let latest: CloseUpRequest | null = null;
let running = false;

self.onmessage = (ev: MessageEvent<CloseUpRequest>) => {
  latest = ev.data;
  if (!running) void run();
};

/** Lets newer requests in between areas (through a message channel: not throttled in background tabs). */
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
    latest = null;
    try {
      const t0 = performance.now();
      const world = WORLD_SHAPES[req.shape];
      if (!maker || maker.shape !== req.shape) maker = { shape: req.shape, maker: new AreaMaker(world, req.config, defaultVoxelize()) };
      else maker.maker.configure(req.config);
      await pause();
      // (Overtaken while the world was built: make the newer one instead.)
      if (latest) continue;
      const m = maker.maker;
      const area = m.make({ x0: req.x0, z0: req.z0, size: req.size, step: req.step, depth: BASE_DEPTH, strokes: [] });
      if (latest) continue;
      const c = m.heights.climate();
      const climate = c ? encodeClimate(c) : null;
      const res: CloseUpResponse = { id: req.id, ok: true, ms: performance.now() - t0, climate, seaLevel: m.heights.seaLevel, wrapX: world.wrapX, ...area };
      self.postMessage(res, [...buffersOf(area.parts), area.heights.buffer, ...(climate ? [climate.buffer as ArrayBuffer] : [])]);
    } catch (err) {
      self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies CloseUpResponse);
    }
  }
  running = false;
}
