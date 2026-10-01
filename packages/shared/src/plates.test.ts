import { describe, expect, it } from 'vitest';
import { voxelAt, type Chunk } from './chunk.js';
import { Material } from './materials.js';
import { PLATE_CELL, PlateHeights, defaultPlateTerrain, validatePlateTerrain, type PlateTerrainConfig } from './plates.js';
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
    expect(() => validatePlateTerrain({ ...ok, plateSizeRatio: 0.5 })).toThrow(/plateSizeRatio/);
    expect(() => validatePlateTerrain({ ...ok, landPercent: 101 })).toThrow(/landPercent/);
    expect(() => validatePlateTerrain({ ...ok, shoreFractal: -1 })).toThrow(/shoreFractal/);
    expect(() => validatePlateTerrain({ ...ok, noiseScale: 50 })).toThrow(/noiseScale/);
    expect(() => validatePlateTerrain({ ...ok, noiseRoughness: 101 })).toThrow(/noiseRoughness/);
    expect(() => validatePlateTerrain({ ...ok, maxHeight: 1001 })).toThrow(/maxHeight/);
    expect(() => validatePlateTerrain({ ...ok, terrainSeed: 1.5 })).toThrow(/terrainSeed/);
    expect(() => validatePlateTerrain({ ...ok, islandArcs: 101 })).toThrow(/islandArcs/);
    expect(() => validatePlateTerrain({ ...ok, hotspots: 41 })).toThrow(/hotspots/);
    expect(() => validatePlateTerrain({ ...ok, hotspots: 2.5 })).toThrow(/hotspots/);
    expect(() => validatePlateTerrain({ ...ok, islandMinSize: 20 })).toThrow(/islandMinSize/);
    expect(() => validatePlateTerrain({ ...ok, islandMinSize: 900, islandMaxSize: 800 })).toThrow(/islandMinSize/);
    // The sea must lie strictly between the lowest and highest ground.
    expect(() => validatePlateTerrain({ ...ok, seaLevel: 300 })).toThrow(/maxHeight/);
    expect(() => validatePlateTerrain({ ...ok, seaLevel: -300 })).toThrow(/minHeight/);
    expect(() => validatePlateTerrain({ ...ok, minHeight: 10, seaLevel: 20, maxHeight: 30 })).not.toThrow();
  });
});

const areas = (p: PlateHeights) => {
  const a = new Array<number>(p.plates.length).fill(0);
  for (const k of p.plateOf) a[k]!++;
  return a;
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

describe('PlateHeights', () => {
  it('defaults to 7 major and 15 minor plates, 6:1, -300..300 m, sea at 0, 30% land', () => {
    expect(defaultPlateTerrain(5)).toMatchObject({
      seed: 5, terrainSeed: 5, majorPlates: 7, minorPlates: 15, plateSizeRatio: 6,
      minHeight: -300, maxHeight: 300, seaLevel: 0, landPercent: 30,
    });
  });

  it('creates the configured number of major and minor plates, none squeezed out', () => {
    const p = plates({ majorPlates: 5, minorPlates: 9 });
    expect(p.plates).toHaveLength(14);
    expect(p.plates.filter((q) => q.major)).toHaveLength(5);
    expect(areas(p).every((a) => a > 0)).toBe(true);
  });

  it('sizes major plates plateSizeRatio times the minor ones', () => {
    for (const plateSizeRatio of [1, 6, 20]) {
      const p = plates({ plateSizeRatio });
      const a = areas(p);
      const major = a.filter((_, k) => p.plates[k]!.major), minor = a.filter((_, k) => !p.plates[k]!.major);
      expect(mean(major) / mean(minor)).toBeCloseTo(plateSizeRatio, 0);
      // Individual plates, not just the averages: each within 15% of its share.
      for (const m of minor) expect(Math.abs(m / mean(minor) - 1)).toBeLessThan(0.15);
      for (const m of major) expect(Math.abs(m / mean(major) - 1)).toBeLessThan(0.15);
    }
  });

  it('puts exactly the configured share of the world above the sea', () => {
    for (const landPercent of [0, 30, 50, 70, 100]) {
      expect(plates({ landPercent }).landFraction()).toBeCloseTo(landPercent / 100, 2);
    }
    // Also with the sea somewhere other than 0.
    expect(plates({ seaLevel: 40, landPercent: 45 }).landFraction()).toBeCloseTo(0.45, 2);
  });

  it('makes coastlines more ragged as shoreline fractalization rises', () => {
    const smooth = coastCells(plates({ shoreFractal: 0 }));
    const some = coastCells(plates({ shoreFractal: 50 }));
    const ragged = coastCells(plates({ shoreFractal: 100 }));
    expect(some).toBeGreaterThan(smooth * 1.2);
    expect(ragged).toBeGreaterThan(some * 1.1);
  });

  it('keeps most land clear of the beach at every fractalization', () => {
    for (const shoreFractal of [0, 50, 100]) {
      const p = plates({ shoreFractal });
      let land = 0, raised = 0;
      for (const h of p.elevation) {
        if (h <= 0) continue;
        land++;
        if (h > 5 * 16) raised++;
      }
      expect(raised / land).toBeGreaterThan(0.7);
    }
  });

  it('stretches the terrain to exactly the configured lowest and highest ground', () => {
    for (const [minHeight, seaLevel, maxHeight] of [[-300, 0, 300], [-80, 20, 450], [100, 150, 200]] as const) {
      const p = plates({ minHeight, seaLevel, maxHeight });
      let lo = Infinity, hi = -Infinity;
      for (const h of p.elevation) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
      expect(lo).toBe(minHeight * 16);
      expect(hi).toBe(maxHeight * 16);
      expect(p.seaLevel).toBe(seaLevel * 16);
      // Sampled heights, detail included, never leave the range.
      const H = p.heights(0, 0, 500, 500, 512);
      for (const h of H) {
        expect(h).toBeGreaterThanOrEqual(minHeight * 16);
        expect(h).toBeLessThanOrEqual(maxHeight * 16);
      }
    }
  });

  it('keeps land above and sea floor below the sea level', () => {
    const p = plates({ seaLevel: 40 });
    for (const h of p.elevation) expect(h === p.seaLevel).toBe(false);
  });

  it('has no cliffs at the default settings', () => {
    // No step between neighbouring 32 m cells steeper than slope 0.8 on land.
    const p = plates();
    let steepest = 0;
    for (let r = 1; r < p.rows - 1; r++) for (let c = 1; c < p.cols - 1; c++) {
      const i = c + p.cols * r;
      if (p.elevation[i]! <= 0) continue;
      steepest = Math.max(steepest, Math.abs(p.elevation[i + 1]! - p.elevation[i]!) / PLATE_CELL, Math.abs(p.elevation[i + p.cols]! - p.elevation[i]!) / PLATE_CELL);
    }
    expect(steepest).toBeLessThan(0.8);
  });

  it('blends neighbouring plates at their seams (no steps along borders)', () => {
    // Height steps across plate borders are no larger than steps inside plates.
    const p = plates({ landPercent: 60 });
    const across: number[] = [], within: number[] = [];
    for (let r = 1; r < p.rows - 1; r++) for (let c = 1; c < p.cols - 1; c++) {
      const i = c + p.cols * r;
      if (p.elevation[i]! <= 0 || p.elevation[i + 1]! <= 0) continue;
      (p.plateOf[i] !== p.plateOf[i + 1] ? across : within).push(Math.abs(p.elevation[i + 1]! - p.elevation[i]!));
    }
    expect(across.length).toBeGreaterThan(100);
    expect(mean(across)).toBeLessThan(mean(within) * 1.5);
  });

  it('rerolls relief with terrainSeed but keeps the plate layout', () => {
    const a = plates({ terrainSeed: 1 });
    const b = plates({ terrainSeed: 2 });
    expect(b.plateOf).toEqual(a.plateOf);
    expect(b.elevation).not.toEqual(a.elevation);
    // A different layout seed moves the plates.
    expect(plates({ seed: 2, terrainSeed: 1 }).plateOf).not.toEqual(a.plateOf);
  });

  it('makes finer relief with smaller noise features and more roughness', () => {
    // Mean absolute curvature (second difference) along rows of land cells: small features
    // raise it, while the steady rise inland from the coast barely does.
    const curvature = (p: PlateHeights) => {
      const e = p.elevation, s: number[] = [];
      for (let i = 1; i < e.length - 1; i++) if (e[i - 1]! > 0 && e[i]! > 0 && e[i + 1]! > 0) s.push(Math.abs(e[i - 1]! - 2 * e[i]! + e[i + 1]!));
      return mean(s);
    };
    const at = (over: Partial<PlateTerrainConfig>) => curvature(plates({ landPercent: 60, ...over }));
    expect(at({ noiseScale: 500 })).toBeGreaterThan(at({ noiseScale: 8000 }) * 1.5);
    expect(at({ noiseRoughness: 100 })).toBeGreaterThan(at({ noiseRoughness: 0 }) * 1.5);
  });

  it('fills in small lakes away from the sea (they would be craters), keeping coastal ones', () => {
    // All water sits at sea level and land rises with distance from water, so an inland pond
    // would be a hole in a crater. Every water body under ~1 km^2 must be near open sea.
    for (const over of [{}, { shoreFractal: 100, landPercent: 55 }, { islandArcs: 100, hotspots: 20 }, { islandArcs: 70, hotspots: 10 }, { islandArcs: 70, hotspots: 10, seed: 4 }]) {
      const p = plates(over);
      const n = p.elevation.length, body = new Int32Array(n).fill(-1);
      const bodies: number[][] = [];
      for (let s = 0; s < n; s++) {
        if (body[s] !== -1 || p.elevation[s]! > p.seaLevel) continue;
        const cells: number[] = [];
        const stack = [s];
        body[s] = bodies.length;
        while (stack.length) {
          const i = stack.pop()!;
          cells.push(i);
          const c = i % p.cols;
          for (const j of [i - 1, i + 1, i - p.cols, i + p.cols]) {
            if (j >= 0 && j < n && body[j] === -1 && p.elevation[j]! <= p.seaLevel && Math.abs((j % p.cols) - c) <= 1) {
              body[j] = bodies.length;
              stack.push(j);
            }
          }
        }
        bodies.push(cells);
      }
      const R = Math.ceil((700 * 16) / PLATE_CELL);
      for (const cells of bodies) {
        if (cells.length >= 1000) continue;
        // Some cell of open sea within ~700 m of the lake.
        const nearSea = cells.some((i) => {
          const c = i % p.cols, r = (i - c) / p.cols;
          for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
            const cc = c + a, rr = r + b;
            if (cc < 0 || rr < 0 || cc >= p.cols || rr >= p.rows || Math.hypot(a, b) > R) continue;
            const j = cc + p.cols * rr;
            if (body[j]! >= 0 && bodies[body[j]!]!.length >= 1000) return true;
          }
          return false;
        });
        expect(nearSea).toBe(true);
      }
    }
    // Coastal lagoons and inlets survive: a ragged coast still has small water bodies.
    const ragged = plates({ shoreFractal: 100 });
    let lagoons = 0;
    const seen = new Uint8Array(ragged.elevation.length);
    for (let s = 0; s < seen.length; s++) {
      if (seen[s] || ragged.elevation[s]! > 0) continue;
      let size = 0;
      const st = [s];
      seen[s] = 1;
      while (st.length) {
        const i = st.pop()!;
        size++;
        const c = i % ragged.cols;
        for (const j of [i - 1, i + 1, i - ragged.cols, i + ragged.cols]) {
          if (j >= 0 && j < seen.length && !seen[j] && ragged.elevation[j]! <= 0 && Math.abs((j % ragged.cols) - c) <= 1) {
            seen[j] = 1;
            st.push(j);
          }
        }
      }
      if (size < 1000) lagoons++;
    }
    expect(lagoons).toBeGreaterThan(10);
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

  it('assigns sand at the shore, snow on the heights, rock high up, grass on lowland', () => {
    const p = plates({ seaLevel: 20 });
    const sea = 20 * 16, top = 300 * 16;
    const probe = (h: number) => p.materials(100_000, 100_000, 1, 1, 1, Int32Array.of(h))[0];
    expect(probe(sea - 500)).toBe(Material.Sand);
    expect(probe(sea + 16)).toBe(Material.Sand);
    expect(probe(Math.ceil(sea + (top - sea) * 0.85))).toBe(Material.Snow);
    expect(probe(Math.ceil(sea + (top - sea) * 0.7))).toBe(Material.Stone);
    const H = p.heights(0, 0, 500, 500, 512);
    const M = p.materials(0, 0, 500, 500, 512, H);
    expect([...M].filter((m, k) => m === Material.Grass && H[k]! > sea + 64 && H[k]! < sea + 100 * 16).length).toBeGreaterThan(100);
  });
});

describe('islands', () => {
  it('adds none by default', () => {
    const p = plates();
    expect(p.islands).toHaveLength(0);
    expect(p.islandCells).toBe(0);
  });

  it('keeps land exact with islands', () => {
    for (const over of [{ islandArcs: 60, hotspots: 8 }, { islandArcs: 100, hotspots: 40 }, { islandArcs: 100, hotspots: 40, landPercent: 10 }]) {
      const p = plates(over);
      expect(p.islands.length).toBeGreaterThan(0);
      expect(p.landFraction()).toBeCloseTo((over.landPercent ?? 30) / 100, 3);
      // Islands never take more than 90% of the land.
      expect(p.islandCells / p.elevation.length).toBeLessThanOrEqual(0.9 * (over.landPercent ?? 30) / 100 + 1e-9);
    }
  });

  it('makes more islands with more arcs and hotspots', () => {
    const count = (over: Partial<PlateTerrainConfig>, kind: 'arc' | 'hotspot') => plates(over).islands.filter((i) => i.kind === kind).length;
    expect(count({ islandArcs: 100 }, 'arc')).toBeGreaterThan(count({ islandArcs: 30 }, 'arc') * 1.5);
    expect(count({ islandArcs: 30 }, 'hotspot')).toBe(0);
    expect(count({ hotspots: 20 }, 'hotspot')).toBeGreaterThan(count({ hotspots: 5 }, 'hotspot') * 2);
    expect(count({ hotspots: 20 }, 'arc')).toBe(0);
  });

  it('sizes islands within the configured range', () => {
    for (const [islandMinSize, islandMaxSize] of [[200, 1500], [100, 300], [1000, 3000]] as const) {
      const p = plates({ islandArcs: 100, hotspots: 20, islandMinSize, islandMaxSize });
      expect(p.islands.length).toBeGreaterThan(0);
      for (const il of p.islands) {
        expect((il.radius * 2) / 16).toBeGreaterThanOrEqual(islandMinSize - 1e-6);
        expect((il.radius * 2) / 16).toBeLessThanOrEqual(islandMaxSize + 1e-6);
      }
    }
  });

  it('puts hotspots in oceanic plates and arcs on seams with an oceanic side', () => {
    const p = plates({ islandArcs: 100, hotspots: 20 });
    for (const il of p.islands.filter((i) => i.kind === 'hotspot')) expect(p.plates[p.plateAt(il.x, il.z)]!.continental).toBe(false);
    for (const il of p.islands.filter((i) => i.kind === 'arc')) {
      // A different plate within 2 cells of the centre, and one of the two plates oceanic.
      const here = p.plateAt(il.x, il.z);
      const near = new Set<number>();
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) near.add(p.plateAt(il.x + a * PLATE_CELL, il.z + b * PLATE_CELL));
      near.delete(here);
      expect(near.size).toBeGreaterThan(0);
      expect([here, ...near].some((k) => !p.plates[k]!.continental)).toBe(true);
    }
  });

  it('keeps islands off the continents and apart from each other', () => {
    const p = plates({ islandArcs: 100, hotspots: 20 });
    // Every island centre is land, surrounded by sea within a few radii (it's an island, not a cape).
    for (const il of p.islands) {
      expect(p.heights(il.x, il.z, 1, 1)[0]).toBeGreaterThan(p.seaLevel);
      let sea = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, d = il.radius * 2.5 + 400 * 16;
        if (p.heights(il.x + Math.cos(a) * d, Math.min(255_999, Math.max(0, il.z + Math.sin(a) * d)), 1, 1)[0]! <= p.seaLevel) sea++;
      }
      expect(sea).toBeGreaterThan(8);
    }
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
        if (p.elevation[i]! > 0 && p.elevation[i + 1]! < 0) {
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
