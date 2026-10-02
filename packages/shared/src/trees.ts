import { Biome, SHARP, blendedBiome, type BiomeId, type Ecotone } from './biomes.js';
import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  blockIndex,
  rasterizeVoxels,
  unpackVoxel,
  packVoxel,
  type Block,
  type Chunk,
} from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import { fractalGrid, hash2, type Octave } from './noise.js';
import type { VoxelSize } from './units.js';
import { CHUNK_SIZE } from './world.js';

/** Leaf material of each biome's trees. */
const BIOME_LEAVES: Record<BiomeId, MaterialId> = {
  [Biome.Ice]: Material.Needles,
  [Biome.Tundra]: Material.Needles,
  [Biome.Boreal]: Material.Needles,
  [Biome.Temperate]: Material.Leaves,
  [Biome.Grassland]: Material.Leaves,
  [Biome.Jungle]: Material.JungleLeaves,
  [Biome.Savanna]: Material.AcaciaLeaves,
  [Biome.Desert]: Material.Leaves,
};

/** Tree shapes. */
export const TreeKind = { Broadleaf: 0, Conifer: 1, Jungle: 2, Acacia: 3 } as const;
export type TreeKindId = (typeof TreeKind)[keyof typeof TreeKind];

/** A placed tree; all lengths in units (1/16 m). */
export interface Tree {
  /** Trunk centre and the ground height under it. */
  x: number;
  z: number;
  y: number;
  kind: TreeKindId;
  height: number;
  /** Trunk radius. */
  trunk: number;
  /** Crown radius (horizontal). */
  crown: number;
  /** Crown blobs (broadleaf, jungle, acacia): centre offsets from the trunk base and radii. */
  blobs: { dx: number; dy: number; dz: number; rx: number; ry: number }[];
}

const M = 16;
/** Candidate spacing: one possible tree per cell (6 m), jittered within it. */
export const TREE_CELL = 6 * M;
/** Furthest any part of a tree reaches from its trunk (crowns up to ~9.5 m radius, plus jitter). */
export const TREE_REACH = 11 * M;
/** Tallest tree (units), for chunk column ranges. */
export const TREE_MAX_HEIGHT = 42 * M;
const TRUNK_VOXEL = 4; // 1/4 m
const LEAF_VOXEL = 8; // 1/2 m

/** Chance of a tree per cell at density 50, by biome. */
const DENSITY: Record<BiomeId, number> = {
  [Biome.Ice]: 0,
  [Biome.Tundra]: 0.03,
  [Biome.Boreal]: 0.55,
  [Biome.Temperate]: 0.45,
  [Biome.Grassland]: 0.04,
  [Biome.Jungle]: 0.6,
  [Biome.Savanna]: 0.08,
  [Biome.Desert]: 0,
};

/**
 * A forest seen from far away, per biome at density 50: the share of the ground under a crown and
 * the canopy's mean height above the ground (m), measured from the trees themselves (sampling the
 * crowns every 2 m over three worlds); and where crowns start, as a fraction of that height.
 */
const CANOPY: Record<BiomeId, { cover: number; height: number; base: number }> = {
  [Biome.Ice]: { cover: 0, height: 0, base: 0 },
  [Biome.Tundra]: { cover: 0.004, height: 2.5, base: 0.2 },
  [Biome.Boreal]: { cover: 0.54, height: 10, base: 0.2 },
  [Biome.Temperate]: { cover: 0.54, height: 13.5, base: 0.45 },
  [Biome.Grassland]: { cover: 0.03, height: 8.5, base: 0.45 },
  [Biome.Jungle]: { cover: 0.93, height: 34.5, base: 0.7 },
  [Biome.Savanna]: { cover: 0.16, height: 8, base: 0.7 },
  [Biome.Desert]: { cover: 0, height: 0, base: 0 },
};

/** Ground trees grow on. */
const FERTILE = new Set<MaterialId>([Material.Grass, Material.JungleFloor, Material.DryGrass, Material.Meadow, Material.TaigaFloor, Material.Tundra]);

const LEAVES: Record<TreeKindId, MaterialId> = {
  [TreeKind.Broadleaf]: Material.Leaves,
  [TreeKind.Conifer]: Material.Needles,
  [TreeKind.Jungle]: Material.JungleLeaves,
  [TreeKind.Acacia]: Material.AcaciaLeaves,
};

/** Ground temperature (degrees C) and moisture (0..1) per sample, as biomes are classified from. */
export interface Climate {
  temperature: ArrayLike<number>;
  moisture: ArrayLike<number>;
}

/** What a world tells the forest about points: ground height, ground material, climate (null: no biomes). */
export interface GroundSampler {
  ground(xs: number[], zs: number[]): { heights: Int32Array; materials: Uint16Array; climate: Climate | null };
}

/**
 * Trees grow in clumps: a smooth noise field (`octaves`, a few hundred metres across) makes trees
 * likelier in some places (groves) and rarer in others (glades); `amount` 0 leaves the chances as
 * they are, 100 is the strongest. The average chance stays the same (see clumpedChance).
 */
export interface Clumping {
  octaves: readonly Octave[];
  /** 0 (none) .. 100. */
  amount: number;
}
/**
 * Doublings of the tree chance across 0.4 of the normalized clump noise (~1.3 deviations), at
 * amount 100: there, about a quarter of a forest is clearings (under a quarter of its trees).
 */
const CLUMP_RANGE = 6;

interface ClumpState {
  /** Exponent on the normalized noise. */
  k: number;
  norm: number;
  /** The noise's values over a wide area (its distribution, for keeping the mean chance). */
  samples: Float64Array;
  /** Per base chance: the multiplier that keeps the mean chance (see clumpedChance). */
  scales: Map<number, number>;
}
const clumpStates = new WeakMap<Clumping, ClumpState>();
function clumpState(c: Clumping): ClumpState {
  let st = clumpStates.get(c);
  if (!st) {
    const norm = 2 / c.octaves.reduce((a, o) => a + o.weight, 0);
    // 128 x 128 samples, spaced out of step with every octave's lattice (at lattice points the
    // noise spreads wider than between them): the noise's distribution, not just its typical value.
    const samples = fractalGrid(c.octaves, 0, 0, 128, 128, c.octaves[0]!.spacing * 0.7853981).map((v) => v * norm);
    st = { k: (CLUMP_RANGE / 0.4) * (c.amount / 100) * Math.LN2, norm, samples, scales: new Map() };
    clumpStates.set(c, st);
  }
  return st;
}

/**
 * How much likelier trees are at samples (w x d from (x0, z0), `step` apart), before keeping the
 * mean (see clumpedChance); null without clumping.
 */
export function clumpFactors(clumps: Clumping | null, x0: number, z0: number, w: number, d: number, step: number): Float64Array | null {
  if (!clumps || clumps.amount <= 0) return null;
  const st = clumpState(clumps);
  return fractalGrid(clumps.octaves, x0, z0, w, d, step).map((v) => Math.exp(st.k * v * st.norm));
}

/**
 * The chance of a tree where the base chance is `p` (0..1) and the clump factor `f`: p times f,
 * scaled so that averaged over the whole noise field it's still p, and at most 1. (Where groves
 * would be fuller than full, glades are emptier instead.)
 */
export function clumpedChance(clumps: Clumping, p: number, f: number): number {
  if (p <= 0 || p >= 1) return p;
  const st = clumpState(clumps);
  let scale = st.scales.get(p);
  if (scale === undefined) {
    const factors = st.samples.map((n) => Math.exp(st.k * n));
    const mean = (s: number) => {
      let sum = 0;
      for (const v of factors) sum += Math.min(1, p * s * v);
      return sum / factors.length;
    };
    // The mean grows with the scale; find where it's p.
    let lo = 0, hi = 1;
    while (mean(hi) < p && hi < 1e6) hi *= 2;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      if (mean(mid) < p) lo = mid;
      else hi = mid;
    }
    scale = (lo + hi) / 2;
    st.scales.set(p, scale);
  }
  return Math.min(1, p * scale * f);
}

/** Deterministic random numbers for a cell: r(k) in [0, 1). */
function cellRandom(seed: number, cx: number, cz: number) {
  return (k: number) => hash2(cx * 977 + k * 7919, cz * 131 + k * 104729, seed);
}

/**
 * Trees with any part within the box [x0, x1) x [z0, z1) (units), in a fixed order (by cell),
 * so every chunk resolves overlapping crowns the same way. `density` scales the per-biome
 * chances (50 = as listed above, 100 = double, capped at one tree per cell). Each tree takes the
 * biome of its climate nudged at random within the `ecotone`, so near a border the two biomes'
 * trees mix, and a forest thins out over the width of the ecotone instead of stopping at a line.
 */
export function treesIn(sampler: GroundSampler, seed: number, density: number, x0: number, z0: number, x1: number, z1: number, ecotone: Ecotone = SHARP, clumps: Clumping | null = null): Tree[] {
  if (density <= 0) return [];
  const c0 = Math.floor((x0 - TREE_REACH) / TREE_CELL), c1 = Math.floor((x1 + TREE_REACH) / TREE_CELL);
  const r0 = Math.floor((z0 - TREE_REACH) / TREE_CELL), r1 = Math.floor((z1 + TREE_REACH) / TREE_CELL);
  // Clumping, at each cell's corner (the same wherever the cell is asked for).
  const clump = clumpFactors(clumps, c0 * TREE_CELL, r0 * TREE_CELL, c1 - c0 + 1, r1 - r0 + 1, TREE_CELL);
  const cand: { x: number; z: number; rnd: (k: number) => number; clump: number }[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const rnd = cellRandom(seed, c, r);
      // Jittered within the cell, keeping trunks at least ~1 m from the cell's edge.
      cand.push({ x: Math.floor((c + 0.15 + 0.7 * rnd(0)) * TREE_CELL), z: Math.floor((r + 0.15 + 0.7 * rnd(1)) * TREE_CELL), rnd, clump: clump ? clump[c - c0 + (c1 - c0 + 1) * (r - r0)]! : 1 });
    }
  }
  if (cand.length === 0) return [];
  const g = sampler.ground(cand.map((t) => t.x), cand.map((t) => t.z));
  const scale = density / 50;
  const out: Tree[] = [];
  cand.forEach((t, k) => {
    const mat = g.materials[k]!;
    if (!FERTILE.has(mat)) return;
    const biome = g.climate ? blendedBiome(g.climate.temperature[k]!, g.climate.moisture[k]!, ecotone, t.rnd(6), t.rnd(7), t.rnd(8), t.rnd(9)) : Biome.Temperate;
    const chance = Math.min(1, DENSITY[biome] * scale);
    if (t.rnd(2) >= (clumps && clump ? clumpedChance(clumps, chance, t.clump) : chance)) return;
    const tree = shapeTree(biome, t.x, g.heights[k]!, t.z, t.rnd);
    // Only trees that reach into the box.
    if (tree.x + TREE_REACH < x0 || tree.x - TREE_REACH >= x1 || tree.z + TREE_REACH < z0 || tree.z - TREE_REACH >= z1) return;
    out.push(tree);
  });
  return out;
}

/** Sizes and crown of a tree of the biome's kind. */
function shapeTree(biome: BiomeId, x: number, y: number, z: number, rnd: (k: number) => number): Tree {
  const between = (k: number, lo: number, hi: number) => (lo + (hi - lo) * rnd(k)) * M;
  const blobs: Tree['blobs'] = [];
  const crownOf = (n: number, cy: number, spread: number, rx: number, ry: number) => {
    blobs.push({ dx: 0, dy: cy, dz: 0, rx, ry });
    for (let i = 0; i < n; i++) {
      const a = rnd(20 + i) * Math.PI * 2, d = spread * (0.4 + 0.6 * rnd(40 + i));
      blobs.push({ dx: Math.cos(a) * d, dy: cy + (rnd(60 + i) - 0.5) * ry * 0.8, dz: Math.sin(a) * d, rx: rx * (0.5 + 0.3 * rnd(80 + i)), ry: ry * (0.55 + 0.3 * rnd(100 + i)) });
    }
  };
  if (biome === Biome.Jungle) {
    const height = between(3, 25, 40), crown = between(4, 6, 9);
    crownOf(6, height - crown * 0.25, crown * 0.6, crown * 0.7, Math.max(2.2 * M, crown * 0.32));
    return { x, y, z, kind: TreeKind.Jungle, height, trunk: between(5, 0.6, 1.0), crown, blobs };
  }
  if (biome === Biome.Savanna) {
    const height = between(3, 6, 10), crown = between(4, 4, 6);
    crownOf(5, height - 0.6 * M, crown * 0.55, crown * 0.6, 0.9 * M);
    return { x, y, z, kind: TreeKind.Acacia, height, trunk: between(5, 0.25, 0.35), crown, blobs };
  }
  if (biome === Biome.Boreal || biome === Biome.Tundra) {
    const dwarf = biome === Biome.Tundra;
    const height = dwarf ? between(3, 3, 6) : between(3, 10, 25);
    const crown = height * (0.16 + 0.05 * rnd(4));
    return { x, y, z, kind: TreeKind.Conifer, height, trunk: dwarf ? 0.15 * M : between(5, 0.25, 0.45), crown, blobs };
  }
  // Temperate forest; smaller on grassland.
  const small = biome === Biome.Grassland;
  const height = small ? between(3, 8, 12) : between(3, 12, 20);
  const crown = height * (0.28 + 0.08 * rnd(4));
  crownOf(5, height * 0.66, crown * 0.45, crown * 0.75, crown * 0.6);
  return { x, y, z, kind: TreeKind.Broadleaf, height, trunk: small ? between(5, 0.25, 0.4) : between(5, 0.35, 0.6), crown, blobs };
}

/**
 * Height of the top of the tree's crown above the point (relative to the trunk base, units), or
 * -Infinity where the crown doesn't cover it: what a tree looks like from above.
 */
export function crownTop(t: Tree, px: number, pz: number): number {
  if (t.kind === TreeKind.Conifer) {
    const d = Math.hypot(px, pz), base = t.height * 0.2;
    if (d > t.crown + 0.3 * M) return -Infinity;
    const u = Math.min(1, Math.max(0, 1 - (d - 0.3 * M) / t.crown));
    return base + u * (t.height - base);
  }
  let top = -Infinity;
  for (const b of t.blobs) {
    const q = ((px - b.dx) ** 2 + (pz - b.dz) ** 2) / (b.rx * b.rx);
    if (q <= 1) top = Math.max(top, b.dy + b.ry * Math.sqrt(1 - q));
  }
  return top;
}

/** Whether the point (relative to the trunk base, units) is inside the tree's crown (testing only `blobs` if given). */
function inCrown(t: Tree, px: number, py: number, pz: number, blobs: Tree['blobs'] | null = null): boolean {
  if (t.kind === TreeKind.Conifer) {
    // A tiered cone from a fifth of the height up to the tip.
    const base = t.height * 0.2;
    if (py < base || py > t.height) return false;
    const u = (py - base) / (t.height - base);
    const tiers = Math.max(3, Math.round(t.height / (3 * M)));
    const tier = 1 - ((u * tiers) % 1); // 1 at each tier's bottom, falling to 0
    const r = t.crown * (1 - u) * (0.65 + 0.35 * tier) + 0.3 * M;
    return px * px + pz * pz <= r * r;
  }
  for (const b of blobs ?? t.blobs) {
    const dx = (px - b.dx) / b.rx, dy = (py - b.dy) / b.ry, dz = (pz - b.dz) / b.rx;
    if (dx * dx + dy * dy + dz * dz <= 1) return true;
  }
  return false;
}

/** Top of a tree's trunk (relative to its base): into the crown, but not out of its top. */
function trunkTop(t: Tree): number {
  if (t.kind === TreeKind.Conifer) return t.height * 0.9;
  if (t.kind === TreeKind.Acacia) return t.height - 0.8 * M;
  return t.height * (t.kind === TreeKind.Jungle ? 0.85 : 0.7);
}

type Add = { x: number; y: number; z: number; size: number; material: MaterialId };

/**
 * Adds the trees' voxels to the chunk where they don't overlap anything (ground, or an earlier
 * tree). Trunks start 1 m below the ground so they never float on a slope.
 */
export function plantTrees(chunk: Chunk, trees: readonly Tree[]): void {
  const x0 = chunk.cx * CHUNK_SIZE, y0 = chunk.cy * CHUNK_SIZE, z0 = chunk.cz * CHUNK_SIZE;
  // Voxels to add per block, in tree order (so overlaps resolve the same in every chunk); each
  // block is rebuilt once at the end.
  const pending = new Map<number, Add[]>();
  const push = (bx: number, by: number, bz: number, v: Add) => {
    const i = blockIndex(bx, by, bz);
    let list = pending.get(i);
    if (!list) pending.set(i, (list = []));
    list.push(v);
  };
  /** Blocks of this chunk overlapping the world box [lo, hi] (units), or null if none. */
  const blocks = (xlo: number, xhi: number, ylo: number, yhi: number, zlo: number, zhi: number) => {
    const b = {
      x0: Math.max(0, Math.floor((xlo - x0) / BLOCK_SIZE)), x1: Math.min(BLOCKS_PER_AXIS - 1, Math.floor((xhi - x0) / BLOCK_SIZE)),
      y0: Math.max(0, Math.floor((ylo - y0) / BLOCK_SIZE)), y1: Math.min(BLOCKS_PER_AXIS - 1, Math.floor((yhi - y0) / BLOCK_SIZE)),
      z0: Math.max(0, Math.floor((zlo - z0) / BLOCK_SIZE)), z1: Math.min(BLOCKS_PER_AXIS - 1, Math.floor((zhi - z0) / BLOCK_SIZE)),
    };
    return b.x0 > b.x1 || b.y0 > b.y1 || b.z0 > b.z1 ? null : b;
  };
  for (const t of trees) {
    const material = LEAVES[t.kind];
    // Leaves, in 1/2 m voxels, over the blocks the crown's bounding box covers.
    const crown =
      t.kind === TreeKind.Conifer
        ? blocks(t.x - t.crown - M, t.x + t.crown + M, t.y + t.height * 0.2, t.y + t.height, t.z - t.crown - M, t.z + t.crown + M)
        : blocks(
            Math.min(...t.blobs.map((b) => t.x + b.dx - b.rx)), Math.max(...t.blobs.map((b) => t.x + b.dx + b.rx)),
            Math.min(...t.blobs.map((b) => t.y + b.dy - b.ry)), Math.max(...t.blobs.map((b) => t.y + b.dy + b.ry)),
            Math.min(...t.blobs.map((b) => t.z + b.dz - b.rx)), Math.max(...t.blobs.map((b) => t.z + b.dz + b.rx)),
          );
    if (crown) {
      for (let by = crown.y0; by <= crown.y1; by++) {
        for (let bz = crown.z0; bz <= crown.z1; bz++) {
          for (let bx = crown.x0; bx <= crown.x1; bx++) {
            const ox = x0 + bx * BLOCK_SIZE - t.x, oy = y0 + by * BLOCK_SIZE - t.y, oz = z0 + bz * BLOCK_SIZE - t.z;
            // Only the blobs whose boxes reach this block (conifers: the cone, always).
            const near = t.kind === TreeKind.Conifer ? null : t.blobs.filter((b) =>
              b.dx + b.rx >= ox && b.dx - b.rx <= ox + BLOCK_SIZE && b.dy + b.ry >= oy && b.dy - b.ry <= oy + BLOCK_SIZE && b.dz + b.rx >= oz && b.dz - b.rx <= oz + BLOCK_SIZE);
            if (near && near.length === 0) continue;
            for (let ly = 0; ly < BLOCK_SIZE; ly += LEAF_VOXEL) {
              for (let lz = 0; lz < BLOCK_SIZE; lz += LEAF_VOXEL) {
                for (let lx = 0; lx < BLOCK_SIZE; lx += LEAF_VOXEL) {
                  const c = LEAF_VOXEL / 2;
                  if (inCrown(t, ox + lx + c, oy + ly + c, oz + lz + c, near)) push(bx, by, bz, { x: lx, y: ly, z: lz, size: LEAF_VOXEL, material });
                }
              }
            }
          }
        }
      }
    }
    // Trunk, in 1/4 m voxels, over the few blocks around its axis.
    const top = trunkTop(t);
    const trunk = blocks(t.x - t.trunk, t.x + t.trunk, t.y - M, t.y + top, t.z - t.trunk, t.z + t.trunk);
    if (trunk) {
      for (let by = trunk.y0; by <= trunk.y1; by++) {
        for (let bz = trunk.z0; bz <= trunk.z1; bz++) {
          for (let bx = trunk.x0; bx <= trunk.x1; bx++) {
            const ox = x0 + bx * BLOCK_SIZE - t.x, oy = y0 + by * BLOCK_SIZE - t.y, oz = z0 + bz * BLOCK_SIZE - t.z;
            for (let ly = 0; ly < BLOCK_SIZE; ly += TRUNK_VOXEL) {
              const py = oy + ly + TRUNK_VOXEL / 2;
              if (py < -M || py > top) continue;
              // Trunks taper a little toward the top.
              const r = t.trunk * (1 - (0.35 * Math.max(0, py)) / top);
              for (let lz = 0; lz < BLOCK_SIZE; lz += TRUNK_VOXEL) {
                for (let lx = 0; lx < BLOCK_SIZE; lx += TRUNK_VOXEL) {
                  const px = ox + lx + TRUNK_VOXEL / 2, pz = oz + lz + TRUNK_VOXEL / 2;
                  if (px * px + pz * pz <= r * r) push(bx, by, bz, { x: lx, y: ly, z: lz, size: TRUNK_VOXEL, material: Material.Wood });
                }
              }
            }
          }
        }
      }
    }
  }
  for (const [i, add] of pending) chunk.blocks[i] = addVoxels(chunk.blocks[i] ?? null, add);
}

/** The block with the voxels added wherever all their unit cells are empty. */
function addVoxels(block: Block, add: Add[]): Block {
  if (block && block.kind === 'uniform') return block; // solid
  if (!block) {
    // An empty block: tree voxels are aligned to 1/4 m, so a 4 x 4 x 4 occupancy grid will do.
    const occ = new Uint8Array(64);
    const packed: number[] = [], materials: number[] = [];
    for (const v of add) {
      const s = v.size >> 2, x = v.x >> 2, y = v.y >> 2, z = v.z >> 2;
      let free = true;
      for (let yy = y; yy < y + s && free; yy++) for (let zz = z; zz < z + s && free; zz++) for (let xx = x; xx < x + s; xx++) if (occ[xx + 4 * (zz + 4 * yy)]) { free = false; break; }
      if (!free) continue;
      for (let yy = y; yy < y + s; yy++) for (let zz = z; zz < z + s; zz++) for (let xx = x; xx < x + s; xx++) occ[xx + 4 * (zz + 4 * yy)] = 1;
      packed.push(packVoxel(v.x, v.y, v.z, v.size));
      materials.push(v.material);
    }
    if (packed.length === 0) return null;
    // All one size (leaves only, or trunk only): a grid block, which meshes much faster.
    const size = (packed[0]! >> 12) + 1;
    if (packed.every((p) => (p >> 12) + 1 === size)) {
      const n = BLOCK_SIZE / size;
      const grid = new Uint16Array(n * n * n);
      packed.forEach((p, k) => {
        const x = (p & 15) / size, y = ((p >> 4) & 15) / size, z = ((p >> 8) & 15) / size;
        grid[x + n * (z + n * y)] = materials[k]!;
      });
      return { kind: 'grid', size: size as VoxelSize, materials: grid };
    }
    return { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
  }
  const packed: number[] = [], materials: number[] = [];
  const occupied = new Uint8Array(BLOCK_SIZE ** 3);
  const mark = (x: number, y: number, z: number, s: number) => {
    for (let yy = y; yy < y + s; yy++) for (let zz = z; zz < z + s; zz++) for (let xx = x; xx < x + s; xx++) occupied[xx + BLOCK_SIZE * (zz + BLOCK_SIZE * yy)] = 1;
  };
  const free = (x: number, y: number, z: number, s: number) => {
    for (let yy = y; yy < y + s; yy++) for (let zz = z; zz < z + s; zz++) for (let xx = x; xx < x + s; xx++) if (occupied[xx + BLOCK_SIZE * (zz + BLOCK_SIZE * yy)]) return false;
    return true;
  };
  if (block && block.kind === 'grid') {
    const n = BLOCK_SIZE / block.size;
    for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const m = block.materials[x + n * (z + n * y)]!;
      if (m === 0) continue;
      packed.push(packVoxel(x * block.size, y * block.size, z * block.size, block.size));
      materials.push(m);
      mark(x * block.size, y * block.size, z * block.size, block.size);
    }
  } else if (block && block.kind === 'voxels') {
    rasterizeVoxels(block); // validates
    for (let i = 0; i < block.packed.length; i++) {
      const v = unpackVoxel(block.packed[i]!);
      packed.push(block.packed[i]!);
      materials.push(block.materials[i]!);
      mark(v.x, v.y, v.z, v.size);
    }
  }
  const before = packed.length;
  for (const v of add) {
    if (!free(v.x, v.y, v.z, v.size)) continue;
    packed.push(packVoxel(v.x, v.y, v.z, v.size));
    materials.push(v.material);
    mark(v.x, v.y, v.z, v.size);
  }
  if (packed.length === before) return block;
  return { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
}

/** Samples at most this far apart (units) see the actual trees; further apart, the statistical canopy. */
export const CANOPY_EXACT_STEP = 4 * M;
/** No canopy over a sample. */
export const NO_CANOPY = -(2 ** 31);

/** Forest canopy over a grid of samples: crown top and bottom (units, NO_CANOPY where bare) and leaf material. */
export interface Canopy {
  top: Int32Array;
  bottom: Int32Array;
  material: Uint16Array;
}

/**
 * Height of the underside of the tree's crown above the point (relative to the trunk base),
 * where crownTop covers it.
 */
export function crownBottom(t: Tree, px: number, pz: number): number {
  if (t.kind === TreeKind.Conifer) return t.height * 0.2;
  let bottom = Infinity;
  for (const b of t.blobs) {
    const q = ((px - b.dx) ** 2 + (pz - b.dz) ** 2) / (b.rx * b.rx);
    if (q <= 1) bottom = Math.min(bottom, b.dy - b.ry * Math.sqrt(1 - q));
  }
  return bottom;
}

/**
 * The forest canopy over samples (w x d from (x0, z0), `step` apart, with their ground heights
 * and materials), as distant terrain shows it: crowns floating over the ground. Close together,
 * the trees' actual crowns (`trees` with any part in the sampled area); far apart, a forest of
 * the typical cover and height of the biome of each sample's climate, nudged within the `ecotone`
 * as trees are (deterministic per sample). Null without trees.
 */
export function canopyOver(
  x0: number, z0: number, w: number, d: number, step: number,
  heights: Int32Array, materials: Uint16Array,
  climate: Climate | null, density: number, seed: number,
  trees: () => Tree[],
  ecotone: Ecotone = SHARP,
  clumps: Clumping | null = null,
): Canopy | null {
  if (density <= 0) return null;
  const top = new Int32Array(w * d).fill(NO_CANOPY), bottom = new Int32Array(w * d).fill(NO_CANOPY), material = new Uint16Array(w * d);
  if (step <= CANOPY_EXACT_STEP) {
    // Bucket trees by candidate cell, then look up the few within reach of each sample.
    const buckets = new Map<string, Tree[]>();
    for (const t of trees()) {
      const key = `${Math.floor(t.x / TREE_CELL)},${Math.floor(t.z / TREE_CELL)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(t);
    }
    const R = Math.ceil(TREE_REACH / TREE_CELL);
    for (let j = 0; j < d; j++) {
      for (let i = 0; i < w; i++) {
        const k = i + w * j, x = x0 + i * step, z = z0 + j * step;
        const cx = Math.floor(x / TREE_CELL), cz = Math.floor(z / TREE_CELL);
        let hi = -Infinity, lo = Infinity, leaf = 0;
        for (let b = -R; b <= R; b++) {
          for (let a = -R; a <= R; a++) {
            for (const t of buckets.get(`${cx + a},${cz + b}`) ?? []) {
              const y = crownTop(t, x - t.x, z - t.z);
              if (y === -Infinity) continue;
              if (t.y + y > hi) [hi, leaf] = [t.y + y, LEAVES[t.kind]];
              lo = Math.min(lo, t.y + crownBottom(t, x - t.x, z - t.z));
            }
          }
        }
        if (hi > heights[k]!) {
          top[k] = Math.round(hi);
          // At least a leaf voxel thick (crowns thin to nothing at their rims), above the ground.
          bottom[k] = Math.max(heights[k]!, Math.min(Math.round(lo), top[k]! - LEAF_VOXEL));
          material[k] = leaf;
        }
      }
    }
    return top.some((v) => v !== NO_CANOPY) ? { top, bottom, material } : null;
  }
  // Statistical canopy: cover scales like independent trees (more trees overlap more), and
  // with clumping, as the trees there do.
  const scale = density / 50;
  const clump = clumpFactors(clumps, x0, z0, w, d, step);
  let any = false;
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + w * j;
      if (!FERTILE.has(materials[k]!)) continue;
      const gx = Math.floor((x0 + i * step) / step), gz = Math.floor((z0 + j * step) / step);
      const biome = climate
        ? blendedBiome(climate.temperature[k]!, climate.moisture[k]!, ecotone, hash2(gx, gz, seed + 2), hash2(gx, gz, seed + 3), hash2(gx, gz, seed + 4), hash2(gx, gz, seed + 5))
        : Biome.Temperate;
      const c = CANOPY[biome];
      if (c.cover <= 0) continue;
      // With clumping, as many more (or fewer) trees as there are here.
      const chance = Math.min(1, DENSITY[biome] * scale);
      const more = clumps && clump && chance > 0 ? clumpedChance(clumps, chance, clump[k]!) / chance : 1;
      const cover = 1 - (1 - c.cover) ** (scale * more);
      if (hash2(gx, gz, seed ^ step) >= cover) continue;
      const h = c.height * M * (0.75 + 0.5 * hash2(gz, gx, seed + 1));
      top[k] = Math.round(heights[k]! + h);
      bottom[k] = Math.round(heights[k]! + h * c.base);
      material[k] = BIOME_LEAVES[biome];
      any = true;
    }
  }
  return any ? { top, bottom, material } : null;
}
