import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, Material, blastRadius, defaultFlatGen, CHAIN_FUSE_MS, FUSE_MS } from '@super-vox/shared';
import { Explosives } from './explosives.js';
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
    const { tnt } = w.explode(self.x + 8, 8, self.z + 8, blastRadius(16), self);
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
    const e = new Explosives(w, 6, () => 0.5);
    expect(e.light(a, 0)).toBe(FUSE_MS);
    expect(e.light(a, 0)).toBeNull(); // already lit
    expect(e.tick(FUSE_MS - 1)).toEqual([]);
    const [blast] = e.tick(FUSE_MS);
    expect(blast).toMatchObject({ x: a.x + 8, y: 8, z: a.z + 8, radius: 64 });
    expect(blast!.lit).toEqual([{ tnt: b, ms: (CHAIN_FUSE_MS[0] + CHAIN_FUSE_MS[1]) / 2 }]);
    expect(blast!.result).not.toBeNull();
    // The chained one goes off after its short fuse.
    expect(e.tick(FUSE_MS + 1000).map((x) => x.x)).toEqual([b.x + 8]);
    // Lit, then dug out before it blows: nothing.
    e.light(c, 0);
    w.applyEdit({ op: 'remove', x: c.x, y: c.y, z: c.z });
    expect(e.tick(FUSE_MS * 2)).toEqual([]);
    expect(e.count).toBe(0);
  });
});
