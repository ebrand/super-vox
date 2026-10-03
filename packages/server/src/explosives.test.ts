import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MAX_BLAST_RADIUS, Material, blastRadius, tntEquivalent, defaultFlatGen, CHAIN_FUSE_MS, FUSE_MS, unpackDebris } from '@super-vox/shared';
import { Explosives, MAX_PIECES, PIECE, pickPieces } from './explosives.js';
import { World } from './world.js';

/** A flat world (ground at 0: grass over dirt over stone, in 1/4 m voxels). */
const flat = () => new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
const M = 16;
/** A blast going off and its crater carved: the tick that announces it, then the one that carves it (their results together). */
function blow(e: Explosives, now: number) {
  const a = e.tick(now), b = e.tick(now);
  return { announced: a.announced, blasts: [...a.blasts, ...b.blasts], debris: [...a.debris, ...b.debris], landed: [...a.landed, ...b.landed] };
}

/** A seeded random number generator (an LCG: enough for tests). */
const seededRandom = (seed = 1) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
/** Whether there's something solid at unit (x, y, z). */
const solid = (w: World, x: number, y: number, z: number) => {
  const m = w.materialAtUnit(x, y, z);
  return m !== undefined && m !== 0;
};

describe('World.explode', () => {
  it('blows a round crater: everything inside gone, everything outside left, cut down to 1/4 m at the edge', () => {
    const w = flat();
    const [x, y, z] = [1000 * M + 8, -2 * M, 1000 * M + 8], r = 4 * M;
    const { result, tnt } = w.explode(x, y, z, r);
    expect(result).not.toBeNull();
    expect(tnt).toEqual([]);
    for (let k = 0; k < 400; k++) {
      // Points around, at distances well inside and well outside the edge.
      const a = (k * 2.399) % (Math.PI * 2), b = ((k * 7) % 180 - 90) * (Math.PI / 180), d = k % 2 ? r * 0.85 : r * 1.15;
      const px = Math.round(x + Math.cos(a) * Math.cos(b) * d), py = Math.round(y + Math.sin(b) * d), pz = Math.round(z + Math.sin(a) * Math.cos(b) * d);
      if (py >= 0) continue; // (air above the ground anyway)
      expect(solid(w, px, py, pz)).toBe(d > r);
    }
  });

  it('leaves other TNT in it (to be lit) and takes the TNT that blew; fences go', () => {
    const w = flat();
    const self = { x: 2000 * M, y: 0, z: 2000 * M, size: 16 }, other = { x: 2002 * M, y: 0, z: 2000 * M, size: 16 }, far = { x: 2010 * M, y: 0, z: 2000 * M, size: 16 };
    for (const t of [self, other, far]) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    w.placeObject('fence', 2000, 0, 2002, 'n');
    expect(w.explosiveAt(self.x + 3, 5, self.z + 9)).toMatchObject(self);
    const { tnt } = w.explode(self.x + 8, 8, self.z + 8, blastRadius(16 ** 3), new Set([`${self.x},${self.y},${self.z}`]));
    expect(tnt).toEqual([{ ...other, material: Material.TNT }]);
    expect(w.explosiveAt(self.x + 3, 5, self.z + 9)).toBeNull();
    expect(w.explosiveAt(other.x + 3, 5, other.z + 9)).toMatchObject(other);
    expect(w.explosiveAt(far.x + 3, 5, far.z + 9)).toMatchObject(far);
    expect(w.objectAt(2000, 0, 2002)).toBeUndefined();
  });
});

describe('Explosives', () => {
  it('announces a blast as its fuse runs out, and carves its crater on the next tick', () => {
    const w = flat();
    const t = { x: 3500 * M, y: 0, z: 3500 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: seededRandom(4), debrisBudgetMs: Infinity });
    e.light(t, 0);
    const first = e.tick(FUSE_MS);
    expect(first.announced).toEqual([expect.objectContaining({ x: t.x + 8, y: 8, z: t.z + 8, radius: 128 })]);
    expect(first.blasts).toEqual([]);
    expect(w.explosiveAt(t.x + 4, 4, t.z + 4)).not.toBeNull(); // (not carved yet)
    expect(e.count).toBeGreaterThan(0);
    const second = e.tick(FUSE_MS + 50);
    expect(second.announced).toEqual([]);
    expect(second.blasts.length).toBe(1);
    expect(second.blasts[0]).toMatchObject({ seed: first.announced[0]!.seed, radius: 128 });
    expect(second.blasts[0]!.result).not.toBeNull();
    expect(w.explosiveAt(t.x + 4, 4, t.z + 4)).toBeNull();
    // Its debris thrown from when it went off: 50 ms in already.
    expect(second.debris.length).toBe(MAX_PIECES);
    expect(second.debris.every((p) => p.a === 50)).toBe(true);
  });

  it('blows lit TNT when its fuse runs out, lights what it catches, and not TNT taken away', () => {
    const w = flat();
    const a = { x: 3000 * M, y: 0, z: 3000 * M, size: 16 }, b = { x: 3002 * M, y: 0, z: 3000 * M, size: 16 }, c = { x: 3100 * M, y: 0, z: 3000 * M, size: 16 };
    for (const t of [a, b, c]) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.5, debrisBudgetMs: Infinity });
    expect(e.light(a, 0)).toBe(FUSE_MS);
    expect(e.light(a, 0)).toBeNull(); // already lit
    expect(e.tick(FUSE_MS - 1).blasts).toEqual([]);
    const [blast] = blow(e, FUSE_MS).blasts;
    expect(blast).toMatchObject({ x: a.x + 8, y: 8, z: a.z + 8, radius: 128 }); // a 1 m TNT block: 8 m
    expect(blast!.lit).toEqual([{ tnt: { ...b, material: Material.TNT }, ms: (CHAIN_FUSE_MS[0] + CHAIN_FUSE_MS[1]) / 2 }]);
    expect(blast!.result).not.toBeNull();
    // The chained one goes off after its short fuse.
    expect(blow(e, FUSE_MS + 1000).blasts.map((x) => x.x)).toEqual([b.x + 8]);
    // Lit, then dug out before it blows: nothing.
    e.light(c, 0);
    w.applyEdit({ op: 'remove', x: c.x, y: c.y, z: c.z });
    expect(e.tick(FUSE_MS * 2).blasts).toEqual([]);
    expect(e.count).toBe(0);
  });
});

describe('blast direction', () => {
  it('goes up from the ground, and out of a wall for TNT dug into it, throwing its debris that way', () => {
    // On the ground: up.
    const g = flat();
    const t = { x: 2000 * M, y: 0, z: 2000 * M, size: 16 };
    g.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(g, { random: seededRandom(3), debrisBudgetMs: Infinity });
    e.light(t, 0);
    const up = blow(e, FUSE_MS).blasts[0]!;
    expect(up.open[1]).toBeGreaterThan(0.95);
    // A stone wall 16 m thick and high, its face (facing -x) at x = W; a 1/2 m TNT voxel (2.8 m) 1/2 m into it, 4 m up.
    const w = flat();
    const W = 2500 * M, Z = 2500 * M;
    for (const dz of [-256, 0]) w.applyEdit({ op: 'fillBox', x: W, y: 0, z: Z + dz, size: 256, material: Material.Stone });
    w.applyEdit({ op: 'removeBox', x: W, y: 64, z: Z, size: 16 });
    const tnt = { x: W, y: 64, z: Z, size: 8 };
    w.applyEdit({ op: 'place', ...tnt, material: Material.TNT });
    const ex = new Explosives(w, { random: seededRandom(3), debrisBudgetMs: Infinity });
    ex.light(tnt, 0);
    const { blasts, debris } = blow(ex, FUSE_MS);
    const out = blasts[0]!.open;
    expect(out[0]).toBeLessThan(-0.9); // out of the face
    // Most of the debris lands out in front of the wall, not back in its crater.
    let outside = 0;
    for (const p of debris) if (unpackDebris(p).at(-1)![0] < W) outside++;
    expect(outside).toBeGreaterThan(debris.length * 0.6);
  });
});

describe('crater shape', () => {
  it('with a seed, blows a lobed, rough crater (not the sphere), the same for the same seed', () => {
    const [x, y, z, r] = [1500 * M + 8, -4 * M, 1500 * M + 8, 6 * M];
    const dig = (seed?: number) => {
      const w = flat();
      w.explode(x, y, z, r, new Set(), seed);
      // Which cells (1/4 m, the ground's voxels) are gone, on a 1 m grid through it.
      const gone: boolean[] = [];
      for (let dy = -10; dy <= 0; dy++) for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) gone.push(!solid(w, x + dx * M + 2, y + dy * M + 2 + 3 * M, z + dz * M + 2));
      return gone;
    };
    const sphere = dig(), a = dig(42), b = dig(42), c = dig(43);
    expect(a).toEqual(b);
    const differ = (p: boolean[], q: boolean[]) => p.filter((v, i) => v !== q[i]).length;
    expect(differ(a, sphere)).toBeGreaterThan(sphere.filter(Boolean).length * 0.1); // not the sphere
    expect(differ(a, c)).toBeGreaterThan(0); // another seed, another shape
    // About as much taken out as the sphere would (within a third).
    const n = (p: boolean[]) => p.filter(Boolean).length;
    expect(Math.abs(n(a) - n(sphere))).toBeLessThan(n(sphere) / 3);
  });
});

describe('World.placeMany', () => {
  it('places voxels all at once: where each is, else a step up, else not; one change a chunk', () => {
    const w = flat();
    const x = 3000 * M, z = 3000 * M;
    w.applyEdit({ op: 'place', x: x + 8, y: 4, z, size: 4, material: Material.Stone }); // in the way, two high
    w.applyEdit({ op: 'place', x: x + 8, y: 0, z, size: 4, material: Material.Stone });
    const result = w.placeMany([
      { x, y: 0, z, size: 4, material: Material.Dirt }, // free
      { x: x + 4, y: -4, z, size: 4, material: Material.Sand }, // in the ground: a step up
      { x: x + 8, y: 0, z, size: 4, material: Material.Grass }, // taken, and above it too: not at all
    ])!;
    expect(result.changes.length).toBe(1);
    expect(w.materialAtUnit(x + 1, 1, z + 1)).toBe(Material.Dirt);
    expect(w.materialAtUnit(x + 5, 1, z + 1)).toBe(Material.Sand);
    expect(w.materialAtUnit(x + 9, 9, z + 1)).toBe(0);
    expect(w.materialAtUnit(x + 9, 1, z + 1)).toBe(Material.Stone);
    expect(result.change.get(Material.Dirt)).toBe(64);
    expect(result.change.get(Material.Sand)).toBe(64);
    expect(result.change.get(Material.Grass)).toBeUndefined();
    // Nothing that fits: null.
    expect(w.placeMany([{ x: x + 8, y: 0, z, size: 4, material: Material.Grass }])).toBeNull();
  });
});

describe('debris', () => {
  it('throws pieces of what a blast took out, which stay where they land in creative', () => {
    const w = flat();
    const t = { x: 5000 * M, y: 0, z: 5000 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: seededRandom(), keepDebris: () => true, debrisBudgetMs: Infinity });
    e.light(t, 0);
    const { debris } = blow(e, FUSE_MS);
    expect(debris.length).toBe(MAX_PIECES);
    expect(debris.every((p) => p.s === PIECE && p.a === undefined)).toBe(true); // all thrown at once: none late
    // Of the ground: grass, dirt, stone; never TNT.
    for (const p of debris) expect([Material.Grass, Material.Dirt, Material.Stone]).toContain(p.m);
    // Some time later they've all landed and are there (placed together: one result).
    const { landed } = e.tick(FUSE_MS + 6000);
    expect(landed.length).toBe(1);
    expect(e.count).toBe(0);
    let found = 0;
    for (const p of debris) {
      const path = unpackDebris(p), end = path.at(-1)!;
      const at = (c: number) => Math.round(c / PIECE) * PIECE + PIECE / 2;
      const m = w.materialAtUnit(at(end[0]), at(end[1]), at(end[2]));
      if (m === p.m) found++;
    }
    expect(found).toBeGreaterThan(MAX_PIECES / 2);
  });

  it('throws what there is time for each tick (at least one piece), the rest on later ticks', () => {
    const w = flat();
    const t = { x: 7000 * M, y: 0, z: 7000 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: seededRandom(), debrisBudgetMs: 0 });
    e.light(t, 0);
    expect(e.tick(FUSE_MS).announced.length).toBe(1); // (carved, and its debris thrown, from the next)
    const first = e.tick(FUSE_MS);
    expect(first.blasts.length).toBe(1);
    expect(first.debris.length).toBe(1);
    expect(first.debris[0]!.a).toBeUndefined();
    let thrown = 1, ticks = 1;
    while (e.count && ticks < 2000) {
      const now = FUSE_MS + 50 * ticks++;
      const r = e.tick(now);
      expect(r.debris.length).toBe(1);
      // Thrown late: it says how long it's been flying (since its blast).
      expect(r.debris[0]!.a).toBe(now - FUSE_MS);
      thrown += r.debris.length;
    }
    expect(thrown).toBe(MAX_PIECES);
    expect(e.count).toBe(0);
  });

  it("doesn't keep debris in survival", () => {
    const w = flat();
    const t = { x: 6000 * M, y: 0, z: 6000 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { keepDebris: () => false });
    e.light(t, 0);
    expect(blow(e, FUSE_MS).debris.length).toBeGreaterThan(0);
    expect(e.tick(FUSE_MS + 6000).landed).toEqual([]);
  });

  it('picks whole-grid pieces of what was taken out, never TNT or water, at most as many as asked', () => {
    const removed = [
      { x: 0, y: 0, z: 0, size: 16, material: Material.Stone }, // 8 pieces
      { x: 16, y: 0, z: 0, size: 4, material: Material.Dirt }, // inside one piece
      { x: 20, y: 0, z: 0, size: 4, material: Material.Dirt },
      { x: 32, y: 0, z: 0, size: 16, material: Material.TNT },
      { x: 48, y: 0, z: 0, size: 16, material: Material.Water },
    ];
    // Few (66 cells: 64 of the stone, 2 of dirt): all of them.
    const all = pickPieces(removed, 100, seededRandom());
    expect(all.length).toBe(66);
    expect(all.every((p) => p.x % PIECE === 0 && p.y % PIECE === 0 && p.z % PIECE === 0)).toBe(true);
    expect(all.filter((p) => p.material === Material.Dirt).sort((a, b) => a.x - b.x)).toEqual([{ x: 16, y: 0, z: 0, material: Material.Dirt }, { x: 20, y: 0, z: 0, material: Material.Dirt }]);
    expect(new Set(all.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(66);
    expect(pickPieces(removed, 3, seededRandom()).length).toBe(3);
  });

  it('picks from a big blast by volume, without listing every cell', () => {
    // 1000 whole 1 m voxels (64 000 cells), and a hundred 1/16 m ones: 500 asked for.
    const removed = [
      ...Array.from({ length: 1000 }, (_, i) => ({ x: (i % 10) * 16, y: Math.floor(i / 100) * 16, z: (Math.floor(i / 10) % 10) * 16, size: 16, material: i % 2 ? Material.Stone : Material.Dirt })),
      ...Array.from({ length: 100 }, (_, i) => ({ x: 400 + i, y: 0, z: 0, size: 1, material: Material.Sand })),
      { x: 800, y: 0, z: 0, size: 16, material: Material.TNT },
    ];
    const picked = pickPieces(removed, 500, seededRandom(7));
    expect(picked.length).toBe(500);
    expect(new Set(picked.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(500);
    expect(picked.every((p) => p.x % PIECE === 0 && p.y % PIECE === 0 && p.z % PIECE === 0)).toBe(true);
    expect(picked.some((p) => p.material === Material.TNT)).toBe(false);
    // Each where its voxel was, of its material.
    const whole = new Map(removed.filter((v) => v.size === 16).map((v) => [`${v.x},${v.y},${v.z}`, v.material]));
    for (const p of picked) {
      if (p.material === Material.Sand) expect(p.x >= 400 && p.x < 500 && p.y === 0 && p.z === 0).toBe(true);
      else expect(whole.get(`${Math.floor(p.x / 16) * 16},${Math.floor(p.y / 16) * 16},${Math.floor(p.z / 16) * 16}`)).toBe(p.material);
    }
    // By volume: stone and dirt about half each; the sand (a 25-cell sliver) hardly at all.
    const stone = picked.filter((p) => p.material === Material.Stone).length;
    expect(stone).toBeGreaterThan(200);
    expect(stone).toBeLessThan(300);
    expect(picked.filter((p) => p.material === Material.Sand).length).toBeLessThan(5);
  });
});

describe('touching TNT', () => {
  it('goes off as one, bigger: the square root of the volume, up to 16 m', () => {
    expect(blastRadius(16 ** 3)).toBe(64);
    expect(blastRadius(4 * 16 ** 3)).toBe(128);
    expect(blastRadius(9 * 16 ** 3)).toBe(192);
    expect(blastRadius(100 * 16 ** 3)).toBe(MAX_BLAST_RADIUS);
    expect(blastRadius(8 ** 3)).toBeCloseTo(64 / Math.sqrt(8), 9);
  });

  it('finds TNT sharing faces, not just corners', () => {
    const w = flat();
    const at = (bx: number, by: number, bz: number) => ({ x: (7000 + bx) * M, y: by * M, z: (7000 + bz) * M, size: 16 });
    const touching = [at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(1, 1, 1)], corner = at(2, 2, 2), apart = at(4, 0, 0);
    for (const t of [...touching, corner, apart]) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const key = (t: { x: number; y: number; z: number }) => `${t.x},${t.y},${t.z}`;
    expect(w.explosiveCluster({ ...touching[0]!, material: Material.TNT }).map(key).sort()).toEqual(touching.map(key).sort());
  });

  it('has C4: a 1/8 m voxel blows 2.3 m, and C4 touching TNT goes off with it, adding up', () => {
    const w = flat();
    const c4 = { x: 7500 * M, y: 0, z: 7500 * M, size: 2 };
    w.applyEdit({ op: 'place', ...c4, material: Material.C4 });
    expect(w.explosiveAt(c4.x + 1, 1, c4.z + 1)).toEqual({ ...c4, material: Material.C4 });
    const e = new Explosives(w, { random: seededRandom(2), debrisBudgetMs: Infinity });
    expect(e.light(c4, 0)).toBe(FUSE_MS);
    const { blasts, debris } = blow(e, FUSE_MS);
    expect(blasts.length).toBe(1);
    expect(blasts[0]!.radius).toBeCloseTo(64 * Math.sqrt(0.32), 9); // 2.26 m
    expect(blasts[0]!.x).toBe(c4.x + 1);
    expect(debris.length).toBe(MAX_PIECES);
    expect(debris.some((p) => p.m === Material.C4)).toBe(false);
    expect(w.explosiveAt(c4.x + 1, 1, c4.z + 1)).toBeNull();
    // A 1 m TNT block with a 1/8 m C4 voxel stuck to its side: their power added, from between them (by power).
    const t = { x: 7600 * M, y: 0, z: 7600 * M, size: 16 }, stuck = { x: 7600 * M + 16, y: 0, z: 7600 * M, size: 2 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    w.applyEdit({ op: 'place', ...stuck, material: Material.C4 });
    e.light(t, 10_000);
    const both = blow(e, 10_000 + FUSE_MS).blasts;
    expect(both.length).toBe(1);
    const pt = tntEquivalent(Material.TNT, 16 ** 3), pc = tntEquivalent(Material.C4, 2 ** 3);
    expect(both[0]!.radius).toBeCloseTo(blastRadius(pt + pc), 9);
    expect(both[0]!.radius).toBeGreaterThan(8 * M); // more than the TNT alone
    expect(both[0]!.x).toBeCloseTo(((t.x + 8) * pt + (stuck.x + 1) * pc) / (pt + pc), 9);
    expect(w.explosiveAt(stuck.x + 1, 1, stuck.z + 1)).toBeNull();
  });

  it('blows a 2 x 2 x 1 block of TNT once, 16 m (the most), from its middle', () => {
    const w = flat();
    const at = (bx: number, bz: number) => ({ x: (8000 + bx) * M, y: 0, z: (8000 + bz) * M, size: 16 });
    const four = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
    for (const t of four) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.5, debrisBudgetMs: Infinity });
    e.light(four[0]!, 0);
    const { blasts } = blow(e, FUSE_MS);
    expect(blasts.length).toBe(1);
    expect(blasts[0]).toMatchObject({ x: 8001 * M, y: 8, z: 8001 * M, radius: MAX_BLAST_RADIUS });
    expect(blasts[0]!.lit).toEqual([]);
    for (const t of four) expect(w.explosiveAt(t.x + 4, 4, t.z + 4)).toBeNull();
    expect(e.count).toBe(0);
    // 16 m: well below where a single block's 8 m reaches.
    expect(solid(w, 8001 * M, -12 * M, 8001 * M)).toBe(false);
  });
});
