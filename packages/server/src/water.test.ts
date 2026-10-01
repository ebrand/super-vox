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

  it('floods a channel dug from the sea into the land, as far as water flows', () => {
    const w = makeWorld();
    // A 1 m wide, 1 m deep channel from the sea (x = 500 m) 12 m into the land, its floor at 2 m.
    for (let x = 488; x < 500; x++) w.applyEdit({ op: 'removeBox', x: x * M, y: 2 * M, z: Z - 8, size: M });
    // Its floor is above the sea, so the sea doesn't flow up into it.
    settle(w);
    expect(materialOf(w, 499 * M + 8, 2 * M + 8, Z)).toBe(0);
    // Deeper: down to 1 m below the sea, so water can come in.
    for (let x = 488; x < 500; x++) for (const y of [1, 0, -1]) w.applyEdit({ op: 'removeBox', x: x * M, y: y * M, z: Z - 8, size: M });
    expect(settle(w)).toBeGreaterThan(0);
    expect(w.waterPending).toBe(0);
    // Below sea level the channel fills from the sea, weaker each block, as far as water flows
    // (one source beside each block: no new sources, as in Minecraft).
    for (let x = 499; x >= 488; x--) {
      const level = 500 - x;
      expect(materialOf(w, x * M + 8, -M + 1, Z)).toBe(level <= 7 ? Material.Water + level : 0);
    }
    // At and above the sea's surface it stays dry.
    expect(materialOf(w, 499 * M + 8, 8, Z)).toBe(0);

  });

  it('spreads placed water over the land, then dries up when its source is covered', () => {
    const w = makeWorld();
    const y = 3 * M; // on the ground
    w.applyEdit({ op: 'place', x: 300 * M, y, z: Z - 8, size: 16, material: Material.Water });
    expect(materialOf(w, 300 * M + 8, y + 8, Z)).toBe(Material.Water);
    settle(w);
    // Flowing water is shallower further out: level 3 stands 12/16 m deep, level 7 4/16 m.
    expect(materialOf(w, 303 * M + 8, y + 11, Z)).toBe(Material.Water + 3);
    expect(materialOf(w, 303 * M + 8, y + 12, Z)).toBe(0);
    expect(materialOf(w, 307 * M + 8, y + 3, Z)).toBe(Material.Water + 7);
    expect(materialOf(w, 307 * M + 8, y + 4, Z)).toBe(0);
    expect(materialOf(w, 308 * M + 8, y + 1, Z)).toBe(0);
    // Fill the source block with stone: the water drains away.
    w.applyEdit({ op: 'place', x: 300 * M, y, z: Z - 8, size: 16, material: Material.Stone });
    settle(w);
    for (const x of [301, 304, 307]) expect(materialOf(w, x * M + 8, y + 1, Z)).toBe(0);
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
