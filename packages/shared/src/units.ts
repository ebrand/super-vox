/**
 * All world geometry is expressed in integer "units". One unit is 1/16 m, the
 * smallest voxel edge. Using integers keeps server-side math exact; only the
 * renderer converts to floating-point meters.
 */
export const UNITS_PER_METER = 16;

/** Smallest voxel edge, in units (0.0625 m). */
export const MIN_VOXEL_SIZE = 1;

/** Largest voxel edge, in units (1 m). */
export const MAX_VOXEL_SIZE = 16;

/** Voxel edge length in units: an integer in [1, 16]. */
export type VoxelSize = number;

export function isValidVoxelSize(size: number): size is VoxelSize {
  return Number.isInteger(size) && size >= MIN_VOXEL_SIZE && size <= MAX_VOXEL_SIZE;
}

export function unitsToMeters(units: number): number {
  return units / UNITS_PER_METER;
}

/** Converts meters to units, rejecting values that are not on the 1/16 m lattice. */
export function metersToUnits(meters: number): number {
  const units = meters * UNITS_PER_METER;
  if (!Number.isInteger(units)) {
    throw new RangeError(`${meters} m is not a multiple of 1/${UNITS_PER_METER} m`);
  }
  return units;
}

/**
 * Sizes a voxel of `size` can be broken into: the proper divisors of `size`,
 * ascending. A voxel may only be split into pieces that tile it exactly.
 */
export function breakSizesFor(size: VoxelSize): VoxelSize[] {
  if (!isValidVoxelSize(size)) {
    throw new RangeError(`invalid voxel size: ${size}`);
  }
  const sizes: VoxelSize[] = [];
  for (let d = MIN_VOXEL_SIZE; d < size; d++) {
    if (size % d === 0) sizes.push(d);
  }
  return sizes;
}
