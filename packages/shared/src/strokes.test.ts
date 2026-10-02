import { describe, expect, it } from 'vitest';
import { Material } from './materials.js';
import { PLATE_CELL, PlateHeights, PlateStageCache, defaultPlateTerrain, type PlateTerrainConfig } from './plates.js';
import { StrokeIndex, applyStrokes, strokeWeight, strokesIn, validateStrokes, type TerrainStroke } from './strokes.js';
import { NO_WATER } from './water.js';
import { FLAT_WORLD_16KM, ROUND_WORLD_16x8KM, type WorldConfig } from './world.js';

const M = 16;
const stroke = (over: Partial<TerrainStroke>): TerrainStroke => ({ kind: 'raise', x: 0, z: 0, radius: 100, amount: 10, softness: 0.5, ...over });

describe('strokeWeight', () => {
  it('is 1 in the core, 0 from the rim out, and falls smoothly between', () => {
    const s = { radius: 100, softness: 0.4 };
    expect(strokeWeight(s, 0)).toBe(1);
    expect(strokeWeight(s, 60)).toBe(1);
    expect(strokeWeight(s, 100)).toBe(0);
    expect(strokeWeight(s, 150)).toBe(0);
    expect(strokeWeight(s, 80)).toBeCloseTo(0.5, 9);
    let last = 1;
    for (let d = 60; d <= 100; d += 2) {
      expect(strokeWeight(s, d)).toBeLessThanOrEqual(last);
      last = strokeWeight(s, d);
    }
    // Hard-edged and fully soft.
    expect(strokeWeight({ radius: 100, softness: 0 }, 99.9)).toBe(1);
    expect(strokeWeight({ radius: 100, softness: 1 }, 0)).toBe(1);
    expect(strokeWeight({ radius: 100, softness: 1 }, 50)).toBeCloseTo(0.5, 9);
  });
});

describe('applyStrokes', () => {
  const at = (strokes: TerrainStroke[], xm: number, ground = 50 * M, broad = 45 * M) => applyStrokes(strokes, xm * M, 0, ground, broad, 0, null);

  it('raises, lowers and levels the ground and its broad shape alike', () => {
    expect(at([stroke({ amount: 20 })], 0)).toEqual({ ground: 70 * M, broad: 65 * M });
    expect(at([stroke({ kind: 'lower', amount: 20 })], 0)).toEqual({ ground: 30 * M, broad: 25 * M });
    expect(at([stroke({ kind: 'level', amount: 120 })], 0)).toEqual({ ground: 120 * M, broad: 120 * M });
    // Halfway down the soft edge, half as much.
    expect(at([stroke({ amount: 20 })], 75).ground).toBeCloseTo(60 * M, 9);
    // Outside: untouched.
    expect(at([stroke({ amount: 20 })], 100)).toEqual({ ground: 50 * M, broad: 45 * M });
  });

  it('smooths the ground toward its broad shape', () => {
    expect(at([stroke({ kind: 'smooth', amount: 1 })], 0)).toEqual({ ground: 45 * M, broad: 45 * M });
    expect(at([stroke({ kind: 'smooth', amount: 0.5 })], 0).ground).toBe(47.5 * M);
  });

  it('applies strokes in order', () => {
    const up = stroke({ amount: 20 }), flat = stroke({ kind: 'level', amount: 10 });
    expect(at([up, flat], 0).ground).toBe(10 * M);
    expect(at([flat, up], 0).ground).toBe(30 * M);
  });

  it('wraps on round worlds', () => {
    const W = 1000 * M;
    expect(applyStrokes([stroke({ x: 990 })], 5 * M, 0, 0, 0, 0, W).ground).toBe(10 * M);
    expect(applyStrokes([stroke({ x: 990 })], 5 * M, 0, 0, 0, 0, null).ground).toBe(0);
  });
});

describe('strokesIn', () => {
  it('keeps the strokes that reach a box (round worlds: any copy), in order', () => {
    const a = stroke({ x: 0, z: 0, radius: 50 }), b = stroke({ x: 500, z: 0, radius: 50 }), c = stroke({ x: 990, z: 0, radius: 50 });
    expect(strokesIn([a, b, c], 30 * M, 0, 80 * M, 10 * M, null)).toEqual([a]);
    expect(strokesIn([a, b, c], 200 * M, 0, 300 * M, 10 * M, null)).toEqual([]);
    expect(strokesIn([a, b, c], 0, 60 * M, 80 * M, 70 * M, null)).toEqual([]);
    expect(strokesIn([a, b, c], 0, 0, 10 * M, 10 * M, 1000 * M)).toEqual([a, c]);
    expect(strokesIn([a, b, c], 0, 0, 1000 * M, 10 * M, 1000 * M)).toEqual([a, b, c]);
  });
});

describe('StrokeIndex', () => {
  it('gives the same result as checking every stroke, in order (round and flat worlds)', () => {
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const kinds = ['raise', 'lower', 'level', 'smooth'] as const;
    const W = 4000;
    const strokes = Array.from({ length: 300 }, () => {
      const kind = kinds[Math.floor(rnd() * 4)]!;
      return stroke({ kind, x: rnd() * W, z: rnd() * 2000, radius: 5 + rnd() * (rnd() < 0.05 ? 3000 : 300), amount: kind === 'smooth' ? rnd() : rnd() * 80, softness: rnd() });
    });
    for (const width of [W * M, null]) {
      const index = new StrokeIndex(strokes, width);
      for (let k = 0; k < 3000; k++) {
        const x = (rnd() * 1.2 - 0.1) * W * M, z = rnd() * 2000 * M;
        const all = applyStrokes(strokes, x, z, 40 * M, 30 * M, 0, width);
        expect(applyStrokes(index.at(x, z), x, z, 40 * M, 30 * M, 0, width)).toEqual(all);
      }
    }
  });
});

describe('validateStrokes', () => {
  it('accepts good strokes and refuses bad ones', () => {
    expect(() => validateStrokes([stroke({}), stroke({ kind: 'level', amount: -20 }), stroke({ kind: 'smooth', amount: 0.7 })])).not.toThrow();
    expect(() => validateStrokes('nope')).toThrow(/list/);
    expect(() => validateStrokes([{ ...stroke({}), kind: 'melt' }])).toThrow(/kind/);
    expect(() => validateStrokes([stroke({ radius: 0 })])).toThrow(/radius/);
    expect(() => validateStrokes([stroke({ kind: 'smooth', amount: 2 })])).toThrow(/amount/);
    expect(() => validateStrokes([stroke({ softness: -0.1 })])).toThrow(/softness/);
    expect(() => validateStrokes([{ ...stroke({}), x: 'here' }])).toThrow(/x/);
  });
});

describe('terraforming a plate world', () => {
  const world = FLAT_WORLD_16KM;
  const cfg: PlateTerrainConfig = { ...defaultPlateTerrain(9), rivers: 50, lakes: 100 };
  const plain = new PlateHeights(world, cfg);
  const sea = plain.seaLevel;
  /** Inland spots (10..200 m up within 400 m, no water there): [x, z] metres. */
  const spots: [number, number][] = [];
  for (let z = 1000; z < 15000 && spots.length < 6; z += 700) {
    for (let x = 1000; x < 15000 && spots.length < 6; x += 700) {
      const h = plain.heights(x * M - 400 * M, z * M - 400 * M, 9, 9, 100 * M);
      const w = plain.water(x * M - 400 * M, z * M - 400 * M, 9, 9, 100 * M);
      if (Math.min(...h) - sea > 10 * M && Math.max(...h) - sea < 200 * M && !(w && w.some((v) => v !== NO_WATER))) spots.push([x, z]);
    }
  }
  const sample = (p: PlateHeights, x: number, z: number) => (p.heights(x * M, z * M, 1, 1)[0]! - sea) / M;

  it('found inland spots to work on', () => {
    expect(spots.length).toBeGreaterThanOrEqual(3);
  });

  it('raises the ground exactly in the core, partly on the soft edge, not at all outside', () => {
    const [x, z] = spots[0]!;
    const p = new PlateHeights(world, cfg, undefined, [stroke({ x, z, radius: 300, amount: 60, softness: 0.5 })]);
    expect(sample(p, x, z)).toBeCloseTo(sample(plain, x, z) + 60, 0);
    expect(sample(p, x + 100, z)).toBeCloseTo(sample(plain, x + 100, z) + 60, 0);
    const edge = sample(p, x + 225, z) - sample(plain, x + 225, z);
    expect(edge).toBeGreaterThan(5);
    expect(edge).toBeLessThan(55);
    for (const [dx, dz] of [[400, 0], [0, -400], [-350, 250]]) expect(sample(p, x + dx!, z + dz!)).toBe(sample(plain, x + dx!, z + dz!));
  });

  it('levels a site flat at the asked height, and snow comes with height', () => {
    const [x, z] = spots[1]!;
    const p = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'level', x, z, radius: 250, amount: 120, softness: 0.4 })]);
    const h = p.heights((x - 100) * M, (z - 100) * M, 21, 21, 10 * M);
    expect(Math.min(...h)).toBe(sea + 120 * M);
    expect(Math.max(...h)).toBe(sea + 120 * M);
    // Raised far above the snow altitude (240 m by default), the top is snow.
    const high = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'level', x, z, radius: 400, amount: 420, softness: 0.4 })]);
    const top = high.heights(x * M, z * M, 1, 1);
    expect(high.materials(x * M, z * M, 1, 1, 1, top)[0]).toBe(Material.Snow);
  });

  it('smooths away the small bumps but keeps the broad shape', () => {
    const [x, z] = spots[2]!;
    const p = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'smooth', x, z, radius: 300, amount: 1, softness: 0.3 })]);
    // Bumpiness: how much each metre differs from the mean of its neighbours 8 m away.
    const bumps = (q: PlateHeights) => {
      const N = 40, h = q.heights((x - 80) * M, (z - 80) * M, N, N, 4 * M);
      let s = 0;
      for (let j = 2; j < N - 2; j++) for (let i = 2; i < N - 2; i++) s += Math.abs(h[i + N * j]! - (h[i - 2 + N * j]! + h[i + 2 + N * j]! + h[i + N * (j - 2)]! + h[i + N * (j + 2)]!) / 4);
      return s;
    };
    expect(bumps(p)).toBeLessThan(bumps(plain) * 0.3);
    expect(Math.abs(sample(p, x, z) - sample(plain, x, z))).toBeLessThan(15);
  });

  it('a dug hollow fills with a lake, and the rivers find new ways', () => {
    // A closed hollow: levelled to 20 m below the lowest ground in a ring around it (600..1000 m
    // out), at the first spot where that's still above the sea.
    const ringMin = ([x, z]: [number, number]) => {
      let low = Infinity;
      for (let a = 0; a < 32; a++) for (const r of [600, 800, 1000]) low = Math.min(low, sample(plain, x + Math.cos((a * Math.PI) / 16) * r, z + Math.sin((a * Math.PI) / 16) * r));
      return low;
    };
    let spot: [number, number] | undefined;
    for (let z = 1500; z < 14500 && !spot; z += 500) {
      for (let x = 1500; x < 14500 && !spot; x += 500) if (ringMin([x, z]) > 30 && !plain.water(x * M, z * M, 1, 1)) spot = [x, z];
    }
    expect(spot).toBeDefined();
    const [x, z] = spot!;
    const dug = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'level', x, z, radius: 500, amount: ringMin(spot!) - 20, softness: 0.6 })]);
    const w = dug.water(x * M, z * M, 1, 1);
    expect(w).not.toBeNull();
    expect(w![0]).toBeGreaterThan(dug.heights(x * M, z * M, 1, 1)[0]!);
    // ... a lake (not a river through it): the generator's lake grid has it, where there was none.
    const cell = Math.floor((x * M) / PLATE_CELL) + dug.cols * Math.floor((z * M) / PLATE_CELL);
    expect(Number.isNaN(dug.hydrology!.lakeLevel[cell]!)).toBe(false);
    expect(Number.isNaN(plain.hydrology!.lakeLevel[cell]!)).toBe(true);
    // A wall of hills across the middle of the world sends rivers elsewhere.
    const wall = new PlateHeights(world, cfg, undefined, Array.from({ length: 30 }, (_, k) => stroke({ x: 500 + k * 500, z: 8000, radius: 600, amount: 150, softness: 0.5 })));
    expect(JSON.stringify(wall.hydrology!.segments)).not.toBe(JSON.stringify(plain.hydrology!.segments));
  });

  it('builds the same with a stage cache, redoing only what the strokes change', () => {
    const cache = new PlateStageCache();
    new PlateHeights(world, cfg, cache);
    const strokes = [stroke({ x: spots[0]![0], z: spots[0]![1], radius: 300, amount: 40 })];
    const hits = cache.hits;
    const cached = new PlateHeights(world, cfg, cache, strokes);
    // Everything up to the heights is reused; the strokes, climate and rivers are redone.
    expect(cache.hits - hits).toBe(5);
    const fresh = new PlateHeights(world, cfg, undefined, strokes);
    expect(cached.heights(0, 0, 200, 200, 80 * M)).toEqual(fresh.heights(0, 0, 200, 200, 80 * M));
    expect(cached.elevation).toEqual(fresh.elevation);
  });

  it('samples the same ground in one big block as spot by spot, with many strokes about', () => {
    const many = Array.from({ length: 40 }, (_, k) => stroke({ kind: (['raise', 'lower', 'level', 'smooth'] as const)[k % 4]!, x: 6000 + (k % 8) * 300, z: 6000 + Math.floor(k / 8) * 300, radius: 250, amount: k % 4 === 3 ? 0.8 : 30 + k, softness: 0.5 }));
    const p = new PlateHeights(world, cfg, undefined, many);
    const big = p.heights(5800 * M, 5800 * M, 60, 50, 50 * M);
    for (let j = 0; j < 50; j += 7) for (let i = 0; i < 60; i += 5) expect(p.heights((5800 + i * 50) * M, (5800 + j * 50) * M, 1, 1)[0]).toBe(big[i + 60 * j]);
  });

  it('wraps across the seam of a round world', () => {
    const round: WorldConfig = ROUND_WORLD_16x8KM;
    const rcfg = { ...defaultPlateTerrain(3, round), rivers: 0, lakes: 0 };
    const W = round.widthUnits / M;
    const before = new PlateHeights(round, rcfg), after = new PlateHeights(round, rcfg, undefined, [stroke({ x: W - 50, z: 4000, radius: 200, amount: 30, softness: 0.2 })]);
    // 30 m east of the seam is 80 m from the stroke's centre: in its core.
    expect(sample(after, 30, 4000) - sample(before, 30, 4000)).toBeCloseTo(30, 0);
    expect(sample(after, W - 50, 4000) - sample(before, W - 50, 4000)).toBeCloseTo(30, 0);
  });
});
