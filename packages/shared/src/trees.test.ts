import { describe, expect, it } from 'vitest';
import { Biome, classifyBiome, type BiomeId } from './biomes.js';
import { rasterizeVoxels, voxelAt, type Chunk } from './chunk.js';
import { Material } from './materials.js';
import { PlateHeights, defaultPlateTerrain, migratePlateTerrain, type PlateTerrainConfig } from './plates.js';
import { TerrainGenerator, type HeightSource } from './terrain.js';
import { CANOPY_EXACT_STEP, NO_CANOPY, TREE_MAX_HEIGHT, TREE_REACH, TreeKind, clumpFactors, clumpedChance, crownTop, plantTrees, treesIn, type Clumping, type GroundSampler, type Tree } from './trees.js';
import { emptyChunk, blockIndex } from './chunk.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM } from './world.js';

const cache = new Map<string, PlateHeights>();
const world = (over: Partial<PlateTerrainConfig> = {}) => {
  const cfg = { ...defaultPlateTerrain(9), mountains: 0, rivers: 0, lakes: 0, equator: 0, northTemperature: -6, southTemperature: 26, ...over };
  const key = JSON.stringify(cfg);
  let p = cache.get(key);
  if (!p) cache.set(key, (p = new PlateHeights(FLAT_WORLD_16KM, cfg)));
  return p;
};
/** A 600 m square of boreal forest in seed 9. */
const BOX = [3500 * 16, 6300 * 16, 4100 * 16, 6900 * 16] as const;
/** A 640 m square across a border between boreal and temperate forest in seed 9. */
const BORDER = [1300 * 16, 7360 * 16, 1940 * 16, 8000 * 16] as const;
const kindOf = (b: BiomeId) => (b === Biome.Jungle ? TreeKind.Jungle : b === Biome.Savanna ? TreeKind.Acacia : b === Biome.Boreal || b === Biome.Tundra ? TreeKind.Conifer : TreeKind.Broadleaf);
/** Trees with a tree of another kind within 20 m. */
const mixed = (trees: Tree[]) => trees.filter((t) => trees.some((u) => u.kind !== t.kind && Math.hypot(u.x - t.x, u.z - t.z) < 20 * 16)).length;

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

  it('grow only on vegetated ground, with the kind of their biome (sharp borders)', () => {
    const p = world({ biomeBlend: 0 });
    for (const t of [...p.trees(...BOX), ...p.trees(...BORDER)]) {
      const h = Int32Array.of(t.y);
      expect([Material.Grass, Material.TaigaFloor, Material.Meadow, Material.Tundra, Material.JungleFloor, Material.DryGrass]).toContain(p.materials(t.x, t.z, 1, 1, 1, h)[0]);
      const b = p.biomes(t.x, t.z, 1, 1, 1, h)![0]!;
      expect(t.kind).toBe(kindOf(b as BiomeId));
      expect(t.y).toBeGreaterThan(p.seaLevel);
    }
  });

  it('mix across a border when biomes blend, each of a kind found within its ecotone', () => {
    const sharp = world({ biomeBlend: 0 }).trees(...BORDER);
    const p = world({ biomeBlend: 50 }), blended = p.trees(...BORDER);
    // Both kinds on both sides: far more trees have a neighbour of the other kind.
    expect(sharp.filter((t) => t.kind === TreeKind.Broadleaf).length).toBeGreaterThan(1000);
    expect(sharp.filter((t) => t.kind === TreeKind.Conifer).length).toBeGreaterThan(1000);
    expect(mixed(blended)).toBeGreaterThan(mixed(sharp) * 8);
    // Every tree's kind belongs to some climate within the ecotone around its own.
    const e = p.ecotone;
    expect(e.degrees).toBeGreaterThan(0);
    for (const t of blended) {
      const c = (p as unknown as { climateSamples: (...a: unknown[]) => { biomeTemperature: Float64Array; biomeMoisture: Float64Array } }).climateSamples(t.x, t.z, 1, 1, 1, Int32Array.of(t.y));
      const kinds = new Set<number>();
      for (let a = -1; a <= 1; a += 0.05) for (let b = -1; b <= 1; b += 0.05) kinds.add(kindOf(classifyBiome(c.biomeTemperature[0]! + a * e.degrees, c.biomeMoisture[0]! + b * e.moisture)));
      expect(kinds).toContain(t.kind);
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
    const bare: HeightSource = { minHeight: p.minHeight, maxHeight: p.maxHeight, seaLevel: p.seaLevel, heights: p.heights.bind(p), materials: p.materials.bind(p), geology: p.geology.bind(p) };
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

describe('forest canopy (distant terrain)', () => {
  const FERTILE: number[] = [Material.Grass, Material.TaigaFloor, Material.Meadow, Material.Tundra, Material.JungleFloor, Material.DryGrass];
  const LEAVES: number[] = [Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves];
  /** Ground and surface (with canopy) samples over the square. */
  const sample = (p: PlateHeights, x0: number, z0: number, n: number, step: number) => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, p);
    const ground = p.heights(x0, z0, n, n, step), groundMat = p.materials(x0, z0, n, n, step, ground);
    const s = gen.surfaceSamples(x0, z0, step, n);
    // Ground stays ground; the canopy floats over it. Seen from above: canopy where there is one.
    expect(s.heights).toEqual(ground);
    const heights = Int32Array.from(ground), materials = Uint16Array.from(groundMat);
    if (s.canopy) {
      for (let k = 0; k < n * n; k++) {
        if (s.canopy.top[k] === NO_CANOPY) continue;
        expect(s.canopy.bottom[k]).toBeGreaterThanOrEqual(ground[k]!);
        // A crown has thickness, unless it sits right on the ground (a low branch on a slope).
        if (s.canopy.bottom[k]! > ground[k]!) expect(s.canopy.bottom[k]).toBeLessThan(s.canopy.top[k]!);
        heights[k] = s.canopy.top[k]!;
        materials[k] = s.canopy.material[k]!;
      }
    }
    return { ground, groundMat, surface: { heights, materials } };
  };

  it('shows the actual crowns up close: treetop heights over the trunks', () => {
    const p = world();
    const step = CANOPY_EXACT_STEP / 4; // 1 m
    const [x0, z0] = BOX, n = 128;
    const { ground, surface } = sample(p, x0, z0, n, step);
    const trees = p.trees(x0, z0, x0 + n * step, z0 + n * step);
    let checked = 0;
    for (const t of trees) {
      const i = Math.round((t.x - x0) / step), j = Math.round((t.z - z0) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const k = i + n * j;
      // At least this tree's own top over its trunk (another crown may rise above it).
      expect(surface.heights[k]).toBeGreaterThanOrEqual(Math.round(t.y + crownTop(t, x0 + i * step - t.x, z0 + j * step - t.z)) - 1);
      expect(LEAVES).toContain(surface.materials[k]);
      expect(surface.heights[k]!).toBeGreaterThan(ground[k]!);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('far away, matches the real forest cover and height on average', () => {
    const p = world();
    const stats = (step: number) => {
      const [x0, z0] = BOX, n = Math.floor((600 * 16) / step);
      const { ground, groundMat, surface } = sample(p, x0, z0, n, step);
      let land = 0, covered = 0, height = 0;
      for (let k = 0; k < n * n; k++) {
        if (ground[k]! <= p.seaLevel || !FERTILE.includes(groundMat[k]!)) continue;
        land++;
        if (surface.heights[k]! > ground[k]!) (covered++, (height += (surface.heights[k]! - ground[k]!) / 16));
      }
      return { cover: covered / land, height: height / covered };
    };
    const exact = stats(32), far = stats(256); // 2 m and 16 m samples
    expect(far.cover).toBeGreaterThan(exact.cover - 0.08);
    expect(far.cover).toBeLessThan(exact.cover + 0.08);
    expect(far.height).toBeGreaterThan(exact.height * 0.85);
    expect(far.height).toBeLessThan(exact.height * 1.15);
  });

  it('far away, mixes leaf kinds across a blended border, as the trees do', () => {
    // 16 m samples over the border: canopy samples of one leaf with the other within 2 samples.
    const mixedCanopy = (biomeBlend: number) => {
      const p = world({ biomeBlend }), step = 256, n = 40, [x0, z0] = BORDER;
      const h = p.heights(x0, z0, n, n, step), m = p.materials(x0, z0, n, n, step, h), c = p.canopy(x0, z0, n, n, step, h, m)!;
      let mix = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const leaf = c.material[i + n * j]!;
        if (c.top[i + n * j] === NO_CANOPY) continue;
        let other = false;
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n || c.top[ii + n * jj] === NO_CANOPY) continue;
          if (c.material[ii + n * jj] !== leaf) other = true;
        }
        if (other) mix++;
      }
      return mix;
    };
    const sharp = mixedCanopy(0);
    expect(sharp).toBeGreaterThan(20); // there is a border
    expect(mixedCanopy(50)).toBeGreaterThan(sharp * 3);
  });

  it('leaves bare ground, sea, and tree-less worlds alone', () => {
    // No canopy over sand, rock, snow, desert or sea; and none at all without trees.
    const p = world();
    const [x0, z0] = BOX;
    for (const step of [32, 256]) {
      const n = 64;
      const { ground, groundMat, surface } = sample(p, x0, z0, n, step);
      for (let k = 0; k < n * n; k++) {
        if (!FERTILE.includes(groundMat[k]!) || ground[k]! <= p.seaLevel) {
          // Bare ground can still lie under a neighbouring tree's crown up close, never far away.
          if (step > CANOPY_EXACT_STEP) expect(surface.heights[k]).toBe(ground[k]);
        }
      }
    }
    const none = world({ trees: 0 });
    const s = sample(none, x0, z0, 64, 256);
    expect(s.surface.heights).toEqual(s.ground);
    expect(s.surface.materials).toEqual(s.groundMat);
  });
});
});

describe('tree clumping', () => {
  /** A 1.2 km square of forest (boreal and temperate) in seed 9. */
  const AREA = [3000 * 16, 6000 * 16, 4200 * 16, 7200 * 16] as const;
  /** Trees per 48 m block over AREA. */
  const blocks = (trees: Tree[]) => {
    const n = Math.round((AREA[2] - AREA[0]) / (48 * 16));
    const out = new Array<number>(n * n).fill(0);
    for (const t of trees) {
      const i = Math.floor((t.x - AREA[0]) / (48 * 16)), j = Math.floor((t.z - AREA[1]) / (48 * 16));
      if (i >= 0 && i < n && j >= 0 && j < n) out[i + n * j]!++;
    }
    return out;
  };
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };

  it('at 0, leaves the trees as they were (older worlds)', () => {
    expect(world({ treeClumping: 0 }).trees(...AREA)).toEqual(world(migratePlateTerrain({ ...defaultPlateTerrain(9), mountains: 0, rivers: 0, lakes: 0, equator: 0, northTemperature: -6, southTemperature: 26, treeClumping: undefined })).trees(...AREA));
  });

  it('groups trees into groves and glades, more with more clumping, keeping about as many', () => {
    const even = blocks(world({ treeClumping: 0 }).trees(...AREA));
    const some = blocks(world({ treeClumping: 50 }).trees(...AREA));
    const lots = blocks(world({ treeClumping: 100 }).trees(...AREA));
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(total(even)).toBeGreaterThan(5000);
    // (About as many: how a world's groves happen to fall moves its count a few percent, more in
    // a small area like this one; the mean chance itself is checked below.)
    for (const xs of [some, lots]) expect(Math.abs(total(xs) / total(even) - 1)).toBeLessThan(0.2);
    // Blocks vary far more, and clearings (blocks with under a quarter of the trees they had
    // without clumping) appear, more with more clumping. (About a quarter of a whole world's
    // forest at 100, 30% of this one's; this square alone has more, ~47%.)
    expect(sd(some)).toBeGreaterThan(sd(even) * 2);
    const forest = even.map((n, i) => [n, i]).filter(([n]) => n! >= 20);
    const clearings = (xs: number[]) => forest.filter(([n, i]) => xs[i!]! < n! / 4).length / forest.length;
    expect(forest.length).toBeGreaterThan(200);
    expect(clearings(even)).toBe(0);
    expect(clearings(lots)).toBeGreaterThan(clearings(some) + 0.03);
    expect(clearings(lots)).toBeGreaterThan(0.15);
    expect(clearings(lots)).toBeLessThan(0.6);
  });

  it('keeps the mean chance of a tree, even where groves would be fuller than full', () => {
    for (const amount of [30, 60, 100]) {
      const clumps = { ...(world({ treeClumping: amount }) as unknown as { clumps: Clumping }).clumps };
      // Over a 16 km square, every 48 m.
      const f = clumpFactors(clumps, 0, 0, 333, 333, 48 * 16)!;
      for (const p of [0.04, 0.45, 0.6, 0.9]) {
        let sum = 0, most = 0;
        for (const v of f) {
          const c = clumpedChance(clumps, p, v);
          sum += c;
          most = Math.max(most, c);
        }
        expect(sum / f.length, `amount ${amount}, p ${p}`).toBeGreaterThan(p * 0.95);
        expect(sum / f.length, `amount ${amount}, p ${p}`).toBeLessThan(p * 1.05);
        expect(most).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('wild jungle trees (tree style 1)', () => {
  // Jungle everywhere: hot, wet, its floor at height 0.
  const hot = 30, wet = 0.95;
  const jungle: GroundSampler = {
    ground: (xs) => ({ heights: new Int32Array(xs.length), materials: new Uint16Array(xs.length).fill(Material.JungleFloor), climate: { temperature: new Float64Array(xs.length).fill(hot), moisture: new Float64Array(xs.length).fill(wet) } }),
  };
  const box = [0, 0, 400 * 16, 400 * 16] as const;
  const of = (style: number) => treesIn(jungle, 7, 50, ...box, undefined, null, null, style).filter((t) => t.kind === TreeKind.Jungle);

  it('branch and lean on buttress roots, with clumps at different heights and vines; style 0 as before', () => {
    expect(classifyBiome(hot, wet)).toBe(Biome.Jungle);
    const plain = of(0), wild = of(1);
    expect(wild.length).toBeGreaterThan(100);
    expect(wild.length).toBe(plain.length);
    for (const t of plain) expect(t.limbs).toBeUndefined();
    for (const t of wild) {
      // A trunk, 4-6 roots, 3-5 branches; vines; clumps over a spread of heights.
      expect(t.limbs!.length).toBeGreaterThanOrEqual(1 + 4 + 3);
      expect(t.limbs!.length).toBeLessThanOrEqual(1 + 6 + 5);
      expect(t.vines!.length).toBeGreaterThanOrEqual(6);
      const heights = t.blobs.map((b) => b.dy);
      expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(3 * 16);
      // Within what chunks look for: TREE_REACH across, TREE_MAX_HEIGHT up.
      for (const b of t.blobs) expect(Math.hypot(b.dx, b.dz) + b.rx).toBeLessThanOrEqual(TREE_REACH);
      for (const l of t.limbs!) expect(Math.max(Math.hypot(l.x0, l.z0), Math.hypot(l.x1, l.z1)) + l.r0).toBeLessThanOrEqual(TREE_REACH);
      expect(t.height).toBeLessThanOrEqual(TREE_MAX_HEIGHT);
      for (const v of t.vines!) expect(v.bottom).toBeGreaterThan(0);
    }
    // Some giants over the rest.
    // (Height: the top of its leaves. Giants top out at 29-35 m, the rest under 28 m.)
    expect(wild.filter((t) => t.height > 28 * 16).length).toBeGreaterThan(wild.length * 0.1);
  });

  it('plant as wood and leaves: branches away from the trunk, vines hanging under the clumps', () => {
    const t = of(1)[0]!;
    // The chunks around the tree, from its roots to its top.
    let wood = 0, woodOff = 0, hanging = 0;
    const lowest = Math.min(...t.blobs.map((b) => b.dy - b.ry));
    for (let cy = 0; cy * CHUNK_SIZE < t.height + 16; cy++)
      for (let cz = Math.floor((t.z - TREE_REACH) / CHUNK_SIZE); cz <= Math.floor((t.z + TREE_REACH) / CHUNK_SIZE); cz++)
        for (let cx = Math.floor((t.x - TREE_REACH) / CHUNK_SIZE); cx <= Math.floor((t.x + TREE_REACH) / CHUNK_SIZE); cx++) {
          const chunk = emptyChunk({ cx, cy, cz });
          plantTrees(chunk, [t]);
          chunk.blocks.forEach((b, i) => {
            if (!b) return;
            // (Valid voxels: none overlapping, the fine ones (vines) included. Throws otherwise.)
            if (b.kind === 'voxels') rasterizeVoxels(b);
            const bx = i % 16, bz = Math.floor(i / 16) % 16, by = Math.floor(i / 256);
            const wx = cx * CHUNK_SIZE + bx * 16 + 8 - t.x, wy = cy * CHUNK_SIZE + by * 16 + 8 - t.y, wz = cz * CHUNK_SIZE + bz * 16 + 8 - t.z;
            // (Its materials, however it's stored: one, a grid of equal voxels, or a list of them.)
            const mats = b.kind === 'uniform' ? [b.material] : [...b.materials];
            if (mats.includes(Material.Wood)) {
              wood++;
              if (Math.hypot(wx, wz) > t.trunk + 3 * 16 && wy > 6 * 16) woodOff++;
            }
            if (mats.includes(Material.JungleLeaves) && wy < lowest - 16) hanging++;
          });
        }
    expect(wood).toBeGreaterThan(50);
    expect(woodOff).toBeGreaterThan(0);
    expect(hanging).toBeGreaterThan(0);
  }, 60_000);
});
