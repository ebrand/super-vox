import { describe, expect, it } from 'vitest';
import { Material } from './materials.js';
import { PLATE_CELL, PlateHeights, PlateStageCache, defaultPlateTerrain, type PlateTerrainConfig } from './plates.js';
import { StrokeIndex, applyStrokes, strokeWeight, strokesIn, strokesOverColumns, validateStrokes, type TerrainStroke } from './strokes.js';
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

  it("smooths the edge of a levelled plateau (shapes strokes made, not just the ground's bumps)", () => {
    const [x, z] = spots[4]!;
    // A plateau 60 m above the land with a steep edge, then smooth strokes all round its edge.
    const plateau = stroke({ kind: 'level', x, z, radius: 150, amount: sample(plain, x, z) + 60, softness: 0.1 });
    const edge = Array.from({ length: 24 }, (_, k) => stroke({ kind: 'smooth', x: x + Math.cos((k * Math.PI) / 12) * 145, z: z + Math.sin((k * Math.PI) / 12) * 145, radius: 50, amount: 1, softness: 0.5 }));
    const sharp = new PlateHeights(world, cfg, undefined, [plateau]);
    const soft = new PlateHeights(world, cfg, undefined, [plateau, ...edge]);
    // The steepest step (m per m) along a line out from the middle across the edge, 1 m apart.
    const steepest = (p: PlateHeights) => {
      const h = p.heights((x + 100) * M, z * M, 100, 1, M);
      let worst = 0;
      for (let i = 1; i < 100; i++) worst = Math.max(worst, Math.abs(h[i]! - h[i - 1]!) / M);
      return worst;
    };
    expect(steepest(soft)).toBeLessThan(steepest(sharp) * 0.6);
    // The middle of the plateau stays put.
    expect(sample(soft, x, z)).toBeCloseTo(sample(sharp, x, z), 0);
  });

  it('smooths the same while shaping (strokes added and taken back) as built afresh', () => {
    const [x, z] = spots[4]!;
    const plateau = stroke({ kind: 'level', x, z, radius: 150, amount: sample(plain, x, z) + 60, softness: 0.1 });
    const bump = stroke({ kind: 'raise', x: x + 140, z, radius: 40, amount: 25 });
    // (The same stroke objects throughout, as a draft keeps them.)
    const [s0, s1] = [0, 1].map((k) => stroke({ kind: 'smooth', x: x + 145, z: z + k * 10, radius: 50, amount: 1, softness: 0.5 }));
    const block = (p: PlateHeights) => [p.heights((x + 60) * M, (z - 40) * M, 80, 80, M), p.materials((x + 60) * M, (z - 40) * M, 80, 80, M, p.heights((x + 60) * M, (z - 40) * M, 80, 80, M))];
    const shaping = new PlateHeights(world, cfg, undefined, [plateau]);
    // Smooth, then add a raise under it, then take the raise back (undo), as the Terraformer does.
    for (const strokes of [[plateau, s0!], [plateau, s0!, s1!], [plateau, bump, s0!, s1!], [plateau, s0!, s1!]]) {
      shaping.setSampleStrokes(strokes);
      block(shaping);
      const fresh = new PlateHeights(world, cfg, undefined, strokes);
      fresh.setSampleStrokes(strokes);
      expect(block(shaping)).toEqual(block(fresh));
    }
  });

  it('gives ground the same materials in a block as spot by spot, with strokes about', () => {
    const [x, z] = spots[4]!;
    const p = new PlateHeights(world, cfg, undefined, [
      // A steep-sided plateau (rock on its sides), smoothed in places.
      stroke({ kind: 'level', x, z, radius: 150, amount: sample(plain, x, z) + 150, softness: 0.05 }),
      stroke({ kind: 'smooth', x: x + 145, z: z + 30, radius: 40, amount: 1, softness: 0.5 }),
    ]);
    // (Big enough that the slopes come from one block around it; one spot works them out alone.)
    const x0 = (x + 80) * M, z0 = (z - 50) * M, h = p.heights(x0, z0, 100, 100, M), mats = p.materials(x0, z0, 100, 100, M, h);
    expect(new Set(mats).size).toBeGreaterThan(1);
    for (let j = 0; j < 100; j += 3) for (let i = 0; i < 100; i += 3) expect(p.materials(x0 + i * M, z0 + j * M, 1, 1, M, h.subarray(i + 100 * j, i + 100 * j + 1))[0]).toBe(mats[i + 100 * j]);
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

describe('plant and clear strokes', () => {
  const world = ROUND_WORLD_16x8KM;
  const cfg: PlateTerrainConfig = { ...defaultPlateTerrain(4, world), rivers: 0, lakes: 0 };
  const plain = new PlateHeights(world, cfg);
  const sea = plain.seaLevel;
  /** Spots (metres) on low land (5..150 m up) where trees can grow, across the world's climates. */
  const spots: [number, number][] = [];
  for (let z = 600; z < 7600; z += 450) {
    for (let x = 300; x < 16000; x += 1300) {
      const h = plain.heights(x * M, z * M, 1, 1);
      const mat = plain.materials(x * M, z * M, 1, 1, 1, h)[0]!;
      if (h[0]! - sea > 5 * M && h[0]! - sea < 150 * M && [Material.Grass, Material.JungleFloor, Material.DryGrass, Material.Meadow, Material.TaigaFloor].includes(mat as never)) spots.push([x, z]);
    }
  }
  const box = (x: number, z: number, r: number) => [(x - r) * M, (z - r) * M, (x + r) * M, (z + r) * M] as const;
  /** Trunks within `r` metres of (x, z). */
  const trunks = (p: PlateHeights, x: number, z: number, r: number) => p.trees(...box(x, z, r)).filter((t) => Math.hypot(t.x / M - x, t.z / M - z) <= r);

  it('found spots in several climates', () => {
    expect(spots.length).toBeGreaterThan(10);
  });

  it('plants trees of the kind the biome grows, and only where trees grow', () => {
    const kinds = new Set<number>();
    let matched = 0, planted = 0;
    // Biome -> the kind of tree it grows (see trees.ts shapeTree).
    const kindOf = (b: number) => (b === 5 ? 2 : b === 6 ? 3 : b === 1 || b === 2 ? 1 : 0);
    for (const [x, z] of spots) {
      const p = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'plant', x, z, radius: 40, amount: 1, softness: 0 })]);
      const before = trunks(plain, x, z, 30).length, after = trunks(p, x, z, 30);
      // Every fertile 6 m cell has a tree now: far more than the forest's own.
      expect(after.length).toBeGreaterThanOrEqual(before);
      for (const t of after) {
        const h = p.heights(t.x, t.z, 1, 1), mat = p.materials(t.x, t.z, 1, 1, 1, h)[0]!;
        expect([Material.Grass, Material.JungleFloor, Material.DryGrass, Material.Meadow, Material.TaigaFloor, Material.Tundra]).toContain(mat);
        const biome = p.biomes(t.x, t.z, 1, 1, 1, h)![0]!;
        kinds.add(t.kind);
        planted++;
        if (t.kind === kindOf(biome)) matched++;
      }
    }
    // (Near a biome's border its neighbour's trees mix in, as they do in the forest.)
    expect(planted).toBeGreaterThan(spots.length * 40);
    expect(matched / planted).toBeGreaterThan(0.85);
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it('clears trees from its core, thins them on its soft edge, and leaves them outside', () => {
    // The spot with the most trees about.
    const [x, z] = spots.reduce((a, b) => (trunks(plain, ...b, 120).length > trunks(plain, ...a, 120).length ? b : a));
    expect(trunks(plain, x, z, 120).length).toBeGreaterThan(50);
    const p = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'clear', x, z, radius: 80, amount: 1, softness: 0.5 })]);
    expect(trunks(p, x, z, 40)).toEqual([]);
    const ring = (q: PlateHeights) => trunks(q, x, z, 75).filter((t) => Math.hypot(t.x / M - x, t.z / M - z) > 45).length;
    expect(ring(p)).toBeLessThan(ring(plain));
    const outside = (q: PlateHeights) => q.trees(...box(x, z, 140)).filter((t) => Math.hypot(t.x / M - x, t.z / M - z) > 81);
    expect(outside(p)).toEqual(outside(plain));
  });

  it('changes the far-off canopy too', () => {
    const cover = (q: PlateHeights, x: number, z: number) => {
      const step = 8 * M, h = q.heights((x - 60) * M, (z - 60) * M, 16, 16, step);
      const c = q.canopy((x - 60) * M, (z - 60) * M, 16, 16, step, h, q.materials((x - 60) * M, (z - 60) * M, 16, 16, step, h));
      return c ? c.top.filter((v) => v !== -(2 ** 31)).length : 0;
    };
    // A spot with some forest, not all it can have (at most, planting can't add any).
    const [x, z] = spots.find(([x, z]) => cover(plain, x, z) > 20 && cover(plain, x, z) < 120)!;
    const cleared = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'clear', x, z, radius: 120, amount: 1, softness: 0 })]);
    const planted = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'plant', x, z, radius: 120, amount: 1, softness: 0 })]);
    expect(cover(cleared, x, z)).toBe(0);
    expect(cover(planted, x, z)).toBeGreaterThan(cover(plain, x, z) * 1.3);
  });

  it("plants in a world without trees, and doesn't touch the ground, climate or rivers", () => {
    const bare: PlateTerrainConfig = { ...cfg, trees: 0, rivers: 50, lakes: 50 };
    const [x, z] = spots[0]!;
    const cache = new PlateStageCache();
    const p0 = new PlateHeights(world, bare, cache);
    const hits = cache.hits;
    const p = new PlateHeights(world, bare, cache, [stroke({ kind: 'plant', x, z, radius: 40, amount: 1, softness: 0 }), stroke({ kind: 'clear', x: x + 500, z, radius: 40, amount: 1 })]);
    // Every stage reused: plant and clear don't change what they make.
    expect(cache.hits - hits).toBe(8);
    expect(trunks(p0, x, z, 30)).toEqual([]);
    expect(trunks(p, x, z, 30).length).toBeGreaterThan(10);
    expect(p.heights((x - 50) * M, (z - 50) * M, 100, 100, M)).toEqual(p0.heights((x - 50) * M, (z - 50) * M, 100, 100, M));
    expect(p.hydrology).toEqual(p0.hydrology);
  });

  it('gives a box the planted trees reaching into it from just outside', () => {
    const [x, z] = spots[0]!;
    const p = new PlateHeights(world, cfg, undefined, [stroke({ kind: 'plant', x, z, radius: 12, amount: 1, softness: 0 })]);
    // A box starting just east of the stroke: the trees in a big box that reach into it.
    const x0 = (x + 13) * M, z0 = (z - 20) * M, x1 = (x + 60) * M, z1 = (z + 20) * M, reach = 11 * M;
    const reaching = p.trees(...box(x, z, 200)).filter((t) => t.x + reach >= x0 && t.x - reach < x1 && t.z + reach >= z0 && t.z - reach < z1);
    expect(reaching.some((t) => t.x < x0)).toBe(true);
    expect(p.trees(x0, z0, x1, z1)).toEqual(reaching);
  });

  it('checks their amounts', () => {
    expect(() => validateStrokes([stroke({ kind: 'plant', amount: 0.5 }), stroke({ kind: 'clear', amount: 1 })])).not.toThrow();
    expect(() => validateStrokes([stroke({ kind: 'plant', amount: 1.5 })])).toThrow(/amount/);
  });
});

describe('strokesOverColumns', () => {
  const col = (cx: number, cz: number) => ({ cx, cz });
  it('finds the strokes that come within the margin of a protected column, and only those', () => {
    // Column (10, 10): 160..176 m by 160..176 m.
    const strokes = [
      stroke({ x: 168, z: 168, radius: 5 }), // over it
      stroke({ x: 200, z: 168, radius: 20 }), // 24 m from its edge: within 20 + 12
      stroke({ x: 200, z: 168, radius: 10 }), // 24 m: not within 10 + 12
      stroke({ x: 190, z: 190, radius: 10 }), // corner 19.8 m away: within 22
      stroke({ x: 195, z: 195, radius: 10 }), // corner 26.9 m away: not
      stroke({ x: 600, z: 600, radius: 50 }),
    ];
    expect(strokesOverColumns(strokes, [col(10, 10)], 16, null)).toEqual([0, 1, 3]);
    expect(strokesOverColumns(strokes, [], 16, null)).toEqual([]);
  });

  it('wraps across the seam of a round world', () => {
    // A 16 km wide world: column 0 is next to column 999.
    expect(strokesOverColumns([stroke({ x: 15995, z: 8, radius: 5 })], [col(0, 0)], 16, 16000)).toEqual([0]);
    expect(strokesOverColumns([stroke({ x: 5, z: 8, radius: 5 })], [col(999, 0)], 16, 16000)).toEqual([0]);
    expect(strokesOverColumns([stroke({ x: 5, z: 8, radius: 5 })], [col(999, 0)], 16, null)).toEqual([]);
  });
});
