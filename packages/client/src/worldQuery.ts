import { BLOCK_SIZE, CHUNK_SIZE, blockIndex, blockVoxelAt, isWater, voxelAt } from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import type { SolidAt } from './picking.js';

const floorDiv = (v: number, m: number) => Math.floor(v / m);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Material of a world unit cell from the loaded full-detail chunks (0 = air; undefined = not loaded). */
export function materialAtFor(chunks: ChunkManager): (x: number, y: number, z: number) => number | undefined {
  return (x, y, z) => {
    const chunk = chunks.chunkAt({ cx: floorDiv(x, CHUNK_SIZE), cy: floorDiv(y, CHUNK_SIZE), cz: floorDiv(z, CHUNK_SIZE) });
    if (chunk === undefined) return undefined;
    if (chunk === null) return 0;
    return voxelAt(chunk, mod(x, CHUNK_SIZE), mod(y, CHUNK_SIZE), mod(z, CHUNK_SIZE))?.material ?? 0;
  };
}

/** Solidity of world unit cells (water isn't solid; undefined = not loaded). */
export function solidAtFor(chunks: ChunkManager): SolidAt {
  const at = materialAtFor(chunks);
  return (x, y, z) => {
    const m = at(Math.floor(x), Math.floor(y), Math.floor(z));
    return m === undefined ? undefined : m !== 0 && !isWater(m);
  };
}

/** Whether a world unit cell is water (undefined = not loaded). */
export function waterAtFor(chunks: ChunkManager): SolidAt {
  const at = materialAtFor(chunks);
  return (x, y, z) => {
    const m = at(Math.floor(x), Math.floor(y), Math.floor(z));
    return m === undefined ? undefined : isWater(m);
  };
}

/**
 * Whether anything but air and water is straight above world unit (x, y, z), up to `reach` units
 * higher, in the loaded chunks (leaves too, unlike the sky light's skyOpen: rain doesn't fall
 * through a tree). Chunks not loaded count as open.
 */
export function coveredAboveFor(chunks: Pick<ChunkManager, 'chunkAt'>): (x: number, y: number, z: number, reach: number) => boolean {
  return (x, y, z, reach) => {
    x = Math.floor(x);
    z = Math.floor(z);
    const cx = floorDiv(x, CHUNK_SIZE), cz = floorDiv(z, CHUNK_SIZE), lx = mod(x, CHUNK_SIZE), lz = mod(z, CHUNK_SIZE);
    const top = Math.floor(y) + reach;
    let at = Math.floor(y) + 1;
    while (at <= top) {
      const cy = floorDiv(at, CHUNK_SIZE), chunk = chunks.chunkAt({ cx, cy, cz });
      // (Empty or not loaded: on to the next chunk up.)
      if (!chunk) {
        at = (cy + 1) * CHUNK_SIZE;
        continue;
      }
      const ly = mod(at, CHUNK_SIZE);
      const block = chunk.blocks[blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE))] ?? null;
      if (!block) {
        at += BLOCK_SIZE - (ly % BLOCK_SIZE);
        continue;
      }
      const v = blockVoxelAt(block, lx % BLOCK_SIZE, ly % BLOCK_SIZE, lz % BLOCK_SIZE);
      if (v && !isWater(v.material)) return true;
      at++;
    }
    return false;
  };
}
