import { describe, expect, it } from 'vitest';
import { Biome } from './biomes.js';
import { rasterizeVoxels, voxelAt, type Chunk } from './chunk.js';
import { Material } from './materials.js';
import { PlateHeights, defaultPlateTerrain, migratePlateTerrain, type PlateTerrainConfig } from './plates.js';
import { TerrainGenerator, type HeightSource } from './terrain.js';
import { TREE_REACH, TreeKind, plantTrees, type Tree } from './trees.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM } from './world.js';

const cache = new Map<string, PlateHeights>();
const world = (over: Partial<PlateTerrainConfig> = {}) => {
  const cfg = { ...defaultPlateTerrain(9), mountains: 0, ...over };
  const key = JSON.stringify(cfg);
  let p = cache.get(key);
  if (!p) cache.set(key, (p = new PlateHeights(FLAT_WORLD_16KM, cfg)));
  return p;
};
/** A 600 m square with plenty of temperate and boreal forest in seed 9. */
const BOX = [3500 * 16, 6300 * 16, 4100 * 16, 6900 * 16] as const;

describe('trees', () => {
  it('are deterministic, and a smaller box sees the same trees', () => {
    const p = world();
    const a = p.trees(...BOX), b = p.trees(...BOX);
    expect(a.length).toBeGreaterThan(500);
    expect(b).toEqual(a);
    const [x0, z0, x1, z1] = BOX, mx = (x0 + x1) / 2;
    const half = p.trees(x0, z0, mx, z1);
    const key = (t: Tree) => `${t.x},${t.z}`;
    const all = new Map(a.map((t) => [key(t), t]));
    for (const t of half) expect(all.get(key(t))).toEqual(t);
  });

  it('grow only on vegetated ground, with the kind of their biome', () => {
    const p = world();
    for (const t of p.trees(...BOX)) {
      const h = Int32Array.of(t.y);
      expect([Material.Grass, Material.TaigaFloor, Material.Meadow, Material.Tundra, Material.JungleFloor, Material.DryGrass]).toContain(p.materials(t.x, t.z, 1, 1, 1, h)[0]);
      const b = p.biomes(t.x, t.z, 1, 1, 1, h)![0]!;
      const expected = b === Biome.Jungle ? TreeKind.Jungle : b === Biome.Savanna ? TreeKind.Acacia : b === Biome.Boreal || b === Biome.Tundra ? TreeKind.Conifer : TreeKind.Broadleaf;
      expect(t.kind).toBe(expected);
      expect(t.y).toBeGreaterThan(p.seaLevel);
    }
  });

  it('thin out with lower density and vanish at 0 (and in older worlds)', () => {
    const n = (trees: number) => world({ trees }).trees(...BOX).length;
    expect(n(100)).toBeGreaterThan(n(50) * 1.4);
    expect(n(50)).toBeGreaterThan(n(20) * 1.8);
    expect(n(0)).toBe(0);
    expect(migratePlateTerrain({}).trees).toBe(0);
  });

  /** Generates the chunks of a chunk column, bottom to top of its range. */
  const column = (gen: TerrainGenerator, cx: number, cz: number) => {
    const r = gen.columnRange(cx, cz);
    const out: Chunk[] = [];
    for (let cy = Math.floor(r.minY / CHUNK_SIZE) - 1; cy <= Math.floor(r.maxY / CHUNK_SIZE); cy++) out.push(gen.generateChunk({ cx, cy, cz }));
    return { chunks: out, range: r };
  };

  it('are planted as valid voxels on top of the ground, never replacing it', () => {
    const p = world();
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, p);
    // The same terrain without trees.
    const bare: HeightSource = { minHeight: p.minHeight, maxHeight: p.maxHeight, seaLevel: p.seaLevel, heights: p.heights.bind(p), materials: p.materials.bind(p) };
    const plain = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, bare);
    const t = p.trees(...BOX).find((q) => q.kind === TreeKind.Conifer)!;
    const cx = Math.floor(t.x / CHUNK_SIZE), cz = Math.floor(t.z / CHUNK_SIZE);
    const { chunks } = column(gen, cx, cz);
    let wood = 0, leaves = 0;
    for (const ch of chunks) {
      const ref = plain.generateChunk(ch);
      ch.blocks.forEach((b) => {
        if (b?.kind === 'voxels') rasterizeVoxels(b); // throws on overlaps or bad voxels
      });
      for (let y = 0; y < CHUNK_SIZE; y += 4) for (let z = 0; z < CHUNK_SIZE; z += 4) for (let x = 0; x < CHUNK_SIZE; x += 4) {
        const g = voxelAt(ref, x, y, z), v = voxelAt(ch, x, y, z);
        if (g) expect(v).toEqual(g); // ground untouched
        if (v?.material === Material.Wood) wood++;
        if (v?.material === Material.Needles) leaves++;
      }
    }
    expect(wood).toBeGreaterThan(0);
    expect(leaves).toBeGreaterThan(0);
  });

  it('continue across chunk borders, and columns include their tree tops', () => {
    const p = world();
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, p);
    // A tree whose trunk is within 2 m of its chunk's east edge, with a crown wider than that.
    const t = p.trees(...BOX).find((q) => CHUNK_SIZE - (q.x % CHUNK_SIZE) < 2 * 16 && q.crown > 2.5 * 16)!;
    expect(t).toBeDefined();
    const leaf = t.kind === TreeKind.Conifer ? Material.Needles : Material.Leaves;
    const cx = Math.floor(t.x / CHUNK_SIZE), cz = Math.floor(t.z / CHUNK_SIZE);
    // A height inside the crown: low in a conifer's cone, at a broadleaf's main blob.
    const crownY = Math.floor((t.y + (t.kind === TreeKind.Conifer ? t.height * 0.35 : t.blobs[0]!.dy)) / CHUNK_SIZE);
    const at = (dx: number) => {
      const ch = gen.generateChunk({ cx: cx + dx, cy: crownY, cz });
      let n = 0;
      for (const b of ch.blocks) if (b && b.kind !== 'uniform') for (const m of b.materials) if (m === leaf) n++;
      return n;
    };
    expect(at(0)).toBeGreaterThan(0);
    expect(at(1)).toBeGreaterThan(0);
    // Column ranges reach the tops of trees standing in them.
    const { range } = column(gen, cx, cz);
    expect(range.maxY).toBeGreaterThanOrEqual(t.y + t.height);
  });

  it('respect their reach (no voxels beyond TREE_REACH of the trunk)', () => {
    const chunk: Chunk = { cx: 0, cy: 0, cz: 0, blocks: new Array(4096).fill(null) };
    const t: Tree = { x: 128, y: 0, z: 128, kind: TreeKind.Jungle, height: 30 * 16, trunk: 16, crown: 9 * 16, blobs: [{ dx: 0, dy: 100, dz: 0, rx: 9 * 16, ry: 40 }] };
    plantTrees(chunk, [t]);
    for (let y = 0; y < CHUNK_SIZE; y += 8) for (let z = 0; z < CHUNK_SIZE; z += 8) for (let x = 0; x < CHUNK_SIZE; x += 8) {
      if (voxelAt(chunk, x, y, z)) expect(Math.hypot(x - t.x, z - t.z)).toBeLessThanOrEqual(TREE_REACH);
    }
  });
});
