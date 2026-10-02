import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  EditError,
  FLAT_WORLD_16KM,
  Material,
  TerrainGenerator,
  decodeChunk,
  isWater,
  materialAt,
  type HeightSource,
} from '@super-vox/shared';
import { World } from './world.js';

const M = 16;
/** Land 3 m up for x < 500 m, sea floor 2 m down beyond; sea level 0. */
const coast: HeightSource = {
  heights: (x0, z0, w, d, step = 1) => {
    const out = new Int32Array(w * d);
    for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) out[i + w * j] = x0 + i * step < 500 * M ? 3 * M : -2 * M;
    return out;
  },
  minHeight: -2 * M,
  maxHeight: 3 * M,
  seaLevel: 0,
};

const makeWorld = () => new World(FLAT_WORLD_16KM, new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 0 }, coast));

/** Material of the unit cell at world (x, y, z) metres... in units. */
function materialOf(world: World, x: number, y: number, z: number): number {
  const c = { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) };
  const chunk = decodeChunk(world.getEncodedChunk(c)!);
  const mod = (v: number) => ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return materialAt(chunk, mod(x), mod(y), mod(z));
}

function settle(world: World, steps = 40): number {
  let changed = 0;
  for (let i = 0; i < steps && world.waterPending > 0; i++) changed += world.stepWater()?.changes.length ?? 0;
  return changed;
}

const Z = 1000 * M + 8;

describe('water in the world', () => {
  it('has a sea of source water over the sea floor, and none over land', () => {
    const w = makeWorld();
    expect(materialOf(w, 510 * M, -M, Z)).toBe(Material.Water);
    expect(materialOf(w, 510 * M, 0, Z)).toBe(0); // the surface
    expect(isWater(materialOf(w, 510 * M, -3 * M, Z))).toBe(false); // the floor
    expect(materialOf(w, 490 * M, M, Z)).not.toBe(0); // land is solid
  });

  it('lets the sea into a channel dug from it below its surface, wherever the digging starts', () => {
    const w = makeWorld();
    // A 1 m wide, 1 m deep channel from the sea (x = 500 m) 12 m into the land, its floor at 2 m.
    for (let x = 488; x < 500; x++) w.applyEdit({ op: 'removeBox', x: x * M, y: 2 * M, z: Z - 8, size: M });
    // Its floor is above the sea, so the sea doesn't come up into it.
    settle(w);
    expect(materialOf(w, 499 * M + 8, 2 * M + 8, Z)).toBe(0);
    // Deeper, dug from the land end towards the sea: down to 1 m below the sea's surface.
    for (let x = 488; x < 500; x++) for (const y of [1, 0, -1]) w.applyEdit({ op: 'removeBox', x: x * M, y: y * M, z: Z - 8, size: M });
    settle(w);
    // Below the surface the whole channel is sea (natural water: it stays and never runs dry).
    for (let x = 499; x >= 488; x--) expect(materialOf(w, x * M + 8, -M + 1, Z)).toBe(Material.Water);
    // At and above the surface it stays dry, and the sea never ran out over the land.
    expect(materialOf(w, 499 * M + 8, 8, Z)).toBe(0);
    expect(materialOf(w, 488 * M + 8, 3 * M + 8, Z - 16)).toBe(0);
  });

  it('spreads poured water over the land until it settles, keeping every drop', () => {
    const w = makeWorld();
    const y = 3 * M; // on the ground
    w.applyEdit({ op: 'place', x: 300 * M, y, z: Z - 8, size: 16, material: Material.Water });
    expect(materialOf(w, 300 * M + 8, y + 8, Z)).toBe(Material.PouredWater);
    settle(w, 200);
    expect(w.waterPending).toBe(0);
    // Every drop is still there (16 units deep in one block's worth), now spread thin and level.
    let total = 0;
    const depths: number[] = [];
    for (let x = 290; x <= 310; x++) {
      for (let z = 990; z <= 1010; z++) {
        let d = 0;
        while (d < 16 && materialOf(w, x * M + 8, y + d, z * M + 8) === Material.PouredWater) d++;
        total += d;
        if (d) depths.push(d);
      }
    }
    expect(total).toBe(16);
    expect(depths.length).toBeGreaterThan(4);
    expect(Math.max(...depths) - Math.min(...depths)).toBeLessThanOrEqual(1);
  });

  it("doesn't remove water as if it were solid, and lets solids push it out", () => {
    const w = makeWorld();
    expect(() => w.applyEdit({ op: 'remove', x: 520 * M, y: -M, z: Z })).toThrow(EditError);
    // Placing stone in the sea replaces the water there.
    w.applyEdit({ op: 'place', x: 520 * M, y: -M, z: Z - 8, size: 4, material: Material.Stone });
    expect(materialOf(w, 520 * M, -M, Z - 8)).toBe(Material.Stone);
    settle(w);
    expect(materialOf(w, 520 * M + 8, -M + 8, Z)).toBe(Material.Water); // the rest of the block is still water
    expect(materialOf(w, 520 * M, -M, Z - 8)).toBe(Material.Stone);
    // No room: a solid block.
    expect(() => w.applyEdit({ op: 'place', x: 400 * M, y: -5 * M, z: Z, size: 16, material: Material.Water })).toThrow(EditError);
  });
});
