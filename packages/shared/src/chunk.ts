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

/** `null` is an empty (all-air) block. */
export type Block = UniformBlock | GridBlock | null;

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
  const block =
    chunk.blocks[
      blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE))
    ];
  if (!block) return 0;
  if (block.kind === 'uniform') return block.material;
  const n = BLOCK_SIZE / block.size;
  const cx = Math.floor((lx % BLOCK_SIZE) / block.size);
  const cy = Math.floor((ly % BLOCK_SIZE) / block.size);
  const cz = Math.floor((lz % BLOCK_SIZE) / block.size);
  return block.materials[gridCellIndex(n, cx, cy, cz)] ?? 0;
}
