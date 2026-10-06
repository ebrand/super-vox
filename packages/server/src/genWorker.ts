import { parentPort } from 'node:worker_threads';
import { PlateStageCache, encodeChunk, surfaceMap, type ChunkCoord, type ChunkGenerator, type PlateStages, type TerrainStroke, type TileCoord, type WorldConfig } from '@super-vox/shared';
import { encodeWorldMap, tileBytes } from './world.js';
import { generatorFor, type WorldSpec } from './worldFile.js';

/**
 * A generation worker (see GenPool): makes worlds' chunks, tiles and column ranges from their
 * settings and terraforming, as the main thread would. Keeps the generators of the worlds it was
 * asked about most recently (each holds a world's grids: hundreds of MB for a big one).
 */
export type GenRequest =
  /** A world to make terrain for; a plate world's build comes along (`stages`, in shared memory), so it isn't made again here. */
  | { type: 'world'; key: string; spec: WorldSpec; config: WorldConfig; strokes: TerrainStroke[]; stages: PlateStages | null }
  | { type: 'forget'; key: string }
  | { type: 'job'; id: number; key: string; job: GenJob };

export type GenJob =
  | { kind: 'chunk'; coord: ChunkCoord }
  | { kind: 'tile'; t: TileCoord }
  | { kind: 'column'; cx: number; cz: number }
  /** A map of part of the world (see surfaceMap), encoded (see encodeWorldMap). */
  | { kind: 'map'; x0: number; z0: number; step: number; cols: number; rows: number };

/** `ms`: the job's time; `buildMs`: what building the world's generator for it took first (0 if already built). */
export type GenResponse = { id: number; ok: true; bytes?: Uint8Array; range?: unknown; ms: number; buildMs: number } | { id: number; ok: false; error: string };

/** Most generators a worker keeps. */
const KEEP = 2;

const worlds = new Map<string, { spec: WorldSpec; config: WorldConfig; strokes: TerrainStroke[]; stages: PlateStages | null }>();
/** Built generators, least recently used first. */
const built = new Map<string, ChunkGenerator>();

function generator(key: string): ChunkGenerator {
  let g = built.get(key);
  if (g) {
    built.delete(key);
    built.set(key, g);
    return g;
  }
  const w = worlds.get(key);
  if (!w) throw new Error(`no world ${key} here`);
  g = generatorFor(w.spec, w.config, w.strokes, w.stages ? PlateStageCache.from(w.stages, w.config) : undefined).generator;
  built.set(key, g);
  while (built.size > KEEP) built.delete(built.keys().next().value!);
  return g;
}

parentPort!.on('message', (req: GenRequest) => {
  if (req.type === 'world') {
    worlds.set(req.key, { spec: req.spec, config: req.config, strokes: req.strokes, stages: req.stages });
    return;
  }
  if (req.type === 'forget') {
    worlds.delete(req.key);
    built.delete(req.key);
    // (Its generator's memory goes now: an idle worker otherwise keeps it. Only with --expose-gc,
    // which workers take from the main thread's node options.)
    (globalThis as { gc?: () => void }).gc?.();
    return;
  }
  try {
    const b0 = performance.now();
    const g = generator(req.key);
    const buildMs = performance.now() - b0;
    const t0 = performance.now();
    const j = req.job;
    if (j.kind === 'column') {
      const range = g.columnRange(j.cx, j.cz);
      parentPort!.postMessage({ id: req.id, ok: true, range, ms: performance.now() - t0, buildMs } satisfies GenResponse);
      return;
    }
    const bytes =
      j.kind === 'chunk' ? encodeChunk(g.generateChunk(j.coord))
      : j.kind === 'map' ? encodeWorldMap(surfaceMap(g, j.x0, j.z0, j.step, j.cols, j.rows))
      : tileBytes(g, worlds.get(req.key)!.config, j.t);
    parentPort!.postMessage({ id: req.id, ok: true, bytes, ms: performance.now() - t0, buildMs } satisfies GenResponse, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies GenResponse);
  }
});
