import { CHUNK_SIZE, voxelAt } from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import type { SolidAt } from './picking.js';

const floorDiv = (v: number, m: number) => Math.floor(v / m);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Solidity of world unit cells from the loaded full-detail chunks (undefined = not loaded). */
export function solidAtFor(chunks: ChunkManager): SolidAt {
  return (x, y, z) => {
    const chunk = chunks.chunkAt({ cx: floorDiv(x, CHUNK_SIZE), cy: floorDiv(y, CHUNK_SIZE), cz: floorDiv(z, CHUNK_SIZE) });
    if (chunk === undefined) return undefined;
    if (chunk === null) return false;
    return voxelAt(chunk, mod(x, CHUNK_SIZE), mod(y, CHUNK_SIZE), mod(z, CHUNK_SIZE)) !== null;
  };
}
