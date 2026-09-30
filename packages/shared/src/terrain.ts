import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  blockIndex,
  emptyChunk,
  isGridSize,
  packVoxel,
  type Block,
  type Chunk,
  type ChunkGenerator,
  type UniformBlock,
} from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import { fractalGrid, type Octave } from './noise.js';
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
}

/** What lies beneath a surface material, down to DIRT_DEPTH. */
function subsurface(top: MaterialId): MaterialId {
  if (top === Material.Grass) return Material.Dirt;
  if (top === Material.Sand) return Material.Sand;
  return Material.Stone;
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
const DIRT_DEPTH = 3 * 16;

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
export class TerrainGenerator implements ChunkGenerator {
  /** Per chunk column: surface heights and (if the source provides them) top materials. */
  private readonly columns = new Map<string, { H: Int32Array; M: Uint16Array | null }>();
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

  surfaceSamples(x0: number, z0: number, step: number, n: number): { heights: Int32Array; materials: Uint16Array } {
    const heights = this.source.heights(x0, z0, n, n, step);
    const materials = this.source.materials?.(x0, z0, n, n, step, heights) ?? new Uint16Array(n * n).fill(Material.Grass);
    return { heights, materials };
  }

  columnRange(cx: number, cz: number): { minY: number; maxY: number } {
    const { H } = this.chunkColumn(cx, cz);
    let minY = Infinity, maxY = -Infinity;
    for (const h of H) {
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
    return { minY, maxY };
  }

  private chunkColumn(cx: number, cz: number): { H: Int32Array; M: Uint16Array | null } {
    const key = `${cx},${cz}`;
    let col = this.columns.get(key);
    if (col) {
      this.columns.delete(key);
      this.columns.set(key, col);
      return col;
    }
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const H = this.source.heights(x0, z0, CHUNK_SIZE, CHUNK_SIZE);
    col = { H, M: this.source.materials?.(x0, z0, CHUNK_SIZE, CHUNK_SIZE, 1, H) ?? null };
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

    const { H, M } = this.chunkColumn(coord.cx, coord.cz);
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
          chunk.blocks[blockIndex(bx, by, bz)] =
            by0 + BLOCK_SIZE <= minH
              ? this.uniformBlock(this.materialFor(minH, by0 + BLOCK_SIZE, bMat[k]!))
              : this.buildBlock(H, M, bx * BLOCK_SIZE, by0, bz * BLOCK_SIZE);
        }
      }
    }
    return chunk;
  }

  /** Voxelizes the block whose corner is at chunk-local (lx, lz) and world y `y0`. */
  private buildBlock(H: Int32Array, M: Uint16Array | null, lx: number, y0: number, lz: number): Block {
    const root = this.buildNode(H, M, lx, y0, lz, BLOCK_SIZE);
    if (typeof root === 'number') return root === 0 ? null : this.uniformBlock(root);
    const packed: number[] = [];
    const materials: number[] = [];
    const walk = (node: Node, x: number, y: number, z: number, s: number) => {
      if (typeof node === 'number') {
        if (node !== 0) {
          packed.push(packVoxel(x, y, z, s));
          materials.push(node);
        }
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
