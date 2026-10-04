import type { ClimateGrid } from './climate.js';
import { NO_CANOPY, plantTrees, type Canopy, type Tree } from './trees.js';
import { NO_WATER, setBlockWater } from './water.js';
import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  blockIndex,
  emptyChunk,
  isGridSize,
  packVoxel,
  type Block,
  type Chunk,
  type ColumnRange,
  type ChunkGenerator,
  type UniformBlock,
} from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import { fractalGrid, type Octave } from './noise.js';
import { oreAt } from './ores.js';
import type { VoxelSize } from './units.js';
import { CHUNK_SIZE, type ChunkCoord, type WorldConfig } from './world.js';

/**
 * Supplies ground surface heights. The voxelizer only depends on this, so a
 * different source (e.g. tectonic plates) can replace the noise below.
 * On wrapping worlds a source must be periodic in X with the world width.
 */
export interface HeightSource {
  /**
   * Integer surface heights (units) for w x d unit columns, row-major
   * (i + w * j): sample (i, j) is the column at (x0 + i * step, z0 + j * step).
   */
  heights(x0: number, z0: number, w: number, d: number, step?: number): Int32Array;
  /** Bounds every returned height lies within. */
  readonly minHeight: number;
  readonly maxHeight: number;
  /**
   * Optional top material for the same columns, given their heights. Without
   * it the surface is grass over dirt over stone.
   */
  materials?(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array): Uint16Array;
  /** Y (units) of the sea surface, if this terrain has a sea. */
  readonly seaLevel?: number;
  /** Optional forest canopy over samples (given their ground heights and materials), for distant views. */
  canopy?(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array, materials: Uint16Array): Canopy | null;
  /**
   * Optional height of water standing over each sample above the sea (rivers, lakes): NO_WATER
   * where there's none, or null for none over any of them.
   */
  water?(x0: number, z0: number, w: number, d: number, step?: number): Int32Array | null;
  /** Optional climate for blending biome colours (null where biomes don't blend). */
  climate?(): ClimateGrid | null;
  /** Optional trees with any part in the box [x0, x1) x [z0, z1) (units), in a fixed order. */
  trees?(x0: number, z0: number, x1: number, z1: number): Tree[];
}

/** What lies beneath a surface material, down to DIRT_DEPTH. */
export function subsurface(top: MaterialId): MaterialId {
  switch (top) {
    case Material.Grass:
    case Material.JungleFloor:
    case Material.DryGrass:
    case Material.Meadow:
    case Material.TaigaFloor:
    case Material.Tundra:
      return Material.Dirt;
    case Material.Sand:
    case Material.DesertSand:
      return Material.Sand;
    default:
      return Material.Stone;
  }
}

/**
 * Adaptive voxelization settings. Each 1 m block is subdivided
 * (16 -> 8 -> 4 -> 2 -> 1 units) only where the ground surface passes
 * through it and a coarser voxel would misplace the surface by more than
 * `tolerance`. Flat ground on a 1 m line therefore stays 1 m voxels.
 *
 * All lengths are in units (1/16 m).
 */
export interface VoxelizeConfig {
  /** Smallest voxel the generator may use: 1, 2, 4, 8 or 16. */
  minVoxelSize: VoxelSize;
  /** Maximum vertical surface error allowed before subdividing. */
  tolerance: number;
}

/** Simple value-noise terrain: flat plains with rolling, rough hills. Units. */
export interface NoiseTerrainConfig {
  seed: number;
  /** Height of the plains. */
  baseHeight: number;
  /** Maximum hill height above the plains. */
  hillHeight: number;
  /** Lattice spacing of the largest hill features. */
  hillScale: number;
  /** Amplitude of small-scale roughness on hills (none on plains). */
  detailHeight: number;
  /** Lattice spacing of the largest roughness features. */
  detailScale: number;
}

export function defaultVoxelize(): VoxelizeConfig {
  return { minVoxelSize: 1, tolerance: 4 };
}

export function defaultNoiseTerrain(seed = 1): NoiseTerrainConfig {
  return {
    seed,
    baseHeight: 0,
    hillHeight: 24 * 16,
    hillScale: 2560,
    detailHeight: 24,
    detailScale: 80,
  };
}

const HILL_OCTAVES = 3;
const DETAIL_OCTAVES = 4;
/** Depth below the surface (units) where dirt turns to stone. */
export const DIRT_DEPTH = 3 * 16;

function octaves(world: WorldConfig, seed: number, scale: number, count: number): Octave[] {
  const out: Octave[] = [];
  for (let k = 0; k < count; k++) {
    const spacing = scale / 2 ** k;
    let periodX = 0;
    if (world.wrapX) {
      periodX = world.widthUnits / spacing;
      if (!Number.isInteger(spacing) || !Number.isInteger(periodX)) {
        throw new RangeError(
          `noise spacing ${spacing} must be an integer dividing the world width ${world.widthUnits} so X wraps seamlessly`,
        );
      }
    }
    out.push({ spacing, weight: 1 / 2 ** k, periodX, seed: seed * 7919 + k * 1013 });
  }
  return out;
}

export function validateVoxelize(v: VoxelizeConfig): void {
  if (!isGridSize(v.minVoxelSize)) {
    throw new RangeError(`minVoxelSize must be one of 1, 2, 4, 8, 16 units; got ${v.minVoxelSize}`);
  }
  if (!(v.tolerance >= 0) || !Number.isFinite(v.tolerance)) throw new RangeError('tolerance must be a finite number >= 0');
}

export function validateNoiseTerrain(world: WorldConfig, gen: NoiseTerrainConfig): void {
  for (const k of ['hillHeight', 'hillScale', 'detailHeight', 'detailScale'] as const) {
    if (!(gen[k] >= 0) || !Number.isFinite(gen[k])) throw new RangeError(`${k} must be a finite number >= 0`);
  }
  if (gen.hillScale <= 0 || gen.detailScale <= 0) throw new RangeError('noise scales must be > 0');
  const lo = gen.baseHeight - gen.detailHeight;
  const hi = gen.baseHeight + gen.hillHeight + gen.detailHeight;
  if (lo <= world.minYUnits || hi >= world.maxYUnits) {
    throw new RangeError(`terrain heights ${lo}..${hi} exceed the world's Y range`);
  }
}

export class NoiseHeights implements HeightSource {
  private readonly hills: Octave[];
  private readonly detail: Octave[];
  private readonly hillNorm: number;
  private readonly detailNorm: number;
  readonly minHeight: number;
  readonly maxHeight: number;

  constructor(
    world: WorldConfig,
    readonly config: NoiseTerrainConfig,
  ) {
    validateNoiseTerrain(world, config);
    this.hills = octaves(world, config.seed, config.hillScale, HILL_OCTAVES);
    this.detail = octaves(world, config.seed + 1, config.detailScale, DETAIL_OCTAVES);
    // Raw sums lie in [-sum(weights)/2, sum(weights)/2]; normalize to [-1, 1].
    this.hillNorm = 2 / this.hills.reduce((a, o) => a + o.weight, 0);
    this.detailNorm = 2 / this.detail.reduce((a, o) => a + o.weight, 0);
    this.minHeight = Math.floor(config.baseHeight - config.detailHeight);
    this.maxHeight = Math.ceil(config.baseHeight + config.hillHeight + config.detailHeight);
  }

  heights(x0: number, z0: number, w: number, d: number, step = 1): Int32Array {
    const hills = fractalGrid(this.hills, x0, z0, w, d, step);
    const detail = fractalGrid(this.detail, x0, z0, w, d, step);
    const out = new Int32Array(w * d);
    const g = this.config;
    for (let i = 0; i < out.length; i++) {
      // Negative noise is plains; positive noise rises smoothly into hills.
      const t = Math.min(1, Math.max(0, hills[i]! * this.hillNorm * 1.5));
      const hill = t * t * (3 - 2 * t);
      const h = g.baseHeight + g.hillHeight * hill + g.detailHeight * hill * detail[i]! * this.detailNorm;
      out[i] = Math.round(h);
    }
    return out;
  }
}

/** Octree node while building a block: a leaf material (0 = air) or 8 children. */
type Node = number | Node[];

/** Voxelizes any HeightSource adaptively into chunks. */
interface Column {
  H: Int32Array;
  M: Uint16Array | null;
  trees: Tree[];
  /** Water surface per column (units; NO_WATER for none), or null without any water. */
  S: Int32Array | null;
  /** S's lowest and highest over aligned squares (see WaterRanges), or null without S. */
  SR: WaterRanges | null;
  /** Lowest and highest water surface over the ground, or null. */
  water: { min: number; max: number } | null;
}

/**
 * A chunk column's water surface (CHUNK_SIZE across), its lowest and highest over the aligned
 * squares fillWater looks at: for each size 1, 2, 4 .. BLOCK_SIZE, the squares at multiples of it.
 */
class WaterRanges {
  private readonly lo: Int32Array[] = [];
  private readonly hi: Int32Array[] = [];

  constructor(S: Int32Array) {
    this.lo.push(S);
    this.hi.push(S);
    for (let s = 2, l = 1; s <= BLOCK_SIZE; s *= 2, l++) {
      const n = CHUNK_SIZE / s, m = CHUNK_SIZE / (s / 2);
      const lo = new Int32Array(n * n), hi = new Int32Array(n * n), plo = this.lo[l - 1]!, phi = this.hi[l - 1]!;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = 2 * i + m * 2 * j, b = a + m;
          lo[i + n * j] = Math.min(plo[a]!, plo[a + 1]!, plo[b]!, plo[b + 1]!);
          hi[i + n * j] = Math.max(phi[a]!, phi[a + 1]!, phi[b]!, phi[b + 1]!);
        }
      }
      this.lo.push(lo);
      this.hi.push(hi);
    }
  }

  /** The lowest and highest surface over the square of size s (a power of two) at chunk-local (x, z), a multiple of s. */
  low(x: number, z: number, s: number): number {
    const l = 31 - Math.clz32(s), n = CHUNK_SIZE >> l;
    return this.lo[l]![(x >> l) + n * (z >> l)]!;
  }

  high(x: number, z: number, s: number): number {
    const l = 31 - Math.clz32(s), n = CHUNK_SIZE >> l;
    return this.hi[l]![(x >> l) + n * (z >> l)]!;
  }
}

export class TerrainGenerator implements ChunkGenerator {
  /** Per chunk column: surface heights, (if the source provides them) top materials, and trees. */
  /**
   * Per chunk column: surface heights, (if the source provides them) top materials, trees, and
   * the height of the water over each column (the sea, or a river or lake above it; null if
   * none) with the highest of it over ground.
   */
  private readonly columns = new Map<string, Column>();
  private readonly uniform = new Map<MaterialId, UniformBlock>();
  private readonly grassSlack: number;

  constructor(
    readonly world: WorldConfig,
    readonly voxelize: VoxelizeConfig,
    readonly source: HeightSource,
    private readonly columnCacheSize = 512,
  ) {
    validateVoxelize(voxelize);
    this.grassSlack = Math.max(voxelize.tolerance, voxelize.minVoxelSize / 2);
    if (source.minHeight <= world.minYUnits || source.maxHeight >= world.maxYUnits) {
      throw new RangeError(`terrain heights ${source.minHeight}..${source.maxHeight} exceed the world's Y range`);
    }
  }

  get seaLevel(): number | null {
    return this.source.seaLevel ?? null;
  }

  surfaceHeightAt(x: number, z: number): number {
    return this.source.heights(x, z, 1, 1)[0]!;
  }

  climate(): ClimateGrid | null {
    return this.source.climate?.() ?? null;
  }

  surfaceSamples(x0: number, z0: number, step: number, n: number): { heights: Int32Array; materials: Uint16Array; canopy: Canopy | null; water: Int32Array | null } {
    const heights = this.source.heights(x0, z0, n, n, step);
    const materials = this.source.materials?.(x0, z0, n, n, step, heights) ?? new Uint16Array(n * n).fill(Material.Grass);
    // Distant terrain and maps show forests as their canopy, above the ground.
    const canopy = this.source.canopy?.(x0, z0, n, n, step, heights, materials) ?? null;
    // Rivers and lakes: their surface over the ground (and no trees there).
    const water = this.source.water?.(x0, z0, n, n, step) ?? null;
    if (water && canopy) for (let k = 0; k < heights.length; k++) if (water[k]! > heights[k]!) canopy.top[k] = canopy.bottom[k] = NO_CANOPY;
    return { heights, materials, canopy, water };
  }

  columnRange(cx: number, cz: number): ColumnRange {
    const { H, trees, water } = this.chunkColumn(cx, cz);
    let minY = Infinity, maxY = -Infinity;
    for (const h of H) {
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
    // Tree tops (of trees reaching into the column) count too, so crowns are loaded.
    for (const t of trees) maxY = Math.max(maxY, t.y + t.height);
    if (!water) return { minY, maxY };
    // Then the water over the ground.
    return { minY, maxY: Math.max(maxY, water.max), solidTop: maxY, water: { ...water } };
  }

  private chunkColumn(cx: number, cz: number): Column {
    const key = `${cx},${cz}`;
    let col = this.columns.get(key);
    if (col) {
      this.columns.delete(key);
      this.columns.set(key, col);
      return col;
    }
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const H = this.source.heights(x0, z0, CHUNK_SIZE, CHUNK_SIZE);
    const M = this.source.materials?.(x0, z0, CHUNK_SIZE, CHUNK_SIZE, 1, H) ?? null;
    // Water over the columns: the sea, raised to any river or lake above it.
    const sea = this.source.seaLevel;
    const W = this.source.water?.(x0, z0, CHUNK_SIZE, CHUNK_SIZE) ?? null;
    let S: Int32Array | null = null, water: { min: number; max: number } | null = null;
    if (sea !== undefined || W) {
      S = new Int32Array(CHUNK_SIZE * CHUNK_SIZE).fill(sea ?? NO_WATER);
      if (W) for (let k = 0; k < S.length; k++) if (W[k]! > S[k]!) S[k] = W[k]!;
      for (let k = 0; k < S.length; k++) {
        const s = S[k]!;
        if (s <= H[k]!) continue;
        if (!water) water = { min: s, max: s };
        else if (s < water.min) water.min = s;
        else if (s > water.max) water.max = s;
      }
    }
    col = { H, M, trees: this.source.trees?.(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE) ?? [], S, SR: S && new WaterRanges(S), water };
    this.columns.set(key, col);
    if (this.columns.size > this.columnCacheSize) this.columns.delete(this.columns.keys().next().value!);
    return col;
  }

  /**
   * Material of a solid voxel whose top is at `top`, over columns whose lowest
   * surface is `minH` with top material `surface`. Voxelization can round the
   * surface down by up to `grassSlack` (the tolerance, or half a smallest
   * voxel), leaving a voxel that lies slightly below the true surface
   * exposed, so those get the surface material too.
   */
  private materialFor(minH: number, top: number, surface: MaterialId): MaterialId {
    if (surface === Material.Ice) return Material.Ice; // ice sheets are ice all the way down
    const depth = minH - top;
    if (depth <= this.grassSlack) return surface;
    if (depth < DIRT_DEPTH) return subsurface(surface);
    return Material.Stone;
  }

  private uniformBlock(material: MaterialId): UniformBlock {
    let b = this.uniform.get(material);
    if (!b) this.uniform.set(material, (b = { kind: 'uniform', size: BLOCK_SIZE, material }));
    return b;
  }

  generateChunk(coord: ChunkCoord): Chunk {
    const chunk = emptyChunk(coord);
    const w = this.world;
    const x0 = coord.cx * CHUNK_SIZE;
    const y0 = coord.cy * CHUNK_SIZE;
    const z0 = coord.cz * CHUNK_SIZE;
    if (x0 < 0 || x0 >= w.widthUnits || z0 < 0 || z0 >= w.depthUnits) return chunk;
    if (y0 < w.minYUnits || y0 >= w.maxYUnits) return chunk;

    const { H, M, trees, S, SR } = this.chunkColumn(coord.cx, coord.cz);
    const oreX = x0 / BLOCK_SIZE, oreZ = z0 / BLOCK_SIZE;
    // Per block column: min / max surface height, and the top material at the minimum.
    const bMin = new Int32Array(BLOCKS_PER_AXIS * BLOCKS_PER_AXIS).fill(2 ** 31 - 1);
    const bMax = new Int32Array(BLOCKS_PER_AXIS * BLOCKS_PER_AXIS).fill(-(2 ** 31));
    const bMat = new Uint16Array(BLOCKS_PER_AXIS * BLOCKS_PER_AXIS).fill(Material.Grass);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const i = x + CHUNK_SIZE * z;
        const h = H[i]!;
        const k = (x >> 4) + BLOCKS_PER_AXIS * (z >> 4);
        if (h < bMin[k]!) {
          bMin[k] = h;
          if (M) bMat[k] = M[i]!;
        }
        if (h > bMax[k]!) bMax[k] = h;
      }
    }

    for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++) {
      for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
        const k = bx + BLOCKS_PER_AXIS * bz;
        const minH = bMin[k]!, maxH = bMax[k]!;
        for (let by = 0; by < BLOCKS_PER_AXIS; by++) {
          const by0 = y0 + by * BLOCK_SIZE;
          if (by0 >= maxH) break; // this and every block above is air
          let block: Block;
          if (by0 + BLOCK_SIZE <= minH) {
            // Wholly underground: its material, and deep in the stone, maybe ore (see oreAt).
            let m = this.materialFor(minH, by0 + BLOCK_SIZE, bMat[k]!);
            if (m === Material.Stone) m = oreAt(oreX + bx, by0 / BLOCK_SIZE, oreZ + bz, minH - (by0 + BLOCK_SIZE));
            block = this.uniformBlock(m);
          } else block = this.buildBlock(H, M, SR, bx * BLOCK_SIZE, by0, bz * BLOCK_SIZE);
          chunk.blocks[blockIndex(bx, by, bz)] = block;
        }
      }
    }
    if (trees.length > 0) plantTrees(chunk, trees);
    // Water over the ground: the sea, rivers and lakes (blocks through the ground got theirs as
    // they were built).
    if (S && SR) {
      for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++) {
        for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
          const top = Math.max(NO_WATER, SR.high(bx * BLOCK_SIZE, bz * BLOCK_SIZE, BLOCK_SIZE));
          for (let by = 0; by < BLOCKS_PER_AXIS && y0 + by * BLOCK_SIZE < top; by++) {
            const i = blockIndex(bx, by, bz);
            if (chunk.blocks[i]) continue;
            const voxels = this.waterVoxels(SR, bx * BLOCK_SIZE, y0 + by * BLOCK_SIZE, bz * BLOCK_SIZE);
            if (voxels.packed.length === 1 && voxels.packed[0] === packVoxel(0, 0, 0, BLOCK_SIZE)) chunk.blocks[i] = setBlockWater(null, 0);
            else if (voxels.packed.length) chunk.blocks[i] = { kind: 'voxels', packed: Uint16Array.from(voxels.packed), materials: Uint16Array.from(voxels.materials) };
          }
        }
      }
    }
    return chunk;
  }

  /**
   * Source water filling the open cube [x, x+s)^3 (block-local units; the block's corner at
   * chunk-local (lx, lz) and world y `y0`) below each column's water surface `S`.
   */
  private fillWater(S: WaterRanges, lx: number, y0: number, lz: number, x: number, y: number, z: number, s: number, out: { packed: number[]; materials: number[] }): void {
    const lo = S.low(lx + x, lz + z, s), hi = S.high(lx + x, lz + z, s);
    if (y0 + y + s <= lo) {
      out.packed.push(packVoxel(x, y, z, s));
      out.materials.push(Material.Water);
    } else if (y0 + y < hi && s > 1) {
      // A surface cuts through (or varies across) the cube: halves.
      const t = s / 2;
      for (let i = 0; i < 8; i++) this.fillWater(S, lx, y0, lz, x + (i & 1) * t, y + ((i >> 2) & 1) * t, z + ((i >> 1) & 1) * t, t, out);
    }
  }

  /** Water voxels for an empty block (see fillWater). */
  private waterVoxels(S: WaterRanges, lx: number, y0: number, lz: number): { packed: number[]; materials: number[] } {
    const out = { packed: [] as number[], materials: [] as number[] };
    this.fillWater(S, lx, y0, lz, 0, 0, 0, BLOCK_SIZE, out);
    return out;
  }

  /**
   * Voxelizes the block whose corner is at chunk-local (lx, lz) and world y `y0`; open space
   * below the columns' water surfaces `S` (if any) is source water.
   */
  private buildBlock(H: Int32Array, M: Uint16Array | null, S: WaterRanges | null, lx: number, y0: number, lz: number): Block {
    const root = this.buildNode(H, M, lx, y0, lz, BLOCK_SIZE);
    if (typeof root === 'number') {
      if (root !== 0) return this.uniformBlock(root);
      if (!S) return null;
      const w = this.waterVoxels(S, lx, y0, lz);
      if (w.packed.length === 0) return null;
      if (w.packed.length === 1 && w.packed[0] === packVoxel(0, 0, 0, BLOCK_SIZE)) return setBlockWater(null, 0);
      return { kind: 'voxels', packed: Uint16Array.from(w.packed), materials: Uint16Array.from(w.materials) };
    }
    const packed: number[] = [];
    const materials: number[] = [];
    const out = { packed, materials };
    const walk = (node: Node, x: number, y: number, z: number, s: number) => {
      if (typeof node === 'number') {
        if (node !== 0) {
          packed.push(packVoxel(x, y, z, s));
          materials.push(node);
        } else if (S) this.fillWater(S, lx, y0, lz, x, y, z, s, out);
        return;
      }
      const t = s / 2;
      node.forEach((child, i) => walk(child, x + (i & 1) * t, y + ((i >> 2) & 1) * t, z + ((i >> 1) & 1) * t, t));
    };
    walk(root, 0, 0, 0, BLOCK_SIZE);
    return { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
  }

  /**
   * Builds the octree node for the cube at chunk-local columns [lx, lx+s) x
   * [lz, lz+s) and world heights [y, y+s).
   */
  private buildNode(H: Int32Array, M: Uint16Array | null, lx: number, y: number, lz: number, s: number): Node {
    let minH = Infinity, maxH = -Infinity, sum = 0, minAt = 0;
    for (let z = lz; z < lz + s; z++) {
      for (let x = lx; x < lx + s; x++) {
        const i = x + CHUNK_SIZE * z;
        const h = H[i]!;
        if (h < minH) {
          minH = h;
          minAt = i;
        }
        if (h > maxH) maxH = h;
        sum += h;
      }
    }
    const surface = M ? M[minAt]! : Material.Grass;
    const top = y + s;
    const tol = this.voxelize.tolerance;
    if (minH >= top) return this.materialFor(minH, top, surface);
    if (maxH <= y) return 0;
    if (s <= this.voxelize.minVoxelSize) {
      // Smallest allowed voxel: solid if the mean surface covers at least half of it.
      return sum / (s * s) - y >= s / 2 ? this.materialFor(minH, top, surface) : 0;
    }
    if (top - minH <= tol) return this.materialFor(minH, top, surface);
    if (maxH - y <= tol) return 0;

    const t = s / 2;
    const children: Node[] = [];
    for (let i = 0; i < 8; i++) {
      children.push(this.buildNode(H, M, lx + (i & 1) * t, y + ((i >> 2) & 1) * t, lz + ((i >> 1) & 1) * t, t));
    }
    const first = children[0];
    if (typeof first === 'number' && children.every((c) => c === first)) return first;
    return children;
  }
}

/**
 * Surface samples for a map: `cols` x `rows` cells of `step` units from (x0, z0) (units), each
 * sampled at its centre, as seen from above: forests as their canopy, rivers and lakes as water
 * (the sea is left to the reader, from `seaLevel`). Heights are units (clamped to 16 bits).
 */
export function surfaceMap(
  generator: Pick<ChunkGenerator, 'surfaceSamples'> & { readonly seaLevel?: number | null }, x0: number, z0: number, step: number, cols: number, rows: number,
): { cols: number; rows: number; step: number; seaLevel: number | null; heights: Int16Array; materials: Uint8Array } {
  const n = Math.max(cols, rows);
  const s = generator.surfaceSamples(x0 + Math.floor(step / 2), z0 + Math.floor(step / 2), step, n);
  const heights = new Int16Array(cols * rows);
  const materials = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = i + n * j, tree = s.canopy && s.canopy.top[k] !== NO_CANOPY;
      const wet = s.water && s.water[k]! > s.heights[k]!;
      heights[i + cols * j] = Math.max(-32767, Math.min(32767, wet ? s.water![k]! : tree ? s.canopy!.top[k]! : s.heights[k]!));
      materials[i + cols * j] = Math.min(255, wet ? Material.Water : tree ? s.canopy!.material[k]! : s.materials[k]!);
    }
  }
  return { cols, rows, step, seaLevel: generator.seaLevel ?? null, heights, materials };
}
