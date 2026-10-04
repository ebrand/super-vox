import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE } from './chunk.js';
import { CAVE_DEPTH, CAVE_ROOF, CAVE_ROOF_UNDER_WATER, caveColumn } from './caves.js';
import { PlateHeights, defaultPlateTerrain } from './plates.js';
import { TerrainGenerator, defaultVoxelize } from './terrain.js';
import { isWater } from './materials.js';
import { CHUNK_SIZE, WORLD_SHAPES } from './world.js';

const FLOOR = -1024 * 16;
const CX0 = 320;
const flat = (y: number) => new Int32Array(256).fill(y);
const dry = () => new Array<boolean>(256).fill(false);
/** Cave blocks over a square of columns (cx, cz from 0), as absolute block (x, y, z). */
function cavesIn(amount: number, cols: number, surface = flat(3200), wet = dry()) {
  const out: [number, number, number][] = [];
  // (Where caving regions are, for this seed: they're 700 blocks or so across.)
  for (let cz = 0; cz < cols; cz++)
    for (let cx = CX0; cx < CX0 + cols; cx++) {
      const c = caveColumn({ amount, seed: 5 }, cx, cz, surface, wet, FLOOR);
      if (!c) continue;
      for (let by = c.lo; by < c.hi; by++) for (let k = 0; k < 256; k++) if (c.mask[k + 256 * (by - c.lo)]) out.push([cx * 16 + (k % 16), by, cz * 16 + Math.floor(k / 16)]);
    }
  return out;
}

describe('caves', () => {
  const cells = cavesIn(50, 40);
  const at = new Set(cells.map((c) => c.join(',')));

  it('are none at 0, the same every time, rarer and smaller the lower the amount', () => {
    expect(cavesIn(0, 10)).toEqual([]);
    expect(cavesIn(50, 6)).toEqual(cavesIn(50, 6));
    expect(cells.length).toBeGreaterThan(1000);
    expect(cavesIn(10, 40).length).toBeLessThan(cells.length / 3);
    expect(cavesIn(100, 40).length).toBeGreaterThan(cells.length * 2);
  });

  it('keep rock over them (more under water) but at their entrances, and stay within reach of the surface', () => {
    const top = 3200 / BLOCK_SIZE;
    // Entrances: where the surface block is carved.
    const mouths = cells.filter(([, by]) => by === top - 1);
    for (const [x, by, z] of cells) {
      if (by >= top - CAVE_ROOF / BLOCK_SIZE) expect(mouths.some(([mx, , mz]) => Math.hypot(mx - x, mz - z) <= 28)).toBe(true);
      expect(by).toBeGreaterThanOrEqual(top - CAVE_DEPTH / BLOCK_SIZE);
    }
    const wet = cavesIn(50, 40, flat(3200), new Array<boolean>(256).fill(true));
    expect(wet.length).toBeGreaterThan(0);
    for (const [, by] of wet) expect(by).toBeLessThan(top - CAVE_ROOF_UNDER_WATER / BLOCK_SIZE);
  });

  it('are reached by entrances from the surface, down to the tunnels', () => {
    const top = 3200 / BLOCK_SIZE;
    const mouths = cells.filter(([, by]) => by === top - 1);
    expect(mouths.length).toBeGreaterThan(0);
    // From each entrance, through cave blocks: down to the highest tunnels (14 m or so) and on
    // into more cave than the entrance itself.
    let reached = 0;
    for (const m of mouths.slice(0, 40)) {
      const seen = new Set([m.join(',')]);
      let q = [m], deepest = top;
      while (q.length && seen.size < 3000) {
        const next: [number, number, number][] = [];
        for (const [x, y, z] of q)
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
            const c: [number, number, number] = [x + dx, y + dy, z + dz], k = c.join(',');
            if (seen.has(k) || !at.has(k)) continue;
            seen.add(k);
            deepest = Math.min(deepest, c[1]);
            next.push(c);
          }
        q = next;
      }
      if (top - deepest >= 10 && seen.size > 1500) reached++;
    }
    expect(reached).toBeGreaterThan(0);
  });

  it('run mostly level: through any cave block, the space runs much further across than up', () => {
    // From each cave block: how far the cave runs on through it upward and downward, and the
    // furthest of east-west and north-south.
    const run = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
      let n = 1;
      for (let s = 1; at.has(`${x + s * dx},${y + s * dy},${z + s * dz}`); s++) n++;
      for (let s = 1; at.has(`${x - s * dx},${y - s * dy},${z - s * dz}`); s++) n++;
      return n;
    };
    let up = 0, across = 0;
    for (const [x, y, z] of cells) {
      up += run(x, y, z, 0, 1, 0);
      across += Math.max(run(x, y, z, 1, 0, 0), run(x, y, z, 0, 0, 1));
    }
    expect(across / cells.length).toBeGreaterThan((2 * up) / cells.length);
  });

  it('are carved by the terrain generator: air (never water, even under the sea), their chunks in the column', () => {
    const world = WORLD_SHAPES['round-16x8'];
    const config = { ...defaultPlateTerrain(3, world), caves: 100 };
    const heights = new PlateHeights(world, config);
    const gen = new TerrainGenerator(world, defaultVoxelize(), heights);
    const ground = (cx: number, cz: number) => Math.min(...heights.heights(cx * CHUNK_SIZE, cz * CHUNK_SIZE, 16, 16, 16));
    // A column whose range reaches well below its ground (a cave under it), on land and under water.
    let land: [number, number] | null = null, sea: [number, number] | null = null;
    for (let cz = 60; cz < 200 && !(land && sea); cz += 5)
      for (let cx = 0; cx < 1000 && !(land && sea); cx += 7) {
        const r = gen.columnRange(cx, cz), g = ground(cx, cz);
        if (r.minY >= g - 8 * BLOCK_SIZE) continue;
        if (r.water && !sea) sea = [cx, cz];
        if (!r.water && !land) land = [cx, cz];
      }
    expect(land).not.toBeNull();
    expect(sea).not.toBeNull();
    for (const [cx, cz] of [land!, sea!]) {
      const r = gen.columnRange(cx, cz), g = ground(cx, cz);
      let air = 0;
      for (let cy = Math.floor(r.minY / CHUNK_SIZE); cy * CHUNK_SIZE < g - 3 * BLOCK_SIZE; cy++) {
        const chunk = gen.generateChunk({ cx, cy, cz });
        chunk.blocks.forEach((b, i) => {
          const y = cy * CHUNK_SIZE + Math.floor(i / 256) * BLOCK_SIZE;
          if (y + BLOCK_SIZE > g) return; // (only what's wholly under the lowest ground)
          if (!b) air++;
          else expect(b.kind === 'uniform' && isWater(b.material)).toBe(false);
        });
      }
      expect(air).toBeGreaterThan(0);
    }
    // Without caves, ranges are the ground's.
    const plain = new TerrainGenerator(world, defaultVoxelize(), new PlateHeights(world, { ...config, caves: 0 }));
    expect(plain.columnRange(land![0], land![1]).minY).toBe(ground(land![0], land![1]));
  }, 60_000);
});
