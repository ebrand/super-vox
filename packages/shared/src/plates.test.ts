import { describe, expect, it } from 'vitest';
import { voxelAt, type Chunk } from './chunk.js';
import { Material } from './materials.js';
import { PLATE_CELL, PlateHeights, defaultPlateTerrain, migratePlateTerrain, parsePlateTerrain, validatePlateTerrain, type PlateTerrainConfig } from './plates.js';
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
    expect(() => validatePlateTerrain({ ...ok, beaches: -1 })).toThrow(/beaches/);
    expect(() => validatePlateTerrain({ ...ok, snowAltitude: 2001 })).toThrow(/snowAltitude/);
    expect(() => validatePlateTerrain({ ...ok, plains: 101 })).toThrow(/plains/);
    expect(() => validatePlateTerrain({ ...ok, lowlandFlatness: -1 })).toThrow(/lowlandFlatness/);
    expect(() => validatePlateTerrain({ ...ok, surfaceRoughness: 101 })).toThrow(/surfaceRoughness/);
    expect(() => validatePlateTerrain({ ...ok, rockAltitude: -1 })).toThrow(/rockAltitude/);
    expect(() => validatePlateTerrain({ ...ok, rockSlope: 4 })).toThrow(/rockSlope/);
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

  it('puts sand under the water, snow on the heights, rock high up, grass on lowland', () => {
    const p = plates({ seaLevel: 20, rockSlope: 90 }); // height rules only
    const sea = 20 * 16;
    const probe = (h: number) => p.materials(100_000, 100_000, 1, 1, 1, Int32Array.of(h))[0];
    expect(probe(sea - 500)).toBe(Material.Sand);
    expect(probe(sea + 250 * 16)).toBe(Material.Snow);
    expect(probe(sea + 200 * 16)).toBe(Material.Stone);
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

/**
 * Every coast crossed by north-south lines through the world: the width (m) of sand above the
 * sea inland of the waterline, and the material right at it.
 */
function coasts(p: PlateHeights): { width: number; atWater: number }[] {
  const out: { width: number; atWater: number }[] = [];
  for (let xm = 300; xm < 16000; xm += 400) {
    const n = 8000, step = 32; // 2 m
    const H = p.heights(xm * 16, 0, 1, n, step), M = p.materials(xm * 16, 0, 1, n, step, H);
    for (let k = 1; k < n; k++) {
      if (!(H[k - 1]! <= p.seaLevel && H[k]! > p.seaLevel)) continue;
      let w = 0;
      while (k + w < n && H[k + w]! > p.seaLevel && M[k + w] === Material.Sand) w++;
      out.push({ width: w * 2, atWater: M[k]! });
    }
  }
  return out;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

describe('flat ground', () => {
  const degrees = (p: PlateHeights, i: number) => {
    const e = p.elevation, C = p.cols;
    return (Math.atan(Math.hypot(e[i + 1]! - e[i - 1]!, e[i + C]! - e[i - C]!) / (2 * PLATE_CELL)) * 180) / Math.PI;
  };
  const landCells = (p: PlateHeights) => {
    const out: number[] = [];
    for (let r = 1; r < p.rows - 1; r++) for (let c = 1; c < p.cols - 1; c++) if (p.elevation[c + p.cols * r]! > p.seaLevel) out.push(c + p.cols * r);
    return out;
  };
  /** Whether the ground in the 16 m square at grid cell i varies by at most 1 m (sampled every metre). */
  const buildable = (p: PlateHeights, i: number) => {
    const c = i % p.cols, r = (i - c) / p.cols;
    const H = p.heights(c * PLATE_CELL, r * PLATE_CELL, 16, 16, 16);
    return Math.max(...H) - Math.min(...H) <= 16;
  };

  it('has no plains by default', () => {
    expect(plates().plainness.every((v) => v === 0)).toBe(true);
  });

  it('turns about the configured share of the land into plains, keeping land and height exact', () => {
    for (const plainsPct of [30, 60]) {
      const p = plates({ plains: plainsPct });
      const land = landCells(p);
      const share = land.filter((i) => p.plainness[i]! >= 0.5).length / land.length;
      expect(share).toBeCloseTo(plainsPct / 100, 1);
      expect(p.landFraction()).toBeCloseTo(0.3, 3);
      expect(p.elevation.reduce((a, b) => Math.max(a, b))).toBe(300 * 16);
    }
  });

  it('makes plains flat enough to build on', () => {
    const p = plates({ plains: 60 });
    const inner = landCells(p).filter((i, k) => k % 37 === 0 && p.plainness[i]! > 0.95 && p.elevation[i]! > p.seaLevel + 32);
    expect(inner.length).toBeGreaterThan(50);
    expect(inner.filter((i) => buildable(p, i)).length / inner.length).toBeGreaterThan(0.75);
    // Hilly default land mostly isn't.
    const q = plates();
    const hills = landCells(q).filter((i, k) => k % 37 === 0 && q.elevation[i]! > q.seaLevel + 32);
    expect(hills.filter((i) => buildable(q, i)).length / hills.length).toBeLessThan(0.1);
  });

  it('blends plains into the hills without cliffs', () => {
    const steepest = (p: PlateHeights) => landCells(p).reduce((m, i) => Math.max(m, degrees(p, i)), 0);
    expect(steepest(plates({ plains: 40 }))).toBeLessThanOrEqual(steepest(plates()) + 1);
  });

  it('flattens lowlands with lowland flatness, keeping the peak height', () => {
    const median = (p: PlateHeights) => {
      const d = landCells(p).map((i) => degrees(p, i)).sort((a, b) => a - b);
      return d[d.length >> 1]!;
    };
    const flat = plates({ lowlandFlatness: 100 });
    expect(median(flat)).toBeLessThan(median(plates()) / 2);
    expect(flat.elevation.reduce((a, b) => Math.max(a, b))).toBe(300 * 16);
    expect(flat.landFraction()).toBeCloseTo(0.3, 3);
  });

  it('scales small-scale bumpiness with surface roughness (0: none)', () => {
    // Bumpiness: mean absolute second difference along rows of 1 m columns on land (the
    // ground's overall slope cancels out; only bumps remain).
    const bumps = (surfaceRoughness: number) => {
      const p = plates({ surfaceRoughness });
      let sum = 0, n = 0;
      for (const i of landCells(p).filter((_, k) => k % 97 === 0)) {
        const c = i % p.cols, r = (i - c) / p.cols;
        const H = p.heights(c * PLATE_CELL, r * PLATE_CELL, 32, 1, 16);
        for (let k = 1; k < 31; k++) sum += Math.abs(H[k - 1]! - 2 * H[k]! + H[k + 1]!), n++;
      }
      return sum / n;
    };
    const b0 = bumps(0), b50 = bumps(50), b100 = bumps(100);
    expect(b50).toBeGreaterThan(b0 * 1.3);
    expect(b100).toBeGreaterThan(b50 * 1.3);
    // At 0 the ground is exactly the interpolated grid: at a grid cell's centre, its own height.
    const p = plates({ surfaceRoughness: 0 });
    const i = landCells(p)[1234]!, c = i % p.cols, r = (i - c) / p.cols;
    expect(p.heights((c + 0.5) * PLATE_CELL - 0.5, (r + 0.5) * PLATE_CELL - 0.5, 1, 1)[0]).toBe(Math.round(p.elevation[i]!));
  });
});

describe('rock and snow', () => {
  /** The material at a point for ground `metres` above the sea, ignoring steepness. */
  const at = (over: Partial<PlateTerrainConfig>, metres: number) => {
    const p = plates({ rockSlope: 90, ...over });
    return p.materials(128_000, 128_000, 1, 1, 1, Int32Array.of(p.seaLevel + metres * 16))[0];
  };

  it('puts rock and snow at fixed heights above the sea, whatever the height range', () => {
    expect(at({}, 170)).toBe(Material.Grass);
    expect(at({}, 190)).toBe(Material.Stone);
    expect(at({}, 250)).toBe(Material.Snow);
    // Same heights in a world reaching 600 m; and measured from the sea, wherever it is.
    expect(at({ maxHeight: 600 }, 250)).toBe(Material.Snow);
    expect(at({ seaLevel: 50, maxHeight: 400 }, 190)).toBe(Material.Stone);
    expect(at({ seaLevel: 50, maxHeight: 400 }, 170)).toBe(Material.Grass);
    // Configurable; with rock at or above the snow there's no rock band.
    expect(at({ rockAltitude: 60, snowAltitude: 90 }, 70)).toBe(Material.Stone);
    expect(at({ rockAltitude: 300, snowAltitude: 240 }, 250)).toBe(Material.Snow);
    expect(at({ rockAltitude: 300, snowAltitude: 240 }, 230)).toBe(Material.Grass);
  });

  it('leaves low worlds without snow or high-ground rock', () => {
    const p = plates({ maxHeight: 100 });
    const H = p.heights(0, 0, 500, 500, 512), M = p.materials(0, 0, 500, 500, 512, H);
    expect([...M].some((m) => m === Material.Snow)).toBe(false);
    // The default world does have snow.
    const q = plates();
    const Q = q.materials(0, 0, 500, 500, 512, q.heights(0, 0, 500, 500, 512));
    expect([...Q].some((m) => m === Material.Snow)).toBe(true);
  });

  it('bares steep ground, even above the snow line', () => {
    // A grid cell whose slope (as materials measures it: one cell either side) is over 30 degrees.
    const p = plates({ maxHeight: 600 });
    const e = p.elevation, C = p.cols;
    let cell = -1;
    for (let i = C + 1; i < e.length - C - 1 && cell < 0; i++) {
      const deg = (Math.atan(Math.hypot(e[i + 1]! - e[i - 1]!, e[i + C]! - e[i - C]!) / (2 * PLATE_CELL)) * 180) / Math.PI;
      if (deg > 30 && e[i]! > p.seaLevel + 100 * 16) cell = i;
    }
    expect(cell).toBeGreaterThanOrEqual(0);
    const x = ((cell % C) + 0.5) * PLATE_CELL, z = (Math.floor(cell / C) + 0.5) * PLATE_CELL;
    const probe = (rockSlope: number, metres: number) => plates({ maxHeight: 600, rockSlope }).materials(x, z, 1, 1, 1, Int32Array.of(p.seaLevel + metres * 16))[0];
    expect(probe(25, 300)).toBe(Material.Stone); // steep, above the snow line: rock
    expect(probe(25, 100)).toBe(Material.Stone); // steep, low: rock
    expect(probe(90, 300)).toBe(Material.Snow);
    expect(probe(90, 100)).toBe(Material.Grass);
  });

  it('bares more ground as the rock slope falls', () => {
    const stone = (rockSlope: number) => {
      const p = plates({ maxHeight: 600, rockSlope });
      const M = p.materials(0, 0, 500, 500, 512, p.heights(0, 0, 500, 500, 512));
      return [...M].filter((m) => m === Material.Stone).length;
    };
    expect(stone(20)).toBeGreaterThan(stone(30) * 1.3);
    expect(stone(30)).toBeGreaterThan(stone(90));
  });
});

describe('migratePlateTerrain', () => {
  it('keeps older worlds looking as they did', () => {
    // Saved before land/rock/snow settings: water share, rock at 60% and snow at 80% of the
    // land's range (here 100 m above a sea at 0), rock above slope 0.9.
    const old = { seed: 4, majorPlates: 5, waterPercent: 65, maxHeight: 100 };
    expect(migratePlateTerrain(old)).toMatchObject({ seed: 4, majorPlates: 5, landPercent: 35, rockAltitude: 60, snowAltitude: 80, rockSlope: 42 });
    // A rock line saved as a percentage converts too.
    expect(migratePlateTerrain({ maxHeight: 300, seaLevel: 100, rockLine: 50 }).rockAltitude).toBe(100);
    // New settings are kept as they are.
    expect(migratePlateTerrain(defaultPlateTerrain(2))).toEqual(defaultPlateTerrain(2));
  });

  it('is not used for new settings: missing ones there take the defaults', () => {
    expect(parsePlateTerrain({ maxHeight: 100 })).toMatchObject({ snowAltitude: 240, rockAltitude: 180, rockSlope: 25 });
  });
});

describe('beaches', () => {
  it('puts no sand above the water at 0', () => {
    const p = plates({ beaches: 0 });
    const H = p.heights(0, 0, 500, 500, 512), M = p.materials(0, 0, 500, 500, 512, H);
    for (let k = 0; k < H.length; k++) if (M[k] === Material.Sand) expect(H[k]).toBeLessThanOrEqual(p.seaLevel);
  });

  it('widens beaches as the setting rises: tens of metres by default', () => {
    const w50 = coasts(plates({ beaches: 50 })).map((c) => c.width);
    const w100 = coasts(plates({ beaches: 100 })).map((c) => c.width);
    expect(w50.length).toBeGreaterThan(20);
    expect(median(w50)).toBeGreaterThanOrEqual(20);
    expect(median(w50)).toBeLessThanOrEqual(80);
    expect(median(w100)).toBeGreaterThan(median(w50) * 1.3);
  });

  it('gives steep coasts narrower beaches and bare rock at the water', () => {
    const gentle = coasts(plates({ beaches: 50 }));
    const steep = coasts(plates({ beaches: 50, maxHeight: 600 }));
    expect(median(steep.map((c) => c.width))).toBeLessThan(median(gentle.map((c) => c.width)) / 2);
    expect(steep.some((c) => c.atWater === Material.Stone)).toBe(true);
    // Coastal rock is only a band at the waterline: below the rock altitude, stone elsewhere is
    // steep ground (over the 25 degree rock slope; slopes here are estimated from sampled heights,
    // which include small-scale roughness, so allow some margin).
    const p = plates({ beaches: 50, maxHeight: 600 });
    const H = p.heights(0, 0, 500, 500, 512), M = p.materials(0, 0, 500, 500, 512, H);
    let checked = 0;
    for (let k = 0; k < H.length; k++) {
      if (M[k] !== Material.Stone || H[k]! >= p.seaLevel + 180 * 16) continue;
      if (Math.abs(H[k]! - p.seaLevel) > 4 * 16) {
        const x = (k % 500) * 512, z = Math.floor(k / 500) * 512;
        const e = (a: number, b: number) => p.heights(a, b, 1, 1)[0]!;
        expect(Math.hypot(e(x + 512, z) - e(x - 512, z), e(x, z + 512) - e(x, z - 512)) / 1024).toBeGreaterThan(Math.tan((25 * Math.PI) / 180) * 0.75);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
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
