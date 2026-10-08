import { BLOCK_SIZE, BLOCKS_PER_AXIS, Material, blockIndex, blockVoxelContaining, isWater, type Chunk } from '@super-vox/shared';
import type { Quad } from './mesher.js';

/**
 * Where grass blades grow (see GrassField): the open tops of a chunk's grass and dry grass, not
 * under water. Eight numbers each (chunk-local units): x, y (the top), z, the size across x and
 * across z; sky light (0 dark .. 255 open to the sky) and block light (0 .. 255) there; and 1 for
 * dry grass, 0 for green.
 */
export const GRASS_TOP_FIELDS = 8;

/** The grass tops among a chunk's visible faces (see visibleFaces: unmerged across blocks), `chunk` with its water; null for none. */
export function grassTops(quads: readonly Quad[], chunk: Chunk): Uint16Array | null {
  const out: number[] = [];
  const S = BLOCK_SIZE, N = BLOCKS_PER_AXIS * S;
  for (const q of quads) {
    // (+Y faces: the plane is y; u runs along z, v along x.)
    if (q.dir !== 2 || (q.material !== Material.Grass && q.material !== Material.DryGrass)) continue;
    const x = q.v, y = q.plane, z = q.u, dx = q.dv, dz = q.du;
    // Water over it: none grows.
    if (y < N) {
      const cx = x + dx / 2, cz = z + dz / 2;
      const block = chunk.blocks[blockIndex(Math.floor(cx / S), Math.floor(y / S), Math.floor(cz / S))] ?? null;
      const v = blockVoxelContaining(block, cx % S, y % S, cz % S);
      if (v && isWater(v.material)) continue;
    }
    const avg = (c: readonly number[] | undefined, none: number) => (c ? Math.round((c[0]! + c[1]! + c[2]! + c[3]!) / 4) : none);
    out.push(x, y, z, dx, dz, avg(q.light, 255), avg(q.glow, 0), q.material === Material.DryGrass ? 1 : 0);
  }
  return out.length ? Uint16Array.from(out) : null;
}
