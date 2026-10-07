import { describe, expect, it } from 'vitest';
import { voxelAt, type Chunk } from './chunk.js';
import { Biome, BIOME_GROUND } from './biomes.js';
import { Material } from './materials.js';
import { PLATE_CELL, PlateHeights, PlateStageCache, SURFACE_SETTINGS, defaultPlateCounts, defaultPlateTerrain, migratePlateTerrain, parsePlateTerrain, validatePlateTerrain, type PlateTerrainConfig } from './plates.js';
import { TerrainGenerator } from './terrain.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from './world.js';

/** The default settings without geology: plain stone (these tests are about where bare rock is, not what it's made of). */
const plainTerrain = (...a: Parameters<typeof defaultPlateTerrain>) => ({ ...defaultPlateTerrain(...a), geology: 0 });

/** Bare rock, of any kind (see rockVariety). */
const isRock = (m: number | undefined) => m === Material.Stone || m === Material.Gravel || m === Material.DarkStone || m === Material.PaleStone || m === Material.MossyStone;

const cache = new Map<string, PlateHeights>();
/** A plate world with `over` settings; mountains, biomes, rivers and lakes are off unless asked for, so other features are tested alone. */
function plates(over: Partial<PlateTerrainConfig> = {}, world = FLAT_WORLD_16KM): PlateHeights {
  // (Climate as before equators: cold north, hot south.)
  const cfg = { ...plainTerrain(1), mountains: 0, biomes: 0, rivers: 0, lakes: 0, equator: 0, northTemperature: -6, southTemperature: 26, ...over };
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
    const ok = plainTerrain(1);
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
    expect(() => validatePlateTerrain({ ...ok, mountains: 101 })).toThrow(/mountains/);
    expect(() => validatePlateTerrain({ ...ok, mountainHeight: 250 })).toThrow(/mountainHeight/); // below maxHeight
    expect(() => validatePlateTerrain({ ...ok, mountainWidth: 100 })).toThrow(/mountainWidth/);
    expect(() => validatePlateTerrain({ ...ok, mountainRuggedness: 101 })).toThrow(/mountainRuggedness/);
    expect(() => validatePlateTerrain({ ...ok, mountainDetail: -1 })).toThrow(/mountainDetail/);
    expect(() => validatePlateTerrain({ ...ok, lowlandFlatness: -1 })).toThrow(/lowlandFlatness/);
    expect(() => validatePlateTerrain({ ...ok, surfaceRoughness: 101 })).toThrow(/surfaceRoughness/);
    expect(() => validatePlateTerrain({ ...ok, rockAltitude: -1 })).toThrow(/rockAltitude/);
    expect(() => validatePlateTerrain({ ...ok, rockSlope: 4 })).toThrow(/rockSlope/);
    expect(() => validatePlateTerrain({ ...ok, snowFractal: 101 })).toThrow(/snowFractal/);
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
    const a = new PlateHeights(FLAT_WORLD_16KM, plainTerrain(42));
    const b = new PlateHeights(FLAT_WORLD_16KM, plainTerrain(42));
    const c = new PlateHeights(FLAT_WORLD_16KM, plainTerrain(43));
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
    expect(isRock(probe(sea + 200 * 16))).toBe(true);
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

describe('mountains', () => {
  const peak = (p: PlateHeights) => p.elevation.reduce((a, b) => Math.max(a, b));
  /** Share of land cells above the hills' maximum height. */
  const mountainShare = (p: PlateHeights, maxHeight = 300) => {
    let land = 0, high = 0;
    for (const v of p.elevation) {
      if (v <= p.seaLevel) continue;
      land++;
      if (v > maxHeight * 16) high++;
    }
    return high / land;
  };

  it('are on by default for new worlds: 600 m peaks above 300 m hills', () => {
    expect(defaultPlateTerrain()).toMatchObject({ mountains: 50, mountainHeight: 600, maxHeight: 300 });
  });

  it('rise to exactly the mountain height, keeping the land share exact', () => {
    for (const mountainHeight of [400, 600, 900]) {
      const p = plates({ mountains: 50, mountainHeight });
      expect(peak(p)).toBe(mountainHeight * 16);
      expect(p.maxHeight).toBe(mountainHeight * 16);
      expect(p.landFraction()).toBeCloseTo(0.3, 3);
      expect(mountainShare(p)).toBeGreaterThan(0.02);
    }
    // Without them, nothing rises above the hills.
    expect(mountainShare(plates({ mountains: 0 }))).toBe(0);
    expect(peak(plates({ mountains: 0 }))).toBe(300 * 16);
  });

  it('stand in bands along colliding seams', () => {
    // Every cell well above the hills lies within its range's band: a continental range spans
    // half its width either side of the seam, a coastal range is set back half a width inland
    // (plus a sixth of a width of blur at the ends).
    const W = 2500;
    // (60% land: more continents, so several continent-continent collisions to check.)
    const p = plates({ mountains: 60, mountainWidth: W, landPercent: 60 });
    expect(p.collisions.filter((c) => c.kind === 'continental').length).toBeGreaterThan(2);
    expect(p.collisions.filter((c) => c.kind === 'coastal').length).toBeGreaterThan(2);
    const kindOf = new Map(p.collisions.map((c) => [c.plates.join(','), c.kind]));
    const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const reach = { continental: (W * (0.5 + 1 / 6) * 16) / PLATE_CELL + 2, coastal: (W * (0.95 + 1 / 6) * 16) / PLATE_CELL + 2 };
    const R = Math.ceil(reach.coastal);
    const inBand = (i: number) => {
      const c0 = i % p.cols, r0 = (i - c0) / p.cols;
      for (let r = Math.max(0, r0 - R); r <= Math.min(p.rows - 2, r0 + R); r++) {
        for (let c = Math.max(0, c0 - R); c <= Math.min(p.cols - 2, c0 + R); c++) {
          const j = c + p.cols * r, a = p.plateOf[j]!;
          for (const k of [j + 1, j + p.cols]) {
            if (p.plateOf[k] === a) continue;
            const kind = kindOf.get(pairKey(a, p.plateOf[k]!));
            if (kind && Math.hypot(c - c0, r - r0) <= reach[kind]) return true;
          }
        }
      }
      return false;
    };
    let checked = 0;
    for (let i = 0; i < p.elevation.length; i += 41) {
      if (p.elevation[i]! < 360 * 16) continue;
      expect(inBand(i)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // Without collisions, no plate pair is listed.
    expect(plates({ mountains: 0 }).collisions).toHaveLength(0);
  });

  it('cover more ground with more colliding seams and wider ranges', () => {
    expect(mountainShare(plates({ mountains: 90 }))).toBeGreaterThan(mountainShare(plates({ mountains: 20 })) * 1.3);
    expect(mountainShare(plates({ mountains: 50, mountainWidth: 6000 }))).toBeGreaterThan(mountainShare(plates({ mountains: 50, mountainWidth: 1500 })) * 1.3);
  });

  it('are more ridged with more ruggedness', () => {
    // Mean absolute curvature over mountain cells.
    const curvature = (mountainRuggedness: number) => {
      const p = plates({ mountains: 60, mountainRuggedness });
      const e = p.elevation;
      let sum = 0, n = 0;
      for (let i = 1; i < e.length - 1; i++) {
        if (e[i]! < 320 * 16 || e[i - 1]! < 320 * 16 || e[i + 1]! < 320 * 16) continue;
        sum += Math.abs(e[i - 1]! - 2 * e[i]! + e[i + 1]!);
        n++;
      }
      return sum / n;
    };
    expect(curvature(100)).toBeGreaterThan(curvature(0) * 1.3);
  });

  it('steepen coasts near coastal ranges (rocky shores), without cliffs', () => {
    // Land next to the sea (whatever its height) stays under 35 degrees; the first mountains
    // reached ~77.
    const coastMax = (p: PlateHeights) => {
      const e = p.elevation, C = p.cols;
      let m = 0;
      for (let r = 1; r < p.rows - 1; r++) for (let c = 1; c < C - 1; c++) {
        const i = c + C * r;
        if (e[i]! <= p.seaLevel || ![i - 1, i + 1, i - C, i + C].some((j) => e[j]! <= p.seaLevel)) continue;
        m = Math.max(m, (Math.atan(Math.hypot(e[i + 1]! - e[i - 1]!, e[i + C]! - e[i - C]!) / (2 * PLATE_CELL)) * 180) / Math.PI);
      }
      return m;
    };
    expect(coastMax(plates({ mountains: 90 }))).toBeLessThan(35);
    expect(coastMax(plates({ mountains: 90 }))).toBeGreaterThan(coastMax(plates({ mountains: 0 })));
    // Some coasts are now bare rock at the water at default heights; without mountains none are.
    expect(coasts(plates({ mountains: 90 })).some((c) => isRock(c.atWater))).toBe(true);
    expect(coasts(plates({ mountains: 0 })).some((c) => isRock(c.atWater))).toBe(false);
  });

  it('get gullies and crags on their sides with mountain detail, and nothing changes elsewhere', () => {
    // Relief beyond a fitted plane over 256 m squares on mountain ground, sampled every 2 m.
    const base = plates({ mountains: 60, mountainDetail: 0 });
    const cells: number[] = [];
    base.elevation.forEach((v, i) => {
      if (v > 400 * 16 && i % 97 === 0) cells.push(i);
    });
    expect(cells.length).toBeGreaterThan(10);
    const relief = (p: PlateHeights) => {
      let tot = 0;
      for (const i of cells) {
        const c = i % p.cols, r = (i - c) / p.cols, N = 64;
        const H = p.heights(c * PLATE_CELL, r * PLATE_CELL, N, N, 64);
        let sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxh = 0, szh = 0;
        for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
          const h = H[x + N * z]!;
          sx += x; sz += z; sh += h; sxx += x * x; szz += z * z; sxh += x * h; szh += z * h;
          expect(h).toBeLessThanOrEqual(p.maxHeight);
        }
        const n = N * N, mx = sx / n, mz = sz / n, mh = sh / n;
        const bx = (sxh / n - mx * mh) / (sxx / n - mx * mx), bz = (szh / n - mz * mh) / (szz / n - mz * mz);
        let v = 0;
        for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) v += (H[x + N * z]! - (mh + bx * (x - mx) + bz * (z - mz))) ** 2;
        tot += Math.sqrt(v / n);
      }
      return tot / cells.length;
    };
    const r0 = relief(base), r50 = relief(plates({ mountains: 60, mountainDetail: 50 })), r100 = relief(plates({ mountains: 60, mountainDetail: 100 }));
    expect(r50).toBeGreaterThan(r0 * 1.15);
    expect(r100).toBeGreaterThan(r50 * 1.25);
    // Away from mountains (and in worlds without them) the detail changes nothing.
    const lowland = plates({ mountains: 60, mountainDetail: 100 });
    const flatHere = base.elevation.findIndex((v, i) => v > 0 && v < 100 * 16 && i > 1000 && lowland.heights((i % 500) * PLATE_CELL, Math.floor(i / 500) * PLATE_CELL, 1, 1)[0] === base.heights((i % 500) * PLATE_CELL, Math.floor(i / 500) * PLATE_CELL, 1, 1)[0]);
    expect(flatHere).toBeGreaterThan(0);
    const none0 = plates({ mountains: 0, mountainDetail: 0 }), none100 = plates({ mountains: 0, mountainDetail: 100 });
    expect(none100.heights(0, 0, 300, 300, 853)).toEqual(none0.heights(0, 0, 300, 300, 853));
  });

  it('dig trenches off coastal ranges', () => {
    // The sea floor within ~1 km of land is deeper on average with colliding seams.
    const nearshoreDepth = (mountains: number) => {
      const p = plates({ mountains });
      const e = p.elevation, C = p.cols, R = 30;
      let sum = 0, n = 0;
      for (let r = R; r < p.rows - R; r += 3) for (let c = R; c < C - R; c += 3) {
        const i = c + C * r;
        if (e[i]! > p.seaLevel) continue;
        let nearLand = false;
        for (let b = -R; b <= R && !nearLand; b += 5) for (let a = -R; a <= R && !nearLand; a += 5) if (e[c + a + C * (r + b)]! > p.seaLevel) nearLand = true;
        if (nearLand) (sum += p.seaLevel - e[i]!), n++;
      }
      return sum / n;
    };
    expect(nearshoreDepth(100)).toBeGreaterThan(nearshoreDepth(0) * 1.05);
  });
});

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
    const p = plates({ surfaceRoughness: 0, rockRoughness: 0 });
    const i = landCells(p)[1234]!, c = i % p.cols, r = (i - c) / p.cols;
    expect(p.heights((c + 0.5) * PLATE_CELL - 0.5, (r + 0.5) * PLATE_CELL - 0.5, 1, 1)[0]).toBe(Math.round(p.elevation[i]!));
  });
});

describe('biomes', () => {
  /** Share of each biome over land samples, overall and in the north/south thirds of the world. */
  const mix = (over: Partial<PlateTerrainConfig>) => {
    const p = plates({ biomes: 1, ...over });
    const N = 250, H = p.heights(512, 512, N, N, 1024), B = p.biomes(512, 512, N, N, 1024, H)!;
    const all = new Array(8).fill(0), north = new Array(8).fill(0), south = new Array(8).fill(0);
    let land = 0, nLand = 0, sLand = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = i + N * j;
      if (H[k]! <= p.seaLevel) continue;
      land++; all[B[k]!]++;
      if (j < N / 3) (nLand++, north[B[k]!]++);
      if (j >= (2 * N) / 3) (sLand++, south[B[k]!]++);
    }
    const share = (a: number[], n: number) => a.map((c) => c / Math.max(1, n));
    return { all: share(all, land), north: share(north, nLand), south: share(south, sLand) };
  };
  const cold = (s: number[]) => s[Biome.Ice]! + s[Biome.Tundra]! + s[Biome.Boreal]!;
  const hot = (s: number[]) => s[Biome.Jungle]! + s[Biome.Savanna]! + s[Biome.Desert]!;

  it('are on by default and off for older worlds', () => {
    expect(defaultPlateTerrain().biomes).toBe(1);
    expect(migratePlateTerrain({}).biomes).toBe(0);
    const p = plates({ biomes: 0 });
    expect(p.biomes(0, 0, 4, 4, 512, new Int32Array(16))).toBeNull();
    expect(p.temperature).toBeNull();
  });

  it('run cold in the north and hot in the south', () => {
    // A world with land in both the north and south thirds.
    const m = mix({ seed: 9, landPercent: 50 });
    expect(cold(m.north)).toBeGreaterThan(cold(m.south) + 0.2);
    expect(hot(m.south)).toBeGreaterThan(hot(m.north));
    // Turning the whole world cold or hot moves everything.
    expect(cold(mix({ northTemperature: -15, southTemperature: 0 }).all)).toBeGreaterThan(0.9);
    expect(hot(mix({ northTemperature: 30, southTemperature: 38, rainfall: 50 }).all)).toBeGreaterThan(0.9);
  });

  it('dry out with less rain and green up with more', () => {
    const dry = mix({ seed: 4, rainfall: 15 }).all, wet = mix({ seed: 4, rainfall: 90 }).all;
    const arid = (s: number[]) => s[Biome.Desert]! + s[Biome.Grassland]! + s[Biome.Savanna]!;
    const forest = (s: number[]) => s[Biome.Jungle]! + s[Biome.Temperate]! + s[Biome.Boreal]!;
    expect(arid(dry)).toBeGreaterThan(arid(wet) + 0.3);
    expect(forest(wet)).toBeGreaterThan(forest(dry) + 0.3);
  });

  it('blend into ragged borders, and are sharp at biomeBlend 0 and in older worlds', () => {
    expect(defaultPlateTerrain().biomeBlend).toBe(50);
    expect(migratePlateTerrain({}).biomeBlend).toBe(0);
    expect(() => parsePlateTerrain({ biomeBlend: 101 })).toThrow(RangeError);
    // Border length: neighbouring samples (8 m apart) of different biomes, over 2 km of seed 9.
    const border = (biomeBlend: number) => {
      const p = plates({ seed: 9, terrainSeed: 9, biomes: 1, biomeBlend });
      const S = 256, x0 = 1000 * 16, z0 = 7000 * 16, H = p.heights(x0, z0, S, S, 128), B = p.biomes(x0, z0, S, S, 128, H)!;
      let n = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const k = i + S * j;
        if (i + 1 < S && B[k] !== B[k + 1]) n++;
        if (j + 1 < S && B[k] !== B[k + S]) n++;
      }
      return n;
    };
    const sharp = border(0);
    expect(sharp).toBeGreaterThan(300);
    expect(border(50)).toBeGreaterThan(sharp * 1.5);
  });

  it('get colder with height', () => {
    // Same column: the higher the ground, the colder its biome.
    const p = plates({ biomes: 1, mountains: 60, altitudeCooling: 3 });
    const at = (m: number) => p.biomes(128_000, 128_000, 1, 1, 1, Int32Array.of(p.seaLevel + m * 16))![0]!;
    const warmth = (b: number) => (b === Biome.Ice ? 0 : b === Biome.Tundra ? 1 : b === Biome.Boreal ? 2 : b === Biome.Temperate || b === Biome.Grassland ? 3 : 4);
    expect(warmth(at(600))).toBeLessThan(warmth(at(0)));
    expect(warmth(at(600))).toBeLessThanOrEqual(warmth(at(300)));
    expect(warmth(at(300))).toBeLessThanOrEqual(warmth(at(0)));
  });

  it('dry the lee of mountain ranges (rain shadow)', () => {
    // Moisture over land with and without mountains (same coasts, same noise): ranges only take away.
    const meanWet = (p: PlateHeights) => {
      let s = 0, n = 0;
      p.moisture!.forEach((v, i) => {
        if (p.elevation[i]! > p.seaLevel) (s += v), n++;
      });
      return s / n;
    };
    expect(meanWet(plates({ biomes: 1, mountains: 0 }))).toBeGreaterThan(meanWet(plates({ biomes: 1, mountains: 100 })) + 0.01);
    // And it depends on where the wind comes from.
    expect(plates({ biomes: 1, mountains: 100, windFrom: 90 }).moisture).not.toEqual(plates({ biomes: 1, mountains: 100, windFrom: 270 }).moisture);
  });

  it('give each biome its ground, and none where biomes are off', () => {
    const p = plates({ biomes: 1, seed: 4, rockSlope: 90, snowFractal: 0 });
    const N = 250, H = p.heights(512, 512, N, N, 1024);
    const M = p.materials(512, 512, N, N, 1024, H), B = p.biomes(512, 512, N, N, 1024, H)!;
    let checked = 0;
    for (let k = 0; k < H.length; k++) {
      const m = (H[k]! - p.seaLevel) / 16;
      if (m < 20 || m > 150) continue; // clear of beaches and rock/snow lines
      expect(M[k]).toBe(BIOME_GROUND[B[k]! as 0]);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    const off = plates({ seed: 4 });
    const Mo = off.materials(512, 512, N, N, 1024, off.heights(512, 512, N, N, 1024));
    expect([...Mo].some((m) => m > Material.Snow && !isRock(m))).toBe(false);
  });

  /** Land materials over the world, with each sample's height above the sea (m). */
  const landOf = (over: Partial<PlateTerrainConfig>) => {
    const p = plates({ biomes: 1, mountains: 60, rockSlope: 90, ...over });
    const N = 250, H = p.heights(512, 512, N, N, 1024), M = p.materials(512, 512, N, N, 1024, H);
    const out: { m: number; mat: number }[] = [];
    for (let k = 0; k < H.length; k++) if (H[k]! > p.seaLevel) out.push({ m: (H[k]! - p.seaLevel) / 16, mat: M[k]! });
    return out;
  };

  it('put snow and bare rock where it is cold, not at fixed heights (without altitudeSnow)', () => {
    // Temperature alone (worlds made before altitudeSnow and altitudeRock).
    const land = (over: Partial<PlateTerrainConfig>) => landOf({ altitudeSnow: 0, altitudeRock: 0, ...over });
    // A hot world: no snow even on 600 m peaks, and no rock band (ground beaches aside).
    const hot = land({ northTemperature: 26, southTemperature: 32 });
    expect(hot.some((x) => x.mat === Material.Snow)).toBe(false);
    expect(hot.filter((x) => isRock(x.mat) && x.m > 10).length).toBe(0);
    // A cold world: snow right down to the shore, and no bare rock on low ground (tundra there).
    const cold = land({ northTemperature: -14, southTemperature: -6 });
    expect(Math.min(...cold.filter((x) => x.mat === Material.Snow).map((x) => x.m))).toBeLessThan(20);
    expect(cold.filter((x) => isRock(x.mat) && x.m > 10 && x.m < 90).length).toBe(0);
    // A cool world: a band of bare rock below the snow on high ground, none on low ground (from
    // 100 m up, wandering 30 m either way at snowFractal 50).
    const cool = land({ northTemperature: -2, southTemperature: 10 });
    expect(cool.some((x) => isRock(x.mat) && x.m > 120)).toBe(true);
    expect(cool.filter((x) => isRock(x.mat) && x.m > 10 && x.m < 69).length).toBe(0);
    // The snow temperature moves the line; the fixed heights (biomes off only) don't.
    const snowShare = (over: Partial<PlateTerrainConfig>) => {
      const l = land({ northTemperature: -2, southTemperature: 10, ...over });
      return l.filter((x) => x.mat === Material.Snow).length / l.length;
    };
    expect(snowShare({ snowTemperature: 0 })).toBeGreaterThan(snowShare({ snowTemperature: -8 }) + 0.05);
    expect(snowShare({ snowAltitude: 50, rockAltitude: 20 })).toBe(snowShare({}));
  });

  it('with altitudeSnow, also put snow above the snow altitude however warm', () => {
    // A hot world: snow on the ground above the snow altitude, none below it (the line wanders
    // up to snowFractal's reach, 30 m at 50).
    const hot = landOf({ northTemperature: 26, southTemperature: 32, snowAltitude: 250 });
    const snow = hot.filter((x) => x.mat === Material.Snow);
    expect(snow.length).toBeGreaterThan(0);
    expect(Math.min(...snow.map((x) => x.m))).toBeGreaterThanOrEqual(250 - 31);
    expect(hot.filter((x) => x.m > 250 + 31 && x.mat !== Material.Snow).length).toBe(0);
    // Lower snow altitude, more snow; out of reach, the same as temperature alone.
    const share = (over: Partial<PlateTerrainConfig>) => {
      const l = landOf({ northTemperature: -2, southTemperature: 10, ...over });
      return l.filter((x) => x.mat === Material.Snow).length / l.length;
    };
    expect(share({ snowAltitude: 150 })).toBeGreaterThan(share({ snowAltitude: 400 }) + 0.05);
    expect(share({ snowAltitude: 2000 })).toBe(share({ altitudeSnow: 0 }));
  });

  it('with altitudeRock, also put bare rock above the rock altitude however warm', () => {
    // A hot world without snow: rock on all the ground above the rock altitude, none on the
    // land between the beaches and it (the line wandering 30 m either way at snowFractal 50).
    const hot = landOf({ northTemperature: 26, southTemperature: 32, snowAltitude: 2000, rockAltitude: 150 });
    expect(hot.filter((x) => x.m >= 181).length).toBeGreaterThan(0);
    expect(hot.filter((x) => x.m >= 181 && !isRock(x.mat)).length).toBe(0);
    expect(hot.filter((x) => x.m > 10 && x.m < 119 && isRock(x.mat)).length).toBe(0);
    // ...and between, some of each: not a contour line.
    const edge = hot.filter((x) => x.m > 125 && x.m < 175);
    expect(edge.some((x) => isRock(x.mat))).toBe(true);
    expect(edge.some((x) => !isRock(x.mat))).toBe(true);
    // Snow above it stays snow; out of reach, the same as temperature alone.
    const both = landOf({ northTemperature: 26, southTemperature: 32, snowAltitude: 250, rockAltitude: 150 });
    expect(both.filter((x) => x.m > 250 + 31 && x.mat !== Material.Snow).length).toBe(0);
    const mats = (over: Partial<PlateTerrainConfig>) => landOf({ northTemperature: -2, southTemperature: 10, ...over }).map((x) => x.mat);
    expect(mats({ rockAltitude: 2000 })).toEqual(mats({ altitudeRock: 0 }));
    expect(mats({ rockAltitude: 100 })).not.toEqual(mats({ altitudeRock: 0 }));
  });
});

describe('bare rock ground', () => {
  // A cool world: a band of bare rock on high ground, below the snow.
  const cool = (over: Partial<PlateTerrainConfig>) => plates({ biomes: 1, mountains: 60, rockSlope: 90, northTemperature: -2, southTemperature: 10, ...over });
  const N = 250, S = 1024;

  it('gets relief of its own with rockRoughness (outcrops, knolls), and only there', () => {
    const smooth = cool({ rockRoughness: 0 }), rough = cool({ rockRoughness: 100 });
    const Hs = smooth.heights(512, 512, N, N, S), Hr = rough.heights(512, 512, N, N, S);
    const Ms = smooth.materials(512, 512, N, N, S, Hs);
    let onRock = 0, moved = 0, lowMoved = 0, low = 0;
    for (let k = 0; k < Hs.length; k++) {
      const m = (Hs[k]! - smooth.seaLevel) / 16;
      if (isRock(Ms[k]) && m > 160) {
        onRock++;
        if (Math.abs(Hr[k]! - Hs[k]!) > 2 * 16) moved++;
      } else if (m > 5 && m < 40) {
        low++;
        if (Hr[k] !== Hs[k]) lowMoved++;
      }
    }
    expect(onRock).toBeGreaterThan(100);
    expect(moved / onRock).toBeGreaterThan(0.3);
    expect(low).toBeGreaterThan(1000);
    expect(lowMoved).toBe(0);
    // Bounded: at most its amplitude (24 m at 100).
    for (let k = 0; k < Hs.length; k++) expect(Math.abs(Hr[k]! - Hs[k]!)).toBeLessThanOrEqual(24 * 16 + 1);
  });

  it('comes in patches with rockVariety: gravel, pale and mossy stone, dark bands on steep faces; none at 0', () => {
    const count = (over: Partial<PlateTerrainConfig>) => {
      const p = cool(over);
      const M = p.materials(512, 512, N, N, S, p.heights(512, 512, N, N, S));
      const n = new Map<number, number>();
      let rock = 0;
      for (const m of M) if (isRock(m)) (rock++, n.set(m, (n.get(m) ?? 0) + 1));
      return { rock, share: (m: number) => (n.get(m) ?? 0) / rock };
    };
    const none = count({ rockVariety: 0 });
    expect(none.rock).toBeGreaterThan(100);
    expect(none.share(Material.Stone)).toBe(1);
    const some = count({ rockVariety: 50 }), lots = count({ rockVariety: 100 });
    for (const m of [Material.Gravel, Material.PaleStone]) {
      expect(some.share(m)).toBeGreaterThan(0.02);
      expect(lots.share(m)).toBeGreaterThan(some.share(m));
    }
    expect(some.share(Material.Stone)).toBeGreaterThan(0.25);
    expect(lots.share(Material.Stone)).toBeLessThan(some.share(Material.Stone));
    // (rockSlope 90: nothing counts as steep, so no dark bands.)
    expect(lots.share(Material.DarkStone)).toBe(0);
    const steep = count({ rockVariety: 100, rockSlope: 10 });
    expect(steep.share(Material.DarkStone)).toBeGreaterThan(0);
  });
});

describe('rock and snow', () => {
  /** The material at a point for ground `metres` above the sea, ignoring steepness (and the lines' wandering). */
  const at = (over: Partial<PlateTerrainConfig>, metres: number) => {
    const p = plates({ rockSlope: 90, snowFractal: 0, ...over });
    return p.materials(128_000, 128_000, 1, 1, 1, Int32Array.of(p.seaLevel + metres * 16))[0];
  };

  it('puts rock and snow at fixed heights above the sea, whatever the height range', () => {
    expect(at({}, 170)).toBe(Material.Grass);
    expect(isRock(at({}, 190))).toBe(true);
    expect(at({}, 250)).toBe(Material.Snow);
    // Same heights in a world reaching 600 m; and measured from the sea, wherever it is.
    expect(at({ maxHeight: 600 }, 250)).toBe(Material.Snow);
    expect(isRock(at({ seaLevel: 50, maxHeight: 400 }, 190))).toBe(true);
    expect(at({ seaLevel: 50, maxHeight: 400 }, 170)).toBe(Material.Grass);
    // Configurable; with rock at or above the snow there's no rock band.
    expect(isRock(at({ rockAltitude: 60, snowAltitude: 90 }, 70))).toBe(true);
    expect(at({ rockAltitude: 300, snowAltitude: 240 }, 250)).toBe(Material.Snow);
    expect(at({ rockAltitude: 300, snowAltitude: 240 }, 230)).toBe(Material.Grass);
  });

  it('makes the snow line ragged with snow fractal, within its reach of the line', () => {
    const sample = (snowFractal: number) => {
      const p = plates({ mountains: 60, snowFractal, rockSlope: 90 });
      const N = 500, H = p.heights(0, 0, N, N, 512), M = p.materials(0, 0, N, N, 512, H);
      let lowestSnow = Infinity, highestBare = -Infinity, edge = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = i + N * j, m = (H[k]! - p.seaLevel) / 16, snow = M[k] === Material.Snow;
        if (snow) lowestSnow = Math.min(lowestSnow, m);
        else if (H[k]! > p.seaLevel) highestBare = Math.max(highestBare, m);
        if (i + 1 < N && snow !== (M[k + 1] === Material.Snow)) edge++;
        if (j + 1 < N && snow !== (M[k + N] === Material.Snow)) edge++;
      }
      return { lowestSnow, highestBare, edge };
    };
    const flat = sample(0), half = sample(50), full = sample(100);
    // A plain contour at 240 m without it.
    expect(flat.lowestSnow).toBeGreaterThanOrEqual(240);
    expect(flat.highestBare).toBeLessThan(240);
    // Wandering up to 30 m (at 50) and 60 m (at 100) either way, and no further.
    expect(half.lowestSnow).toBeLessThan(230);
    expect(half.lowestSnow).toBeGreaterThanOrEqual(210);
    expect(half.highestBare).toBeGreaterThan(250);
    expect(half.highestBare).toBeLessThanOrEqual(270);
    expect(full.lowestSnow).toBeGreaterThanOrEqual(180);
    expect(full.highestBare).toBeLessThanOrEqual(300);
    expect(full.edge).toBeGreaterThan(half.edge);
    expect(half.edge).toBeGreaterThan(flat.edge);
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
    const probe = (rockSlope: number, metres: number) => plates({ maxHeight: 600, rockSlope, biomes: 0 }).materials(x, z, 1, 1, 1, Int32Array.of(p.seaLevel + metres * 16))[0];
    expect(isRock(probe(25, 300))).toBe(true); // steep, above the snow line: rock
    expect(isRock(probe(25, 100))).toBe(true); // steep, low: rock
    expect(probe(90, 300)).toBe(Material.Snow);
    expect(probe(90, 100)).toBe(Material.Grass);
  });

  it('bares more ground as the rock slope falls', () => {
    const stone = (rockSlope: number) => {
      const p = plates({ maxHeight: 600, rockSlope });
      const M = p.materials(0, 0, 500, 500, 512, p.heights(0, 0, 500, 500, 512));
      return [...M].filter((m) => isRock(m)).length;
    };
    expect(stone(20)).toBeGreaterThan(stone(30) * 1.3);
    expect(stone(30)).toBeGreaterThan(stone(90));
  });
});

describe('bigger worlds', () => {
  it('get more plates by default, growing a little slower than their area', () => {
    expect(defaultPlateCounts()).toEqual({ majorPlates: 7, minorPlates: 15 });
    expect(defaultPlateCounts(FLAT_WORLD_16KM)).toEqual({ majorPlates: 7, minorPlates: 15 });
    expect(defaultPlateCounts(ROUND_WORLD_16x8KM)).toEqual({ majorPlates: 7, minorPlates: 15 }); // never fewer
    const big = defaultPlateCounts({ ...ROUND_WORLD_16x8KM, widthUnits: 64_000 * 16, depthUnits: 32_000 * 16 });
    expect(big.majorPlates).toBeGreaterThan(20);
    expect(big.majorPlates).toBeLessThan(7 * 8); // not as many as the area alone would give
    expect(defaultPlateTerrain(1, { ...ROUND_WORLD_16x8KM, widthUnits: 64_000 * 16, depthUnits: 32_000 * 16 }).majorPlates).toBe(big.majorPlates);
  });
});

describe('migratePlateTerrain', () => {
  it('keeps older worlds looking as they did', () => {
    // Saved before land/rock/snow settings: water share, rock at 60% and snow at 80% of the
    // land's range (here 100 m above a sea at 0), rock above slope 0.9.
    const old = { seed: 4, majorPlates: 5, waterPercent: 65, maxHeight: 100 };
    expect(migratePlateTerrain(old)).toMatchObject({ seed: 4, majorPlates: 5, landPercent: 35, rockAltitude: 60, snowAltitude: 80, rockSlope: 42, snowFractal: 0, mountains: 0 });
    // The first plate worlds' mountainHeight (a peak height, here below maxHeight) is replaced.
    expect(migratePlateTerrain({ maxHeight: 300, mountainHeight: 150 })).toMatchObject({ mountains: 0, mountainHeight: 600 });
    expect(migratePlateTerrain({ maxHeight: 800 })).toMatchObject({ mountains: 0, mountainHeight: 800 });
    // A rock line saved as a percentage converts too.
    expect(migratePlateTerrain({ maxHeight: 300, seaLevel: 100, rockLine: 50 }).rockAltitude).toBe(100);
    // New settings are kept as they are.
    expect(migratePlateTerrain(plainTerrain(2))).toEqual(plainTerrain(2));
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
    expect(steep.some((c) => isRock(c.atWater))).toBe(true);
    // Coastal rock is only a band at the waterline: below the rock altitude, stone elsewhere is
    // steep ground (over the 25 degree rock slope; slopes here are estimated from sampled heights,
    // which include small-scale roughness, so allow some margin).
    const p = plates({ beaches: 50, maxHeight: 600 });
    const H = p.heights(0, 0, 500, 500, 512), M = p.materials(0, 0, 500, 500, 512, H);
    let checked = 0;
    for (let k = 0; k < H.length; k++) {
      if (!isRock(M[k]!) || H[k]! >= p.seaLevel + (180 - 31) * 16) continue; // (the rock altitude, wandering 30 m)
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

describe('surface settings', () => {
  it('change no stage of a build: a world built again with them changed reuses every one', () => {
    const base = plainTerrain(5);
    const changed: Partial<Record<keyof PlateTerrainConfig, number>> = {
      surfaceRoughness: 90, mountainDetail: 10, beaches: 80, rockAltitude: 60, altitudeRock: 0, snowAltitude: 90, altitudeSnow: 0, snowFractal: 10,
      rockRoughness: 90, rockVariety: 10, rockSlope: 50, altitudeCooling: 3, snowTemperature: 0, biomeBlend: 90, trees: 80, treeClumping: 10, geology: 1, treeStyle: 1,
    };
    expect(Object.keys(changed).sort()).toEqual([...SURFACE_SETTINGS].sort());
    const fresh = new PlateHeights(FLAT_WORLD_16KM, base);
    // (Trees by their shapes too: a tree style changes those, not how many there are.)
    const treeShapes = (p: PlateHeights) => p.trees(6000 * 16, 6000 * 16, 10_000 * 16, 10_000 * 16).map((t) => `${t.kind}:${t.blobs.length}:${t.limbs?.length ?? 0}`).join();
    const H0 = fresh.heights(0, 0, 256, 256, 1024), M0 = fresh.materials(0, 0, 256, 256, 1024, H0), T0 = treeShapes(fresh);
    for (const key of SURFACE_SETTINGS) {
      const cache = new PlateStageCache();
      new PlateHeights(FLAT_WORLD_16KM, base, cache);
      const before = cache.hits;
      const p = new PlateHeights(FLAT_WORLD_16KM, { ...base, [key]: changed[key] }, cache);
      expect(cache.hits - before, key).toBe(8);
      // ...and it does change the surface somewhere in the world (or it wouldn't be worth offering).
      const H = p.heights(0, 0, 256, 256, 1024), M = p.materials(0, 0, 256, 256, 1024, H);
      const differs = H.some((h, k) => h !== H0[k]) || M.some((m, k) => m !== M0[k]) || treeShapes(p) !== T0;
      // (Tree style changes jungle trees, none of which this temperate box has: see trees.test.ts.)
      if (key !== 'treeStyle') expect(differs, key).toBe(true);
    }
    // (Slow: a build per setting. Near 20 s alone, more under load.)
  }, 60_000);
});

describe('plate builds stay the same', () => {
  /** FNV-1a over a stage's value: arrays' bytes, everything else as JSON (keys sorted). */
  const fingerprint = (v: unknown) => {
    let h = 0x811c9dc5;
    const bytes = (b: Uint8Array) => {
      for (let k = 0; k < b.length; k++) h = Math.imul(h ^ b[k]!, 0x01000193);
    };
    const text = (t: string) => {
      for (let k = 0; k < t.length; k++) h = Math.imul(h ^ t.charCodeAt(k), 0x01000193);
    };
    const walk = (x: unknown): void => {
      if (x === null || x === undefined || typeof x !== 'object') return text(JSON.stringify(x) ?? 'u');
      if (ArrayBuffer.isView(x)) return bytes(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
      if (Array.isArray(x)) return text('['), x.forEach(walk), text(']');
      for (const k of Object.keys(x).sort()) text(k), walk((x as Record<string, unknown>)[k]);
    };
    walk(v);
    return (h >>> 0).toString(16);
  };
  const stages = (config: PlateTerrainConfig) => {
    const cache = new PlateStageCache();
    new PlateHeights(FLAT_WORLD_16KM, config, cache);
    return Object.fromEntries(cache.share().map((s) => [s.stage, fingerprint(s.value)]));
  };

  // Worlds are made from their settings alone: a change to how they're built (to make it faster,
  // say) mustn't change what's built, or every world's unedited ground changes under its players.
  // If one of these changes on purpose, say so (and think about existing worlds) before updating it.
  it('makes exactly what it always has, stage by stage', () => {
    expect(stages(plainTerrain(3))).toEqual(PINNED.defaults);
    expect(stages({ ...plainTerrain(7), majorPlates: 80, minorPlates: 200, plateSizeRatio: 2 })).toEqual(PINNED.manyPlates);
    expect(stages({ ...plainTerrain(8), landPercent: 15, islandArcs: 80, hotspots: 30 })).toEqual(PINNED.islands);
  });
});

describe('PlateStageCache.share and from (one build for every generation thread)', () => {
  it('gives another thread a world just as built, without building it again', () => {
    const config = { ...plainTerrain(21), rivers: 60, lakes: 60, mountains: 50 };
    const strokes = [{ kind: 'raise' as const, x: 300 * 16 * 16, z: 300 * 16 * 16, radius: 80, amount: 20, softness: 0.5 }];
    const cache = new PlateStageCache();
    const original = new PlateHeights(FLAT_WORLD_16KM, config, cache, strokes);
    const stages = cache.share();
    expect(stages.map((s) => s.stage)).toEqual(['layout', 'mountains', 'relief', 'coast', 'heights', 'strokes', 'climate', 'hydrology']);
    // (Posted to a real thread in genPool.test.ts.)
    const t0 = Date.now();
    const again = new PlateHeights(FLAT_WORLD_16KM, config, PlateStageCache.from(stages, FLAT_WORLD_16KM), strokes);
    const fromStages = Date.now() - t0;
    const t1 = Date.now();
    const fresh = new PlateHeights(FLAT_WORLD_16KM, config, undefined, strokes);
    const built = Date.now() - t1;
    expect(fromStages).toBeLessThan(built / 3);
    // The same ground, materials, water, trees and rivers everywhere sampled, as the original and as a fresh build.
    for (const p of [original, fresh]) {
      for (const [x, z, step] of [[0, 0, 4096], [300 * 256 - 2048, 300 * 256 - 2048, 64], [123_456, 77_000, 16]] as const) {
        const H = again.heights(x, z, 64, 64, step), Hp = p.heights(x, z, 64, 64, step);
        expect(H).toEqual(Hp);
        expect(again.materials(x, z, 64, 64, step, H)).toEqual(p.materials(x, z, 64, 64, step, Hp));
        expect(again.water(x, z, 64, 64, step)).toEqual(p.water(x, z, 64, 64, step));
        // (Trees only over small areas: the coarse one is the whole world.)
        if (step <= 64) expect(again.trees(x, z, x + 64 * step, z + 64 * step)).toEqual(p.trees(x, z, x + 64 * step, z + 64 * step));
      }
      expect(again.hydrology?.riverCells).toBe(p.hydrology?.riverCells);
      expect(again.hydrology!.riverCells).toBeGreaterThan(0);
    }
    // A build from the shared cache on this thread works off the shared arrays too (no second copy).
    expect(new PlateHeights(FLAT_WORLD_16KM, config, cache, strokes).elevation.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(again.elevation.buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});

describe('PlateStageCache', () => {
  const base: PlateTerrainConfig = { ...plainTerrain(5, ROUND_WORLD_16x8KM), islandArcs: 50, hotspots: 6, plains: 25 };
  /** Everything a build decides, to compare builds by. */
  const summary = (p: PlateHeights) => {
    const bytes = (a: ArrayBufferView | null) => {
      if (!a) return null;
      // FNV-1a over the bytes, and the length.
      const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      let h = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
      return `${b.length}:${h >>> 0}`;
    };
    const h = p.heights(0, 0, 200, 100, 128);
    return {
      grids: [p.elevation, p.plateOf, p.plainness, p.temperature, p.moisture].map(bytes),
      layout: JSON.stringify([p.plates, p.islands, p.collisions, p.hydrology]),
      samples: [bytes(h), bytes(p.materials(0, 0, 200, 100, 128, h)), bytes(p.water(0, 0, 200, 100, 128))],
    };
  };
  const fresh = summary(new PlateHeights(ROUND_WORLD_16x8KM, base));

  it('builds exactly what a build without it does, redoing only the stages a change affects', () => {
    const cache = new PlateStageCache();
    new PlateHeights(ROUND_WORLD_16x8KM, base, cache);
    // Each change, and how many of the 8 stages it leaves as they were.
    const changes: [Partial<PlateTerrainConfig>, number][] = [
      [{ snowAltitude: 150, trees: 80, biomeBlend: 10 }, 8],
      [{ lakes: 10 }, 7],
      [{ rainfall: 90 }, 6],
      [{ biomes: 0 }, 6],
      [{ maxHeight: 350 }, 4],
      [{ mountainWidth: 3000 }, 3],
      [{ shoreFractal: 80 }, 3],
      [{ noiseScale: 4000 }, 2],
      [{ landPercent: 40 }, 2],
      [{ seed: 6 }, 0],
    ];
    for (const [change, reused] of changes) {
      const cfg = { ...base, ...change };
      const hits = cache.hits;
      const cached = new PlateHeights(ROUND_WORLD_16x8KM, cfg, cache);
      expect(cache.hits - hits, JSON.stringify(change)).toBe(reused);
      expect(summary(cached), JSON.stringify(change)).toEqual(summary(new PlateHeights(ROUND_WORLD_16x8KM, cfg)));
      // And back: nothing a build reused was changed by it (rivers fill basins in a copy, say).
      expect(summary(new PlateHeights(ROUND_WORLD_16x8KM, base, cache)), JSON.stringify(change)).toEqual(fresh);
    }
  }, 60_000);
});

/** Fingerprints of plate builds (see 'plate builds stay the same'). */
const PINNED: Record<'defaults' | 'manyPlates' | 'islands', Record<string, string>> = {
  defaults: { layout: '503e671e', mountains: '677624d1', relief: 'c287459', coast: '7ae017c8', heights: '7e46bc36', strokes: '6fec2b2c', climate: 'c4e6e3a2', hydrology: 'e7d937cf' },
  manyPlates: { layout: 'f4a608b0', mountains: 'd0ba00aa', relief: '4b6d7689', coast: '9ccdcf51', heights: '1dd86c46', strokes: '756dafe9', climate: '562d1213', hydrology: 'f9e46d3b' },
  islands: { layout: '9b0f6607', mountains: '52ef197b', relief: '123642f', coast: 'b018e53a', heights: 'b32bf87a', strokes: 'f54038cf', climate: '68dbad72', hydrology: '59665a32' },
};

describe('climate for weather', () => {
  it('is there wherever there are biomes, blending or not; none without biomes', () => {
    const sharp = plates({ biomes: 1, biomeBlend: 0 });
    expect(sharp.climate()).toBeNull();
    const forWeather = sharp.climate(true)!;
    expect(forWeather.temperature.length).toBe(forWeather.cols * forWeather.rows);
    expect(plates({ biomes: 0 }).climate(true)).toBeNull();
  });
});

describe('materials worked out as asked for (materialsAt)', () => {
  /** Every sample of a block, in a scattered order: materialsAt's answer is materials()'. */
  const same = (p: PlateHeights, x0: number, z0: number, w: number, d: number, step: number) => {
    const H = p.heights(x0, z0, w, d, step);
    const at = p.materialsAt(x0, z0, w, d, step, H);
    const full = p.materials(x0, z0, w, d, step, H);
    let bad = 0;
    for (let n = 0; n < w * d; n++) {
      const k = (n * 7919) % (w * d);
      if (at(k) !== full[k]) bad++;
    }
    for (let k = 0; k < w * d; k += 97) expect(at(k)).toBe(full[k]); // (asked again: the same)
    return bad;
  };
  const M = 16;
  it('matches materials() everywhere: coasts, rivers, snow and rock lines, biomes, polar ice', () => {
    const world = ROUND_WORLD_16x8KM;
    const p = new PlateHeights(world, { ...plainTerrain(5, world), rockAltitude: 80, snowAltitude: 140, rockVariety: 80, snowFractal: 80 });
    // The most varied blocks found across the world (coasts, rock, snow, biome borders; the poles' ice).
    const found: { x0: number; z0: number; kinds: Set<number> }[] = [];
    for (let z = 0; z < world.depthUnits; z += 400 * M)
      for (let x = 0; x < world.widthUnits; x += 400 * M) {
        // (A chunk column's 16 m, every quarter metre.)
        const H = p.heights(x, z, 64, 64, 4);
        found.push({ x0: x, z0: z, kinds: new Set(p.materials(x, z, 64, 64, 4, H)) });
      }
    found.sort((a, b) => b.kinds.size - a.kinds.size);
    const picked = found.slice(0, 6);
    const icy = found.find((f) => f.kinds.has(Material.Ice) && f.kinds.size > 1);
    if (icy) picked.push(icy);
    const seen = new Set<number>();
    for (const f of picked) for (const k of f.kinds) seen.add(k);
    // (Enough going on to mean something.)
    expect(picked[0]!.kinds.size).toBeGreaterThanOrEqual(3);
    for (const m of [Material.Sand, Material.Stone, Material.Snow, Material.Ice]) expect(seen.has(m)).toBe(true);
    for (const f of picked) {
      expect(same(p, f.x0, f.z0, 256, 256, 1)).toBe(0);
      expect(same(p, f.x0, f.z0, 64, 64, 4)).toBe(0);
      expect(same(p, f.x0 - 50 * M, f.z0 - 50 * M, 100, 100, 16)).toBe(0); // (one block's worth of broad ground about them all)
      expect(same(p, f.x0, f.z0, 33, 17, 7)).toBe(0);
    }
  });

  it('matches materials() on terraformed ground, with few strokes about and many', () => {
    const world = ROUND_WORLD_16x8KM;
    const cfg = plainTerrain(5, world);
    const bare = new PlateHeights(world, cfg);
    // A spot on land, and strokes around it: a few, then a dozen (looked up by index).
    let cx = 0, cz = 0;
    for (let x = 1000; x < 15000 && !cx; x += 250) for (let z = 1000; z < 7000 && !cx; z += 250) if (bare.heights(x * M, z * M, 1, 1)[0]! > 30 * M) [cx, cz] = [x, z];
    expect(cx).toBeGreaterThan(0);
    const kinds = ['raise', 'lower', 'level', 'smooth'] as const;
    const strokes = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: kinds[i % 4]!, x: cx + ((i * 37) % 60) - 30, z: cz + ((i * 53) % 60) - 30, radius: 40 + (i % 3) * 20, amount: kinds[i % 4] === 'smooth' ? 0.6 : 20 + i, softness: 0.5 }));
    for (const n of [3, 12]) {
      const p = new PlateHeights(world, cfg, undefined, strokes(n));
      expect(same(p, (cx - 40) * M, (cz - 40) * M, 128, 128, 1)).toBe(0);
      expect(same(p, (cx - 100) * M, (cz - 100) * M, 100, 100, 16)).toBe(0);
    }
  });
});
