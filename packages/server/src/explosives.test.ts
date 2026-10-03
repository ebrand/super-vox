import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MAX_BLAST_RADIUS, Material, blastRadius, defaultFlatGen, CHAIN_FUSE_MS, FUSE_MS, unpackDebris } from '@super-vox/shared';
import { Explosives, MAX_PIECES, pickPieces } from './explosives.js';
import { World } from './world.js';

/** A flat world (ground at 0: grass over dirt over stone, in 1/4 m voxels). */
const flat = () => new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
const M = 16;
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
    expect(w.tntAt(self.x + 3, 5, self.z + 9)).toEqual(self);
    const { tnt } = w.explode(self.x + 8, 8, self.z + 8, blastRadius(16 ** 3), new Set([`${self.x},${self.y},${self.z}`]));
    expect(tnt).toEqual([other]);
    expect(w.tntAt(self.x + 3, 5, self.z + 9)).toBeNull();
    expect(w.tntAt(other.x + 3, 5, other.z + 9)).toEqual(other);
    expect(w.tntAt(far.x + 3, 5, far.z + 9)).toEqual(far);
    expect(w.objectAt(2000, 0, 2002)).toBeUndefined();
  });
});

describe('Explosives', () => {
  it('blows lit TNT when its fuse runs out, lights what it catches, and not TNT taken away', () => {
    const w = flat();
    const a = { x: 3000 * M, y: 0, z: 3000 * M, size: 16 }, b = { x: 3002 * M, y: 0, z: 3000 * M, size: 16 }, c = { x: 3100 * M, y: 0, z: 3000 * M, size: 16 };
    for (const t of [a, b, c]) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.5, debrisBudgetMs: Infinity });
    expect(e.light(a, 0)).toBe(FUSE_MS);
    expect(e.light(a, 0)).toBeNull(); // already lit
    expect(e.tick(FUSE_MS - 1).blasts).toEqual([]);
    const [blast] = e.tick(FUSE_MS).blasts;
    expect(blast).toMatchObject({ x: a.x + 8, y: 8, z: a.z + 8, radius: 64 });
    expect(blast!.lit).toEqual([{ tnt: b, ms: (CHAIN_FUSE_MS[0] + CHAIN_FUSE_MS[1]) / 2 }]);
    expect(blast!.result).not.toBeNull();
    // The chained one goes off after its short fuse.
    expect(e.tick(FUSE_MS + 1000).blasts.map((x) => x.x)).toEqual([b.x + 8]);
    // Lit, then dug out before it blows: nothing.
    e.light(c, 0);
    w.applyEdit({ op: 'remove', x: c.x, y: c.y, z: c.z });
    expect(e.tick(FUSE_MS * 2).blasts).toEqual([]);
    expect(e.count).toBe(0);
  });
});

describe('debris', () => {
  it('throws pieces of what a blast took out, which stay where they land in creative', () => {
    const w = flat();
    const t = { x: 5000 * M, y: 0, z: 5000 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.37, keepDebris: () => true, debrisBudgetMs: Infinity });
    e.light(t, 0);
    const { debris } = e.tick(FUSE_MS);
    expect(debris.length).toBe(MAX_PIECES);
    // Of the ground: grass, dirt, stone; never TNT.
    for (const p of debris) expect([Material.Grass, Material.Dirt, Material.Stone]).toContain(p.m);
    // Some time later they've all landed and are there.
    const { landed } = e.tick(FUSE_MS + 6000);
    expect(landed.length).toBeGreaterThan(MAX_PIECES / 2);
    expect(e.count).toBe(0);
    let found = 0;
    for (const p of debris) {
      const path = unpackDebris(p), end = path.at(-1)!;
      const m = w.materialAtUnit(Math.round(end[0] / 8) * 8 + 4, Math.round(end[1] / 8) * 8 + 4, Math.round(end[2] / 8) * 8 + 4);
      if (m === p.m) found++;
    }
    expect(found).toBeGreaterThan(MAX_PIECES / 2);
  });

  it('throws what there is time for each tick (at least one piece), the rest on later ticks', () => {
    const w = flat();
    const t = { x: 7000 * M, y: 0, z: 7000 * M, size: 16 };
    w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.37, debrisBudgetMs: 0 });
    e.light(t, 0);
    const first = e.tick(FUSE_MS);
    expect(first.blasts.length).toBe(1);
    expect(first.debris.length).toBe(1);
    let thrown = 1, ticks = 1;
    while (e.count && ticks < 1000) {
      const r = e.tick(FUSE_MS + 50 * ticks++);
      expect(r.debris.length).toBe(1);
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
    expect(e.tick(FUSE_MS).debris.length).toBeGreaterThan(0);
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
    const all = pickPieces(removed, 100, () => 0);
    expect(all.length).toBe(9);
    expect(all.every((p) => p.x % 8 === 0 && p.y % 8 === 0 && p.z % 8 === 0)).toBe(true);
    expect(all.filter((p) => p.material === Material.Dirt)).toEqual([{ x: 16, y: 0, z: 0, material: Material.Dirt }]);
    expect(pickPieces(removed, 3, Math.random).length).toBe(3);
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
    expect(w.tntCluster(touching[0]!).map(key).sort()).toEqual(touching.map(key).sort());
  });

  it('blows a 2 x 2 x 1 block of TNT once, 8 m across, from its middle', () => {
    const w = flat();
    const at = (bx: number, bz: number) => ({ x: (8000 + bx) * M, y: 0, z: (8000 + bz) * M, size: 16 });
    const four = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
    for (const t of four) w.applyEdit({ op: 'place', ...t, material: Material.TNT });
    const e = new Explosives(w, { random: () => 0.5, debrisBudgetMs: Infinity });
    e.light(four[0]!, 0);
    const { blasts } = e.tick(FUSE_MS);
    expect(blasts.length).toBe(1);
    expect(blasts[0]).toMatchObject({ x: 8001 * M, y: 8, z: 8001 * M, radius: 128 });
    expect(blasts[0]!.lit).toEqual([]);
    for (const t of four) expect(w.tntAt(t.x + 4, 4, t.z + 4)).toBeNull();
    expect(e.count).toBe(0);
    // 8 m: well below where a single block's 4 m reaches.
    expect(solid(w, 8001 * M, -6 * M, 8001 * M)).toBe(false);
  });
});
