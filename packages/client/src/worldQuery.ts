import { CHUNK_SIZE, isWater, voxelAt } from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import type { SolidAt } from './picking.js';

const floorDiv = (v: number, m: number) => Math.floor(v / m);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Material of a world unit cell from the loaded full-detail chunks (0 = air; undefined = not loaded). */
function materialAtFor(chunks: ChunkManager): (x: number, y: number, z: number) => number | undefined {
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
