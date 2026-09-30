import { describe, expect, it } from 'vitest';
import { voxelAt, type Chunk } from './chunk.js';
import { Material } from './materials.js';
import { MAX_MOUNTAIN, OCEAN_DEPTH, PLATE_CELL, PlateHeights, defaultPlateTerrain, validatePlateTerrain, type PlateTerrainConfig } from './plates.js';
import { TerrainGenerator } from './terrain.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from './world.js';

const cache = new Map<string, PlateHeights>();
function plates(over: Partial<PlateTerrainConfig> = {}, world = FLAT_WORLD_16KM): PlateHeights {
  const cfg = { ...defaultPlateTerrain(1), ...over };
  const key = JSON.stringify([cfg, world.wrapX, world.depthUnits]);
  let p = cache.get(key);
  if (!p) cache.set(key, (p = new PlateHeights(world, cfg)));
  return p;
}

/** Land cells with a 4-neighbour under water: a measure of coastline length. */
function coastCells(p: PlateHeights): number {
  let n = 0;
  for (let r = 1; r < p.rows - 1; r++) {
    for (let c = 1; c < p.cols - 1; c++) {
      const i = c + p.cols * r;
      if (p.elevation[i]! <= 0) continue;
      if ([i - 1, i + 1, i - p.cols, i + p.cols].some((j) => p.elevation[j]! <= 0)) n++;
    }
  }
  return n;
}

describe('validatePlateTerrain', () => {
  it('rejects out-of-range settings', () => {
    const ok = defaultPlateTerrain(1);
    expect(() => validatePlateTerrain(ok)).not.toThrow();
    expect(() => validatePlateTerrain({ ...ok, majorPlates: 0 })).toThrow(/majorPlates/);
    expect(() => validatePlateTerrain({ ...ok, minorPlates: -1 })).toThrow(/minorPlates/);
    expect(() => validatePlateTerrain({ ...ok, minorPlates: 2.5 })).toThrow(/minorPlates/);
    expect(() => validatePlateTerrain({ ...ok, waterPercent: 101 })).toThrow(/waterPercent/);
    expect(() => validatePlateTerrain({ ...ok, shoreFractal: -1 })).toThrow(/shoreFractal/);
  });
});

describe('PlateHeights', () => {
  it('creates the configured number of major and minor plates', () => {
    const p = plates({ majorPlates: 5, minorPlates: 9 });
    expect(p.plates).toHaveLength(14);
    expect(p.plates.filter((q) => q.weight === 1)).toHaveLength(5);
    expect(new Set(p.plateOf).size).toBeGreaterThan(5);
  });

  it('puts exactly the configured share of the world under water', () => {
    for (const waterPercent of [0, 30, 50, 70, 100]) {
      expect(plates({ waterPercent }).landFraction()).toBeCloseTo(1 - waterPercent / 100, 2);
    }
  });

  it('makes coastlines more ragged as shoreline fractalization rises', () => {
    const smooth = coastCells(plates({ shoreFractal: 0 }));
    const some = coastCells(plates({ shoreFractal: 50 }));
    const ragged = coastCells(plates({ shoreFractal: 100 }));
    expect(some).toBeGreaterThan(smooth * 1.2);
    expect(ragged).toBeGreaterThan(some * 1.1);
  });

  it('keeps continental interiors above beach level at every fractalization', () => {
    for (const shoreFractal of [0, 50, 100]) {
      const p = plates({ shoreFractal });
      let land = 0, lowland = 0;
      for (const h of p.elevation) {
        if (h <= 0) continue;
        land++;
        if (h > 5 * 16) lowland++;
      }
      // Beaches are a thin fringe: most land sits well above the sea.
      expect(lowland / land).toBeGreaterThan(0.7);
    }
  });

  it('stays within its height bounds, reaching both the peak and the deepest sea', () => {
    const p = plates();
    let lo = Infinity, hi = -Infinity;
    for (const h of p.elevation) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    // The strongest uplift makes the tallest peak, close to (never above) MAX_MOUNTAIN.
    expect(hi).toBeLessThanOrEqual(MAX_MOUNTAIN);
    expect(hi).toBeGreaterThan(MAX_MOUNTAIN * 0.85);
    expect(lo).toBeCloseTo(-OCEAN_DEPTH, 0);
    const H = p.heights(0, 0, 500, 500, 512);
    for (const h of H) {
      expect(h).toBeGreaterThanOrEqual(p.minHeight);
      expect(h).toBeLessThanOrEqual(p.maxHeight);
    }
  });

  it('raises high ground only near plate seams', () => {
    const p = plates({ waterPercent: 40 });
    // For every high cell (> 150 m), is there a plate boundary within ~1.5 km?
    const R = Math.round((1500 * 16) / PLATE_CELL);
    let high = 0, nearSeam = 0;
    for (let r = R; r < p.rows - R; r++) {
      for (let c = R; c < p.cols - R; c++) {
        const i = c + p.cols * r;
        if (p.elevation[i]! < 150 * 16) continue;
        high++;
        let seam = false;
        for (let dr = -R; dr <= R && !seam; dr += 2) for (let dc = -R; dc <= R && !seam; dc += 2) {
          seam = p.plateOf[c + dc + p.cols * (r + dr)] !== p.plateOf[i];
        }
        if (seam) nearSeam++;
      }
    }
    expect(high).toBeGreaterThan(100);
    expect(nearSeam / high).toBeGreaterThan(0.95);
  });

  it('is deterministic and seed-dependent', () => {
    const a = new PlateHeights(FLAT_WORLD_16KM, defaultPlateTerrain(42));
    const b = new PlateHeights(FLAT_WORLD_16KM, defaultPlateTerrain(42));
    const c = new PlateHeights(FLAT_WORLD_16KM, defaultPlateTerrain(43));
    expect(b.elevation).toEqual(a.elevation);
    expect(c.elevation).not.toEqual(a.elevation);
  });

  it('samples with a stride exactly like single columns', () => {
    const p = plates();
    for (const step of [1, 7, 512]) {
      const H = p.heights(100_000, 90_000, 6, 6, step);
      for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
        expect(H[i + 6 * j]).toBe(p.heights(100_000 + i * step, 90_000 + j * step, 1, 1)[0]);
      }
    }
  });

  it('wraps seamlessly east-west on a round world', () => {
    const p = plates({}, ROUND_WORLD_16x8KM);
    const W = ROUND_WORLD_16x8KM.widthUnits;
    for (const z of [5_000, 60_000, 120_000]) {
      // One query across the seam equals two queries on either side of it.
      expect(p.heights(W - 40, z, 80, 3)).toEqual(straddle(p, W, z));
      // And x = W is the same place as x = 0.
      expect(p.heights(W, z, 16, 2)).toEqual(p.heights(0, z, 16, 2));
    }
  });

  it('assigns sand at the shore, snow on peaks, rock high up, grass on lowland', () => {
    const p = plates();
    const probe = (h: number) => p.materials(100_000, 100_000, 1, 1, 1, Int32Array.of(h))[0];
    expect(probe(-500)).toBe(Material.Sand);
    expect(probe(16)).toBe(Material.Sand);
    expect(probe(240 * 16)).toBe(Material.Snow);
    expect(probe(190 * 16)).toBe(Material.Stone);
    // Lowland grass somewhere flat: find a low land cell with gentle slope.
    const H = p.heights(0, 0, 500, 500, 512);
    const M = p.materials(0, 0, 500, 500, 512, H);
    expect([...M].filter((m, k) => m === Material.Grass && H[k]! > 64 && H[k]! < 60 * 16).length).toBeGreaterThan(100);
  });
});

/** Heights for 80 columns straddling the seam at x = W, over 3 rows, built from two separate queries. */
function straddle(p: PlateHeights, W: number, z: number): Int32Array {
  const out = new Int32Array(80 * 3);
  const left = p.heights(W - 40, z, 40, 3);
  const right = p.heights(0, z, 40, 3);
  for (let j = 0; j < 3; j++) {
    out.set(left.subarray(40 * j, 40 * j + 40), 80 * j);
    out.set(right.subarray(40 * j, 40 * j + 40), 80 * j + 40);
  }
  return out;
}

describe('TerrainGenerator on plate heights', () => {
  it('never exposes dirt, and puts sand on beaches', () => {
    const p = plates();
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, p);
    // Find a coastal chunk column from the coarse grid: a land cell next to the sea.
    let found: { cx: number; cz: number } | null = null;
    for (let r = 10; r < p.rows - 10 && !found; r++) {
      for (let c = 10; c < p.cols - 10 && !found; c++) {
        const i = c + p.cols * r;
        if (p.elevation[i]! > 48 && p.elevation[i + 1]! < -48) {
          found = { cx: Math.floor(((c + 1) * PLATE_CELL) / CHUNK_SIZE), cz: Math.floor(((r + 0.5) * PLATE_CELL) / CHUNK_SIZE) };
        }
      }
    }
    expect(found).not.toBeNull();
    const { cx, cz } = found!;
    const r = gen.columnRange(cx, cz);
    const chunks = new Map<number, Chunk>();
    for (let cy = Math.floor(r.minY / CHUNK_SIZE) - 1; cy <= Math.floor(r.maxY / CHUNK_SIZE) + 1; cy++) chunks.set(cy, gen.generateChunk({ cx, cy, cz }));
    const at = (x: number, y: number, z: number) => {
      const c = chunks.get(Math.floor(y / CHUNK_SIZE));
      return c ? voxelAt(c, x, ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, z) : null;
    };
    const exposed = new Map<number, number>();
    for (let z = 0; z < CHUNK_SIZE; z += 4) for (let x = 0; x < CHUNK_SIZE; x += 4) {
      for (let y = r.maxY + 32; y >= r.minY - 64; y--) {
        const v = at(x, y, z);
        if (!v) continue;
        exposed.set(v.material, (exposed.get(v.material) ?? 0) + 1);
        break;
      }
    }
    expect(exposed.has(Material.Dirt)).toBe(false);
    expect(exposed.get(Material.Sand) ?? 0).toBeGreaterThan(0);
  });
});
