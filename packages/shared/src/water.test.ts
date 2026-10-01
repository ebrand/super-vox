import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, packVoxel, rasterizeVoxels, type Block } from './chunk.js';
import { Material, MAX_FLOW, isWater, waterMaterial } from './materials.js';
import { blockVoxels } from './edit.js';
import { PlateHeights, defaultPlateTerrain } from './plates.js';
import { TerrainGenerator } from './terrain.js';
import { WaterFlow, blockHasAir, blockHasRoom, blockWater, chunkWithoutWater, setBlockWater, waterHeight, withoutWater, type WaterWorld } from './water.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM } from './world.js';

/** Material per unit cell of a block (0 = air). */
function cells(block: Block): Uint16Array {
  const out = new Uint16Array(BLOCK_SIZE ** 3);
  for (const v of blockVoxels(block)) {
    for (let y = v.y; y < v.y + v.size; y++) for (let z = v.z; z < v.z + v.size; z++) for (let x = v.x; x < v.x + v.size; x++) out[x + BLOCK_SIZE * (z + BLOCK_SIZE * y)] = v.material;
  }
  return out;
}

/** A block with stone voxels of mixed sizes along its floor and one wall. */
const rocky: Block = (() => {
  const packed = [packVoxel(0, 0, 0, 8), packVoxel(8, 0, 0, 4), packVoxel(0, 8, 0, 2), packVoxel(12, 12, 12, 4), packVoxel(3, 9, 5, 1)];
  const block: Block = { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(packed, () => Material.Stone) };
  rasterizeVoxels(block);
  return block;
})();

describe('water in a block', () => {
  for (const [name, block] of [['empty', null], ['rocky', rocky], ['grid', { kind: 'grid', size: 4, materials: Uint16Array.from({ length: 64 }, (_, i) => (i % 3 ? 0 : Material.Dirt)) }]] as [string, Block][]) {
    it(`fills every open cell and nothing else, and comes out again (${name})`, () => {
      const before = cells(block);
      for (const level of [0, 3]) {
        const wet = setBlockWater(block, level);
        const after = cells(wet);
        // Flowing water stands lower in its block than a source.
        let wrong = 0;
        for (let i = 0; i < after.length; i++) {
          const y = Math.floor(i / 256);
          if (after[i] !== (before[i] ? before[i] : y < waterHeight(level) ? waterMaterial(level) : 0)) wrong++;
        }
        expect(wrong).toBe(0);
        expect(blockWater(wet)).toBe(level);
        expect(blockHasAir(wet, waterHeight(level))).toBe(false);
        expect(blockHasRoom(wet)).toBe(true);
        expect(cells(withoutWater(wet))).toEqual(before);
        // Changing the level replaces the water.
        expect(blockWater(setBlockWater(wet, 5))).toBe(5);
        expect(blockWater(setBlockWater(wet, null))).toBeNull();
      }
    });
  }

  it('fills only below a height when asked (the sea surface)', () => {
    const wet = cells(setBlockWater(rocky, 0, 10));
    const dry = cells(rocky);
    for (let y = 0; y < BLOCK_SIZE; y++) for (let i = 0; i < 256; i++) {
      const k = y * 256 + i;
      expect(wet[k]).toBe(dry[k] ? dry[k] : y < 10 ? Material.Water : 0);
    }
    expect(setBlockWater(rocky, 0, 0)).toBe(rocky);
  });

  it('knows solid blocks have no room, and leaves them alone', () => {
    const stone: Block = { kind: 'uniform', size: BLOCK_SIZE, material: Material.Stone };
    expect(blockHasRoom(stone)).toBe(false);
    expect(setBlockWater(stone, 0)).toBe(stone);
    expect(blockHasRoom(null)).toBe(true);
    expect(blockWater(null)).toBeNull();
    // Water-only blocks strip to nothing; others keep their identity when they have no water.
    expect(withoutWater(setBlockWater(null, 0))).toBeNull();
    expect(withoutWater(rocky)).toBe(rocky);
  });
});

/** A world of 1 m blocks in a box (outside it: undefined, which water treats as solid). */
function blockWorld(size: [number, number, number]) {
  const blocks = new Map<string, Block>();
  const inside = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < size[0] && y < size[1] && z < size[2];
  const world: WaterWorld & { solid(x: number, y: number, z: number): void; water(x: number, y: number, z: number, level?: number): void; level(x: number, y: number, z: number): number | null } = {
    getBlock: (x, y, z) => (inside(x, y, z) ? blocks.get(`${x},${y},${z}`) ?? null : undefined),
    setBlock: (x, y, z, b) => void blocks.set(`${x},${y},${z}`, b),
    solid: (x, y, z) => void blocks.set(`${x},${y},${z}`, { kind: 'uniform', size: BLOCK_SIZE, material: Material.Stone }),
    water: (x, y, z, level = 0) => void blocks.set(`${x},${y},${z}`, setBlockWater(null, level)),
    level: (x, y, z) => blockWater(blocks.get(`${x},${y},${z}`) ?? null),
  };
  return world;
}

const settle = (flow: WaterFlow, w: WaterWorld, steps = 60) => {
  for (let i = 0; i < steps && flow.pending > 0; i++) flow.step(w);
  return flow.pending;
};

describe('water flow', () => {
  it('spreads over a floor one level weaker per block, up to MAX_FLOW from its source', () => {
    const w = blockWorld([30, 3, 1]);
    for (let x = 0; x < 30; x++) w.solid(x, 0, 0);
    w.water(5, 1, 0);
    const flow = new WaterFlow();
    flow.touch(5, 1, 0);
    expect(settle(flow, w)).toBe(0);
    for (let x = 0; x < 30; x++) {
      const d = Math.abs(x - 5);
      expect(w.level(x, 1, 0)).toBe(d <= MAX_FLOW ? d : null);
      expect(w.level(x, 2, 0)).toBeNull();
    }
  });

  it('spreads a block per step', () => {
    const w = blockWorld([20, 2, 1]);
    for (let x = 0; x < 20; x++) w.solid(x, 0, 0);
    w.water(0, 1, 0);
    const flow = new WaterFlow();
    flow.touch(0, 1, 0);
    flow.step(w);
    flow.step(w);
    flow.step(w);
    expect([1, 2, 3, 4].map((x) => w.level(x, 1, 0))).toEqual([1, 2, 3, null]);
  });

  it('falls off a ledge and spreads again below, instead of spreading over open space', () => {
    // A shelf at y = 3 for x < 4, the floor at y = 0.
    const w = blockWorld([12, 6, 1]);
    for (let x = 0; x < 12; x++) w.solid(x, 0, 0);
    for (let x = 0; x < 4; x++) w.solid(x, 3, 0);
    w.water(1, 4, 0);
    const flow = new WaterFlow();
    flow.touch(1, 4, 0);
    settle(flow, w);
    expect(w.level(3, 4, 0)).toBe(2);
    expect(w.level(4, 4, 0)).toBe(3); // spills over the edge...
    expect(w.level(5, 4, 0)).toBeNull(); // ...but doesn't spread over air
    expect([3, 2, 1].map((y) => w.level(4, y, 0))).toEqual([1, 1, 1]); // falls
    expect([5, 6, 11].map((x) => w.level(x, 1, 0))).toEqual([2, 3, null]); // and spreads from where it lands
  });

  it('dries up when its source is taken away', () => {
    const w = blockWorld([12, 2, 1]);
    for (let x = 0; x < 12; x++) w.solid(x, 0, 0);
    w.water(2, 1, 0);
    const flow = new WaterFlow();
    flow.touch(2, 1, 0);
    settle(flow, w);
    expect(w.level(6, 1, 0)).toBe(4);
    w.solid(2, 1, 0);
    flow.touch(2, 1, 0);
    expect(settle(flow, w)).toBe(0);
    for (let x = 0; x < 12; x++) expect(w.level(x, 1, 0)).toBeNull();
  });

  it('makes a new source between two sources over solid ground, not over open space', () => {
    const w = blockWorld([5, 3, 1]);
    for (let x = 0; x < 5; x++) w.solid(x, 0, 0);
    w.water(1, 1, 0);
    w.water(3, 1, 0);
    const flow = new WaterFlow();
    flow.touch(2, 1, 0);
    settle(flow, w);
    expect(w.level(2, 1, 0)).toBe(0);
    // Over a hole: it falls instead.
    const v = blockWorld([5, 3, 1]);
    for (const x of [0, 1, 3, 4]) v.solid(x, 0, 0);
    v.water(1, 1, 0);
    v.water(3, 1, 0);
    const f2 = new WaterFlow();
    f2.touch(2, 1, 0);
    settle(f2, v);
    expect(v.level(2, 1, 0)).not.toBe(0);
    expect(v.level(2, 0, 0)).toBe(1);
  });

  it('fills the open part of a partly solid block, and refills it when more is dug', () => {
    const w = blockWorld([3, 2, 1]);
    for (let x = 0; x < 3; x++) w.solid(x, 0, 0);
    w.setBlock(1, 1, 0, rocky);
    w.water(0, 1, 0);
    w.water(2, 1, 0);
    const flow = new WaterFlow();
    flow.touch(1, 1, 0);
    settle(flow, w);
    const wet = w.getBlock(1, 1, 0)!;
    expect(blockWater(wet)).toBe(0);
    expect(blockHasAir(wet)).toBe(false);
    // Dig out the big voxel: the block refills.
    const dug = blockVoxels(wet).filter((v) => !(v.size === 8 && v.material === Material.Stone));
    w.setBlock(1, 1, 0, { kind: 'voxels', packed: Uint16Array.from(dug, (v) => packVoxel(v.x, v.y, v.z, v.size)), materials: Uint16Array.from(dug, (v) => v.material) });
    expect(blockHasAir(w.getBlock(1, 1, 0)!)).toBe(true);
    flow.touch(1, 1, 0);
    settle(flow, w);
    expect(blockHasAir(w.getBlock(1, 1, 0)!)).toBe(false);
  });

  it('leaves enclosed space dry', () => {
    const w = blockWorld([5, 4, 1]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) if (!(x === 2 && y === 1)) w.solid(x, y, 0);
    for (let x = 0; x < 5; x++) w.water(x, 3, 0);
    const flow = new WaterFlow();
    for (let x = 0; x < 5; x++) flow.touch(x, 3, 0);
    settle(flow, w);
    expect(w.level(2, 1, 0)).toBeNull();
  });
});

describe('the sea in generated chunks', () => {
  const src = new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(9), mountains: 0 });
  const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, src);

  it('fills every open cell below sea level with source water, and none above', () => {
    // A coastal column (seed 9's beach near 2992, 10226 m) and the open sea next to it.
    for (const [cx, cz] of [[Math.floor((2992 * 16) / CHUNK_SIZE), Math.floor((10226 * 16) / CHUNK_SIZE)], [Math.floor((2970 * 16) / CHUNK_SIZE), Math.floor((10226 * 16) / CHUNK_SIZE)]]) {
      const r = gen.columnRange(cx!, cz!);
      expect(r.maxY).toBeGreaterThanOrEqual(src.seaLevel);
      for (let cy = Math.floor(r.minY / CHUNK_SIZE); cy <= Math.floor(r.maxY / CHUNK_SIZE) + 1; cy++) {
        const chunk = gen.generateChunk({ cx: cx!, cy, cz: cz! });
        let wrong = 0, wet = 0;
        chunk.blocks.forEach((b, i) => {
          const by = Math.floor(i / 256), y0 = cy * CHUNK_SIZE + by * BLOCK_SIZE;
          if (y0 >= src.seaLevel && (b === null || blockWater(b) === null)) return; // dry above the sea
          const c = cells(b ?? null);
          for (let k = 0; k < c.length; k++) {
            const y = y0 + Math.floor(k / 256), m = c[k]!;
            if (isWater(m)) wet++;
            if (y < src.seaLevel ? m === 0 || (isWater(m) && m !== Material.Water) : isWater(m)) wrong++;
          }
        });
        expect(wrong).toBe(0);
        if (cy * CHUNK_SIZE + CHUNK_SIZE <= src.seaLevel) expect(wet).toBeGreaterThan(0);
        // Taking the water out gives the dry terrain back.
        for (const b of chunkWithoutWater(chunk).blocks) expect(b === null || blockWater(b) === null).toBe(true);
      }
    }
  });
});
