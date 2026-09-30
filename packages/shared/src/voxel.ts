import type { MaterialId } from './materials.js';
import { MAX_VOXEL_SIZE, breakSizesFor, isValidVoxelSize, type VoxelSize } from './units.js';

/**
 * A cubic voxel. `x`, `y`, `z` are the integer unit coordinates of its minimum
 * corner; it occupies [x, x+size) on each axis. Y is up.
 *
 * Rule: a voxel never crosses a 1 m gridline, i.e. it lies entirely inside one
 * 1 m block. See voxelFitsInBlock().
 */
export interface Voxel {
  x: number;
  y: number;
  z: number;
  size: VoxelSize;
  material: MaterialId;
}

/** Position of `v` within its 1 m block, in [0, 16), also for negative coordinates. */
function offsetInBlock(v: number): number {
  return ((v % MAX_VOXEL_SIZE) + MAX_VOXEL_SIZE) % MAX_VOXEL_SIZE;
}

/** Whether a voxel with this corner and size stays inside a single 1 m block on every axis. */
export function voxelFitsInBlock(x: number, y: number, z: number, size: VoxelSize): boolean {
  return [x, y, z].every((c) => Number.isInteger(c) && offsetInBlock(c) + size <= MAX_VOXEL_SIZE);
}

/** Throws a RangeError if `voxel` has an invalid size or crosses a 1 m gridline. */
export function validateVoxel(voxel: Voxel): void {
  if (!isValidVoxelSize(voxel.size)) {
    throw new RangeError(`invalid voxel size: ${voxel.size}`);
  }
  if (!voxelFitsInBlock(voxel.x, voxel.y, voxel.z, voxel.size)) {
    throw new RangeError(
      `size-${voxel.size} voxel at ${voxel.x},${voxel.y},${voxel.z} crosses a 1 m gridline`,
    );
  }
}

/**
 * Splits `voxel` into (voxel.size / pieceSize)^3 voxels of `pieceSize` that
 * exactly tile the original. Throws if `voxel` is invalid or `pieceSize` does
 * not evenly divide it. The pieces lie inside the parent, so they also fit the
 * parent's block.
 */
export function breakVoxel(voxel: Voxel, pieceSize: VoxelSize): Voxel[] {
  validateVoxel(voxel);
  if (!breakSizesFor(voxel.size).includes(pieceSize)) {
    throw new RangeError(`a size-${voxel.size} voxel cannot be broken into size-${pieceSize} pieces`);
  }
  const n = voxel.size / pieceSize;
  const pieces: Voxel[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        pieces.push({
          x: voxel.x + i * pieceSize,
          y: voxel.y + j * pieceSize,
          z: voxel.z + k * pieceSize,
          size: pieceSize,
          material: voxel.material,
        });
      }
    }
  }
  return pieces;
}
