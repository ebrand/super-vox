import type { ClimateGrid } from './climate.js';
import type { Canopy } from './trees.js';
import { MAX_VOXEL_SIZE, type VoxelSize } from './units.js';
import { CHUNK_SIZE, type ChunkCoord } from './world.js';
import type { MaterialId } from './materials.js';

/**
 * Chunks (16 m) are divided into 1 m blocks: 16 x 16 x 16 = 4096 per chunk.
 * Every voxel lies entirely within one block, so a block is the unit of
 * storage and of editing.
 */
export const BLOCK_SIZE = MAX_VOXEL_SIZE;
export const BLOCKS_PER_AXIS = CHUNK_SIZE / BLOCK_SIZE;
export const BLOCKS_PER_CHUNK = BLOCKS_PER_AXIS ** 3;

/** Voxel sizes a block grid can use: sizes that tile a 1 m block exactly. */
export const GRID_SIZES: readonly VoxelSize[] = [1, 2, 4, 8, 16];

export function isGridSize(size: number): boolean {
  return GRID_SIZES.includes(size);
}

/** A block completely filled with voxels of one size and one material. */
export interface UniformBlock {
  kind: 'uniform';
  size: VoxelSize;
  material: MaterialId;
}

/**
 * A block tiled by an n x n x n grid of equal voxels, n = 16 / size.
 * `materials[x + n * (z + n * y)]` is each cell's material; 0 means empty.
 */
export interface GridBlock {
  kind: 'grid';
  size: VoxelSize;
  materials: Uint16Array;
}

/**
 * A block holding an explicit list of non-overlapping voxels of any valid
 * size (1..16), each inside the block. Space not covered by a voxel is air.
 * `packed[i]` = x | y << 4 | z << 8 | (size - 1) << 12 (block-local units);
 * `materials[i]` is voxel i's material (never 0).
 */
export interface VoxelsBlock {
  kind: 'voxels';
  packed: Uint16Array;
  materials: Uint16Array;
}

/** `null` is an empty (all-air) block. */
export type Block = UniformBlock | GridBlock | VoxelsBlock | null;

export function packVoxel(x: number, y: number, z: number, size: number): number {
  return x | (y << 4) | (z << 8) | ((size - 1) << 12);
}

export function unpackVoxel(p: number): { x: number; y: number; z: number; size: number } {
  return { x: p & 15, y: (p >> 4) & 15, z: (p >> 8) & 15, size: ((p >> 12) & 15) + 1 };
}

/**
 * Unit-resolution view of a voxels block: for each of the 16^3 unit cells
 * (index x + 16 * (z + 16 * y)), the material and the size of the voxel
 * covering it (0 = air).
 */
export interface BlockRaster {
  materials: Uint16Array;
  sizes: Uint8Array;
  /** Index + 1 of the voxel covering each unit cell in `packed`; 0 for air. */
  index: Uint16Array;
}

const rasterCache = new WeakMap<VoxelsBlock, BlockRaster>();

export function unitIndex(x: number, y: number, z: number): number {
  return x + BLOCK_SIZE * (z + BLOCK_SIZE * y);
}

/**
 * Rasterizes a voxels block (cached per block object). Throws if voxels
 * overlap, leave the block, or have invalid sizes or materials.
 */
export function rasterizeVoxels(block: VoxelsBlock): BlockRaster {
  const cached = rasterCache.get(block);
  if (cached) return cached;
  if (block.packed.length !== block.materials.length) {
    throw new RangeError('voxels block: packed/materials length mismatch');
  }
  const materials = new Uint16Array(BLOCK_SIZE ** 3);
  const sizes = new Uint8Array(BLOCK_SIZE ** 3);
  const index = new Uint16Array(BLOCK_SIZE ** 3);
  for (let i = 0; i < block.packed.length; i++) {
    const { x, y, z, size } = unpackVoxel(block.packed[i]!);
    const m = block.materials[i]!;
    if (m === 0) throw new RangeError(`voxels block: voxel ${i} has air material`);
    if (x + size > BLOCK_SIZE || y + size > BLOCK_SIZE || z + size > BLOCK_SIZE) {
      throw new RangeError(`voxels block: voxel ${i} crosses the block boundary`);
    }
    for (let yy = y; yy < y + size; yy++) {
      for (let zz = z; zz < z + size; zz++) {
        for (let xx = x; xx < x + size; xx++) {
          const idx = unitIndex(xx, yy, zz);
          if (materials[idx] !== 0) throw new RangeError(`voxels block: voxel ${i} overlaps another`);
          materials[idx] = m;
          sizes[idx] = size;
          index[idx] = i + 1;
        }
      }
    }
  }
  const raster = { materials, sizes, index };
  rasterCache.set(block, raster);
  return raster;
}

/** Material and voxel size at block-local unit coordinates (0..15); null for air. */
export function blockVoxelAt(block: Block, x: number, y: number, z: number): { material: MaterialId; size: number } | null {
  if (!block) return null;
  if (block.kind === 'uniform') return { material: block.material, size: block.size };
  if (block.kind === 'grid') {
    const n = BLOCK_SIZE / block.size;
    const m =
      block.materials[gridCellIndex(n, Math.floor(x / block.size), Math.floor(y / block.size), Math.floor(z / block.size))] ?? 0;
    return m === 0 ? null : { material: m, size: block.size };
  }
  const r = rasterizeVoxels(block);
  const idx = unitIndex(x, y, z);
  const m = r.materials[idx]!;
  return m === 0 ? null : { material: m, size: r.sizes[idx]! };
}

/** Generates chunks for a world. */
export interface ChunkGenerator {
  generateChunk(coord: ChunkCoord): Chunk;
  /** Y (units) of the top of the ground at unit column (x, z), for spawning. */
  surfaceHeightAt(x: number, z: number): number;
  /**
   * Ground heights and top materials for an n x n grid of unit columns,
   * sample (i, j) at column (x0 + i * step, z0 + j * step); used for distant
   * low-detail tiles. Row-major (i + n * j).
   */
  surfaceSamples(x0: number, z0: number, step: number, n: number): {
    heights: Int32Array;
    materials: Uint16Array;
    canopy?: Canopy | null;
    /** River and lake surfaces over the ground (NO_WATER where none), or null for none. */
    water?: Int32Array | null;
  };
  /** Height range (units) of what's in chunk column (cx, cz): see ColumnRange. */
  columnRange(cx: number, cz: number): ColumnRange;
  /** Y (units) of the sea surface, or null for worlds without a sea. */
  readonly seaLevel: number | null;
  /** The climate for blending biome colours, or null where biomes don't blend; `forWeather`, wherever there are biomes (see weather.ts). */
  climate?(forWeather?: boolean): ClimateGrid | null;
  /** Where caves are, roughly (see caveOverview; entrances only on land), or null for a world without. */
  caveOverview?(): { cell: number; cols: number; rows: number; regions: Uint8Array; entrances: [number, number][] } | null;
}

/**
 * What a chunk column holds, in units: everything (ground, trees, water) lies within [minY, maxY].
 * Where there is water over the ground, `water` spans its surfaces and `solidTop` is the top of
 * everything that isn't water; chunks between the two hold only water.
 */
export interface ColumnRange {
  minY: number;
  maxY: number;
  solidTop?: number;
  water?: { min: number; max: number };
}

export interface Chunk extends ChunkCoord {
  /** BLOCKS_PER_CHUNK entries, indexed by blockIndex(). May share Block objects. */
  blocks: Block[];
}

export function blockIndex(bx: number, by: number, bz: number): number {
  return bx + BLOCKS_PER_AXIS * (bz + BLOCKS_PER_AXIS * by);
}

export function gridCellIndex(n: number, x: number, y: number, z: number): number {
  return x + n * (z + n * y);
}

export function emptyChunk(coord: ChunkCoord): Chunk {
  return { ...coord, blocks: new Array<Block>(BLOCKS_PER_CHUNK).fill(null) };
}

/**
 * Material of the voxel covering the unit cell at chunk-local unit coordinates
 * (0..CHUNK_SIZE-1 on each axis).
 */
export function materialAt(chunk: Chunk, lx: number, ly: number, lz: number): MaterialId {
  return voxelAt(chunk, lx, ly, lz)?.material ?? 0;
}

/** Material and size of the voxel covering a chunk-local unit cell; null for air. */
export function voxelAt(chunk: Chunk, lx: number, ly: number, lz: number): { material: MaterialId; size: number } | null {
  const block =
    chunk.blocks[
      blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE))
    ] ?? null;
  return blockVoxelAt(block, lx % BLOCK_SIZE, ly % BLOCK_SIZE, lz % BLOCK_SIZE);
}
