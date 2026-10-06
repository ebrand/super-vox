import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, CHUNK_SIZE, Material, blockIndex, emptyChunk, type Chunk, type ChunkCoord } from '@super-vox/shared';
import { coveredAboveFor } from './worldQuery.js';

/** Chunks from a map (missing: not loaded; null: empty). */
function world(chunks: Map<string, Chunk | null>) {
  return { chunkAt: (c: ChunkCoord) => chunks.get(`${c.cx},${c.cy},${c.cz}`) };
}

/** A chunk at (0, cy, 0) with one block of `material` at block (bx, by, bz). */
function withBlock(cy: number, bx: number, by: number, bz: number, material: number): Chunk {
  const c = emptyChunk({ cx: 0, cy, cz: 0 });
  c.blocks[blockIndex(bx, by, bz)] = { kind: 'uniform', size: BLOCK_SIZE, material };
  return c;
}

describe('coveredAboveFor', () => {
  const x = 3 * BLOCK_SIZE + 5, z = 7 * BLOCK_SIZE + 2;

  it('sees leaves above (which the sky light lets through), in the next chunk up too', () => {
    const covered = coveredAboveFor(world(new Map([['0,0,0', emptyChunk({ cx: 0, cy: 0, cz: 0 })], ['0,1,0', withBlock(1, 3, 4, 7, Material.Leaves)]])));
    expect(covered(x, 2 * BLOCK_SIZE, z, 4 * CHUNK_SIZE)).toBe(true);
    // (Not when it's out of reach, or above the leaves, or beside them.)
    expect(covered(x, 2 * BLOCK_SIZE, z, CHUNK_SIZE)).toBe(false);
    expect(covered(x, CHUNK_SIZE + 5 * BLOCK_SIZE, z, 4 * CHUNK_SIZE)).toBe(false);
    expect(covered(x + BLOCK_SIZE, 2 * BLOCK_SIZE, z, 4 * CHUNK_SIZE)).toBe(false);
  });

  it('a roof covers; water, empty and unloaded chunks do not', () => {
    expect(coveredAboveFor(world(new Map([['0,0,0', withBlock(0, 3, 10, 7, Material.Stone)]])))(x, 0, z, CHUNK_SIZE)).toBe(true);
    expect(coveredAboveFor(world(new Map([['0,0,0', withBlock(0, 3, 10, 7, Material.Water)]])))(x, 0, z, CHUNK_SIZE)).toBe(false);
    expect(coveredAboveFor(world(new Map([['0,0,0', null]])))(x, 0, z, 4 * CHUNK_SIZE)).toBe(false);
    expect(coveredAboveFor(world(new Map()))(x, 0, z, 4 * CHUNK_SIZE)).toBe(false);
  });

  it('a thin slab (smaller voxels) covers only where it is', () => {
    const c = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    const n = BLOCK_SIZE / 4, materials = new Uint16Array(n * n * n);
    materials[0] = Material.Stone; // cell (0, 0, 0): the block's corner, 4 units across
    c.blocks[blockIndex(3, 10, 7)] = { kind: 'grid', size: 4, materials };
    const covered = coveredAboveFor(world(new Map([['0,0,0', c]])));
    expect(covered(3 * BLOCK_SIZE + 1, 0, 7 * BLOCK_SIZE + 1, CHUNK_SIZE)).toBe(true);
    expect(covered(3 * BLOCK_SIZE + 9, 0, 7 * BLOCK_SIZE + 1, CHUNK_SIZE)).toBe(false);
  });
});
