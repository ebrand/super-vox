import { MAX_VOXEL_SIZE } from './units.js';
import { Material, isWater, type MaterialId } from './materials.js';
import { BLOCKS_PER_AXIS, BLOCK_SIZE, voxelAt, type Chunk } from './chunk.js';
import { blockVoxels, removeBoxChunks } from './edit.js';
import { CHUNK_SIZE } from './world.js';

/**
 * Mining in survival takes time: how long, by hand, to dig out a whole 1 m block of each material
 * (seconds). Smaller voxels go proportionally quicker (by their edge: a 1/16 m voxel of stone in
 * 1/16 of a block's time), and a box takes as long as what's in it. Creative digs at once.
 */
export const HARDNESS: Partial<Record<MaterialId, number>> = {
  [Material.Leaves]: 0.3,
  [Material.Needles]: 0.3,
  [Material.JungleLeaves]: 0.3,
  [Material.AcaciaLeaves]: 0.3,
  [Material.Snow]: 0.4,
  [Material.Sand]: 0.6,
  [Material.DesertSand]: 0.6,
  [Material.Dirt]: 0.75,
  [Material.Grass]: 0.75,
  [Material.JungleFloor]: 0.75,
  [Material.DryGrass]: 0.75,
  [Material.Meadow]: 0.75,
  [Material.TaigaFloor]: 0.75,
  [Material.Tundra]: 0.75,
  [Material.Ice]: 1,
  [Material.Planks]: 1.5,
  [Material.CraftingTable]: 1.5,
  [Material.FenceWood]: 1.5,
  [Material.GateWood]: 1.5,
  [Material.DoorWood]: 1.5,
  [Material.Wood]: 2,
  [Material.Cobblestone]: 2.5,
  [Material.Stone]: 3,
};

/** Hardness of materials not listed (anything new): as dirt. */
const DEFAULT_HARDNESS = 0.75;

/** Seconds to mine a 1 m block of `m` (0 for water and air, which aren't mined). */
export function hardnessOf(m: MaterialId): number {
  if (m === Material.Air || m === Material.Water || m === Material.PouredWater) return 0;
  return HARDNESS[m] ?? DEFAULT_HARDNESS;
}

/** Seconds to mine one voxel of `size` (units) of material `m`. */
export function voxelMiningTime(m: MaterialId, size: number): number {
  return hardnessOf(m) * (size / MAX_VOXEL_SIZE);
}

/**
 * Seconds to mine everything in a box of edge `boxSize` (units): the voxels in it (with how much
 * of each is inside), each by its share of the box, as a whole box of it would take. A box full
 * of one material takes as long as one voxel of the box's size.
 */
export function boxMiningTime(voxels: readonly { material: MaterialId; volumeInside: number }[], boxSize: number): number {
  let t = 0;
  const box = boxSize ** 3;
  for (const v of voxels) t += hardnessOf(v.material) * (v.volumeInside / box);
  return t * (boxSize / MAX_VOXEL_SIZE);
}

/**
 * Seconds to mine what a removal takes out (the voxel at a point, or everything in a box), from
 * the chunks as they are (`chunkAt`: by chunk coordinates, null where there's none); 0 for nothing.
 */
export function editMiningTime(
  edit: { op: 'remove'; x: number; y: number; z: number } | { op: 'removeBox'; x: number; y: number; z: number; size: number },
  chunkAt: (cx: number, cy: number, cz: number) => Chunk | null | undefined,
): number {
  const n = CHUNK_SIZE;
  if (edit.op === 'remove') {
    const cx = Math.floor(edit.x / n), cy = Math.floor(edit.y / n), cz = Math.floor(edit.z / n);
    const chunk = chunkAt(cx, cy, cz);
    if (!chunk) return 0;
    const v = voxelAt(chunk, edit.x - cx * n, edit.y - cy * n, edit.z - cz * n);
    return v && !isWater(v.material) ? voxelMiningTime(v.material, v.size) : 0;
  }
  // Everything in the box, by how much of each voxel is inside.
  const inside: { material: MaterialId; volumeInside: number }[] = [];
  const b0 = [edit.x, edit.y, edit.z], b1 = b0.map((v) => v + edit.size);
  for (const c of removeBoxChunks(edit)) {
    const chunk = chunkAt(c.cx, c.cy, c.cz);
    if (!chunk) continue;
    const o = [c.cx * n, c.cy * n, c.cz * n];
    chunk.blocks.forEach((block, i) => {
      if (!block) return;
      const bx = i % BLOCKS_PER_AXIS, bz = Math.floor(i / BLOCKS_PER_AXIS) % BLOCKS_PER_AXIS, by = Math.floor(i / (BLOCKS_PER_AXIS * BLOCKS_PER_AXIS));
      const corner = [o[0]! + bx * BLOCK_SIZE, o[1]! + by * BLOCK_SIZE, o[2]! + bz * BLOCK_SIZE];
      if (corner.some((v, a) => v >= b1[a]! || v + BLOCK_SIZE <= b0[a]!)) return;
      for (const v of blockVoxels(block)) {
        if (isWater(v.material)) continue;
        let vol = 1;
        for (const [a, lo] of [[0, corner[0]! + v.x], [1, corner[1]! + v.y], [2, corner[2]! + v.z]] as const) vol *= Math.max(0, Math.min(lo + v.size, b1[a]!) - Math.max(lo, b0[a]!));
        if (vol > 0) inside.push({ material: v.material, volumeInside: vol });
      }
    });
  }
  return boxMiningTime(inside, edit.size);
}

/**
 * Whether a survival removal that started mining at `startedAt` (ms) may finish at `now` (ms),
 * needing `seconds`: allowing for the time messages take (the client counts from when it pressed,
 * the server from when it heard).
 */
export function minedLongEnough(startedAt: number | null, now: number, seconds: number): boolean {
  if (seconds <= 0) return true;
  if (startedAt === null) return false;
  return now - startedAt >= seconds * 1000 * MINING_SLACK - MINING_LATENCY_MS;
}

/** Of the mining time, how much the server insists on; and the delay it forgives (ms). */
export const MINING_SLACK = 0.8;
export const MINING_LATENCY_MS = 150;
