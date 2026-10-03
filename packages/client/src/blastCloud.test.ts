import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_CHUNK, GRAVITY, Material, craterShape, emptyChunk, type Chunk } from '@super-vox/shared';
import { CLOUD_FLIGHT_S, CLOUD_PIECE, CLOUD_REST_S, CLOUD_SIZES, blastCloud, type ChunkAt } from './blastCloud.js';

const M = 16;

/** A flat world: `below` (uniform 1 m blocks) under y = 0, air above; chunks made once each. */
function flatWorld(below: (cx: number, cz: number) => number = () => Material.Stone): ChunkAt {
  const made = new Map<string, Chunk | null>();
  return (cx, cy, cz) => {
    if (cy >= 0) return null;
    const key = `${cx},${cy},${cz}`;
    if (!made.has(key)) {
      const c = emptyChunk({ cx, cy, cz });
      for (let i = 0; i < BLOCKS_PER_CHUNK; i++) c.blocks[i] = { kind: 'uniform', size: 16, material: below(cx, cz) };
      made.set(key, c);
    }
    return made.get(key)!;
  };
}

/** Cells (1/4 m) a blast at (x, y, z) of `r` takes out of the flat ground (their middles within r, below 0). */
function cellsBelow(x: number, y: number, z: number, r: number): number {
  let n = 0;
  const P = CLOUD_PIECE;
  for (let cy = Math.floor((y - r) / P) * P; cy < 0; cy += P)
    for (let cz = Math.floor((z - r) / P) * P; cz <= z + r; cz += P)
      for (let cx = Math.floor((x - r) / P) * P; cx <= x + r; cx += P)
        if ((cx + P / 2 - x) ** 2 + (cy + P / 2 - y) ** 2 + (cz + P / 2 - z) ** 2 <= r * r) n++;
  return n;
}

describe('blastCloud', () => {
  const x = 500 * M + 8, z = 500 * M + 8, r = 4 * M;

  it('takes every solid cell the blast takes out (a few thousand), the same for the same seed', () => {
    const a = blastCloud(flatWorld(), x, 8, z, r, 42);
    expect(a.count).toBe(cellsBelow(x, 8, z, r));
    expect(a.count).toBeGreaterThan(3000);
    for (let i = 0; i < a.count; i++) {
      const [sx, sy, sz] = [a.start[i * 3]! * M, a.start[i * 3 + 1]! * M, a.start[i * 3 + 2]! * M];
      expect((sx - x) ** 2 + (sy - 8) ** 2 + (sz - z) ** 2).toBeLessThanOrEqual(r * r + 1e-6);
      expect(sy).toBeLessThan(0);
      expect(a.material[i]).toBe(Material.Stone);
    }
    // Everyone's alike (same world, same seed); another seed throws them otherwise.
    const b = blastCloud(flatWorld(), x, 8, z, r, 42);
    expect(b.velocity).toEqual(a.velocity);
    expect(b.land).toEqual(a.land);
    const c = blastCloud(flatWorld(), x, 8, z, r, 43);
    expect(c.velocity).not.toEqual(a.velocity);
  });

  it('takes at most `max`, a fair spread of them', () => {
    const all = blastCloud(flatWorld(), x, 8, z, r, 1);
    const some = blastCloud(flatWorld(), x, 8, z, r, 1, 500);
    expect(some.count).toBe(500);
    const keys = new Set<string>();
    for (let i = 0; i < some.count; i++) keys.add(`${some.start[i * 3]},${some.start[i * 3 + 1]},${some.start[i * 3 + 2]}`);
    expect(keys.size).toBe(500);
    // From all over the crater: as deep on average as all of them, near enough.
    const meanY = (cl: typeof all) => cl.start.filter((_, i) => i % 3 === 1).reduce((s, v) => s + v, 0) / cl.count;
    expect(Math.abs(meanY(some) - meanY(all))).toBeLessThan(0.15);
  });

  it('flies each on its arc to the ground as it will be (the crater cut out), and is gone a while after', () => {
    const cl = blastCloud(flatWorld(), x, 8, z, r, 9);
    let landed = 0, outside = 0, tops = 0;
    for (let i = 0; i < cl.count; i++) {
      const tl = cl.land[i * 4 + 3]!, gone = cl.spin[i * 4 + 3]!;
      if (tl > 1e5) {
        expect(gone).toBe(CLOUD_FLIGHT_S);
        continue;
      }
      landed++;
      expect(gone).toBeCloseTo(tl + CLOUD_REST_S, 5);
      // Where the arc is then.
      const [lx, ly, lz] = [cl.land[i * 4]!, cl.land[i * 4 + 1]!, cl.land[i * 4 + 2]!];
      expect(lx).toBeCloseTo(cl.start[i * 3]! + cl.velocity[i * 3]! * tl, 3);
      expect(lz).toBeCloseTo(cl.start[i * 3 + 2]! + cl.velocity[i * 3 + 2]! * tl, 3);
      const arcY = cl.start[i * 3 + 1]! + cl.velocity[i * 3 + 1]! * tl - 0.5 * GRAVITY * tl * tl;
      // Resting on the ground: 0 outside the crater, its bottom (on 1 m columns) inside.
      const R = r / M;
      // The ground there: flat at 0, the crater's sphere cut out of it (exactly).
      const d2 = (lx - x / M) ** 2 + (lz - z / M) ** 2;
      const grounds = [d2 < R * R ? Math.min(0, 8 / M - Math.sqrt(R * R - d2)) : 0];
      // (Found to 1/30 s / 32: within a little of the arc.)
      expect(Math.abs(arcY - ly)).toBeLessThan(0.11);
      const tops_ = grounds.map((g) => g + cl.size[i]! / 2);
      if (tops_.some((t) => Math.abs(ly - t) < 2e-3)) tops++; // (32-bit floats)
      else expect(ly).toBeLessThan(Math.max(...tops_)); // run into the side of higher ground: stays where it hit
      if (d2 >= R * R) outside++;
    }
    expect(landed).toBeGreaterThan(cl.count * 0.95);
    expect(tops).toBeGreaterThan(landed * 0.5); // the rest hit the crater's walls
    expect(outside).toBeGreaterThan(cl.count * 0.3); // thrown out of the crater
    expect(cl.end).toBeLessThanOrEqual(CLOUD_FLIGHT_S + CLOUD_REST_S);
  });

  it("leaves out water and TNT, and is nothing where the world isn't here", () => {
    const water = blastCloud(flatWorld(() => Material.Water), x, 8, z, r, 1);
    expect(water.count).toBe(0);
    const tnt = blastCloud(flatWorld(() => Material.TNT), x, 8, z, r, 1);
    expect(tnt.count).toBe(0);
    expect(blastCloud(flatWorld(() => Material.C4), x, 8, z, r, 1).count).toBe(0);
    const none = blastCloud(() => undefined, x, 8, z, r, 1);
    expect(none.count).toBe(0);
    expect(none.end).toBe(0);
  });

  it('throws its dust toward the open air it is told of (out of a wall), not just up', () => {
    const mean = (cl: ReturnType<typeof blastCloud>, axis: number) => cl.velocity.filter((_, i) => i % 3 === axis).reduce((a, v) => a + v, 0) / cl.count;
    const up = blastCloud(flatWorld(), x, 8, z, r, 5);
    const side = blastCloud(flatWorld(), x, 8, z, r, 5, undefined, [-1, 0, 0]);
    expect(Math.abs(mean(up, 0))).toBeLessThan(0.5);
    expect(mean(side, 0)).toBeLessThan(-3); // out toward -x
    expect(mean(side, 1)).toBeLessThan(mean(up, 1)); // and less up
  });

  it('comes in sizes: half 1/16 m, 30% 1/8 m, 15% 1/4 m, 5% 1/2 m', () => {
    const cl = blastCloud(flatWorld(), x, 8, z, r, 11);
    for (const { size, share } of CLOUD_SIZES) {
      const n = cl.size.filter((s) => Math.abs(s - size / M) < 1e-6).length;
      expect(Math.abs(n / cl.count - share)).toBeLessThan(0.02);
    }
    expect(cl.size.every((s) => CLOUD_SIZES.some((c) => Math.abs(s - c.size / M) < 1e-6))).toBe(true);
  });

  it("with the crater's seed, takes exactly the cells the shaped crater takes out (as the server carves it)", () => {
    const shape = craterShape(r, 77);
    const cl = blastCloud(flatWorld(), x, 8, z, r, 5, undefined, [0, 1, 0], 77);
    let expected = 0;
    const P = CLOUD_PIECE, o = Math.ceil(shape.outer / P) * P + P;
    for (let cy = -o; cy < 0; cy += P)
      for (let cz = Math.floor((z - o) / P) * P; cz <= z + o; cz += P)
        for (let cx = Math.floor((x - o) / P) * P; cx <= x + o; cx += P)
          if (shape.contains(cx + P / 2 - x, cy + P / 2 - 8, cz + P / 2 - z)) expected++;
    expect(cl.count).toBe(expected);
    expect(cl.count).not.toBe(cellsBelow(x, 8, z, r)); // not the sphere's
    for (let i = 0; i < cl.count; i++) expect(shape.contains(cl.start[i * 3]! * M - x, cl.start[i * 3 + 1]! * M - 8, cl.start[i * 3 + 2]! * M - z)).toBe(true);
  });
});
