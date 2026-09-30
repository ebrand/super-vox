import { breakSizesFor, isValidVoxelSize, type VoxelSize } from './units.js';

/** Material identifier. 0 is reserved for air/empty. */
export type MaterialId = number;

/**
 * A cubic voxel. `x`, `y`, `z` are the integer unit coordinates of its minimum
 * corner; it occupies [x, x+size) on each axis. Y is up.
 */
export interface Voxel {
  x: number;
  y: number;
  z: number;
  size: VoxelSize;
  material: MaterialId;
}

/**
 * Splits `voxel` into (voxel.size / pieceSize)^3 voxels of `pieceSize` that
 * exactly tile the original. Throws if `pieceSize` does not evenly divide it.
 */
export function breakVoxel(voxel: Voxel, pieceSize: VoxelSize): Voxel[] {
  if (!isValidVoxelSize(voxel.size)) {
    throw new RangeError(`invalid voxel size: ${voxel.size}`);
  }
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
