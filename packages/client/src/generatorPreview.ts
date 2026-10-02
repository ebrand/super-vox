import { FLAT_WORLD_16KM, Material, NO_CANOPY, PlateHeights, PlateStagePause, type PlateStageCache, type PlateTerrainConfig, type WorldConfig } from '@super-vox/shared';
import { climateTintColors } from './tintColors.js';
import type { MapData } from './worldMap.js';

export interface PreviewStats {
  /** Time to build the plate world and sample the map (ms). */
  ms: number;
  /** Share of the world above the sea, 0..1. */
  land: number;
  /** Lowest and highest sampled ground (metres). */
  minHeight: number;
  maxHeight: number;
  majors: number;
  minors: number;
  /** Average major plate area over average minor plate area (NaN without minors). */
  sizeRatio: number;
  /** Share of the land in each biome (indexed by BiomeId), or null without biomes. */
  biomes: number[] | null;
  /** Colliding seams that raise mountain ranges. */
  ranges: number;
  /** Islands placed by arcs and hotspots, and their share of the world (0..1). */
  islands: { arc: number; hotspot: number; land: number };
}

export interface Preview {
  map: MapData;
  /** Plate index per map sample, row-major like the map. */
  plateOf: Uint16Array;
  plates: { major: boolean; continental: boolean }[];
  /** Biome per map sample (BiomeId), or null for worlds without biomes. */
  biome: Uint8Array | null;
  /** River segments (units): ax, az, bx, bz, width per segment (too narrow to show in the samples). */
  rivers: Float32Array;
  stats: PreviewStats;
}

/**
 * Everything the world generator page shows for a set of plate settings: a
 * top-down map `size` samples wide, the plate under each sample, and some
 * statistics. Uses the same PlateHeights as the server, so the preview is the
 * world that would be created.
 */
export function buildPreview(config: PlateTerrainConfig, size: number, world: WorldConfig = FLAT_WORLD_16KM, cache?: PlateStageCache): Preview {
  const steps = previewSteps(config, size, world, cache);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * buildPreview a step at a time: it pauses (yields) between the costly steps, so a caller can
 * drop a build that's been overtaken by newer settings. `cache` keeps the plate stages between
 * builds (see PlateStageCache).
 */
export function* previewSteps(config: PlateTerrainConfig, size: number, world: WorldConfig = FLAT_WORLD_16KM, cache?: PlateStageCache): Generator<void, Preview> {
  const t0 = performance.now();
  let p: PlateHeights;
  for (;;) {
    try {
      p = new PlateHeights(world, config, cache);
      break;
    } catch (err) {
      // A stage made (with cache.pauseAfterEach): pause, then build on from the cache.
      if (!(err instanceof PlateStagePause)) throw err;
      yield;
    }
  }
  yield;
  const step = world.widthUnits / size;
  const cols = size, rows = Math.round(world.depthUnits / step);
  const h = p.heights(step / 2, step / 2, cols, rows, step);
  yield;
  const m = p.materials(step / 2, step / 2, cols, rows, step, h);
  yield;
  const biome = p.biomes(step / 2, step / 2, cols, rows, step, h);
  yield;
  // Forests, seen from above as the map shows them (biomes and stats are about the ground).
  const canopy = p.canopy(step / 2, step / 2, cols, rows, step, h, m);
  const canopyH = Int32Array.from(h), canopyM = Uint16Array.from(m);
  yield;
  // Rivers and lakes show as water.
  const standing = p.water(step / 2, step / 2, cols, rows, step);
  if (canopy) {
    for (let k = 0; k < h.length; k++) {
      if (canopy.top[k] === NO_CANOPY) continue;
      canopyH[k] = canopy.top[k]!;
      canopyM[k] = canopy.material[k]!;
    }
  }
  if (standing) {
    for (let k = 0; k < h.length; k++) {
      if (standing[k]! <= h[k]!) continue;
      canopyH[k] = standing[k]!;
      canopyM[k] = Material.Water;
    }
  }
  let biomeShares: number[] | null = null;
  if (biome) {
    const count = new Array<number>(8).fill(0);
    let land = 0;
    for (let k = 0; k < h.length; k++) if (h[k]! > p.seaLevel) (land++, count[biome[k]!]!++);
    biomeShares = count.map((c) => c / Math.max(1, land));
  }
  const heights = new Int16Array(h.length);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < h.length; k++) {
    heights[k] = Math.max(-32767, Math.min(32767, canopyH[k]!));
    lo = Math.min(lo, h[k]!);
    hi = Math.max(hi, h[k]!);
  }
  const plateOf = new Uint16Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) plateOf[i + cols * j] = p.plateAt((i + 0.5) * step, (j + 0.5) * step);
  // Plate areas from the full 32 m grid, not the preview samples.
  const area = new Array<number>(p.plates.length).fill(0);
  for (const k of p.plateOf) area[k]!++;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const majorAreas = area.filter((_, k) => p.plates[k]!.major), minorAreas = area.filter((_, k) => !p.plates[k]!.major);
  const map: MapData = { cols, rows, step, seaLevel: p.seaLevel, heights, materials: Uint8Array.from(canopyM) };
  // Ground colours blend between biomes as in the game.
  const climate = p.climate();
  if (climate) map.colors = climateTintColors(map, climate);
  return {
    map,
    plateOf,
    plates: p.plates.map((q) => ({ major: q.major, continental: q.continental })),
    biome,
    rivers: Float32Array.from((p.hydrology?.segments ?? []).flatMap((s) => [s.ax, s.az, s.bx, s.bz, s.width])),
    stats: {
      ms: performance.now() - t0,
      land: p.landFraction(),
      minHeight: lo / 16,
      maxHeight: hi / 16,
      majors: majorAreas.length,
      minors: minorAreas.length,
      sizeRatio: mean(majorAreas) / mean(minorAreas),
      ranges: p.collisions.length,
      biomes: biomeShares,
      islands: {
        arc: p.islands.filter((i) => i.kind === 'arc').length,
        hotspot: p.islands.filter((i) => i.kind === 'hotspot').length,
        land: p.islandCells / p.elevation.length,
      },
    },
  };
}
