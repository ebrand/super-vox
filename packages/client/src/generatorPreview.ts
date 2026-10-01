import { FLAT_WORLD_16KM, PlateHeights, type PlateTerrainConfig, type WorldConfig } from '@super-vox/shared';
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
  stats: PreviewStats;
}

/**
 * Everything the world generator page shows for a set of plate settings: a
 * top-down map `size` samples wide, the plate under each sample, and some
 * statistics. Uses the same PlateHeights as the server, so the preview is the
 * world that would be created.
 */
export function buildPreview(config: PlateTerrainConfig, size: number, world: WorldConfig = FLAT_WORLD_16KM): Preview {
  const t0 = performance.now();
  const p = new PlateHeights(world, config);
  const step = world.widthUnits / size;
  const cols = size, rows = Math.round(world.depthUnits / step);
  const h = p.heights(step / 2, step / 2, cols, rows, step);
  const m = p.materials(step / 2, step / 2, cols, rows, step, h);
  const biome = p.biomes(step / 2, step / 2, cols, rows, step, h);
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
    heights[k] = h[k]!;
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
  return {
    map: { cols, rows, step, seaLevel: p.seaLevel, heights, materials: Uint8Array.from(m) },
    plateOf,
    plates: p.plates.map((q) => ({ major: q.major, continental: q.continental })),
    biome,
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
