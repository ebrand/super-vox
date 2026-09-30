
/** Solidity of a world unit cell: true/false, or undefined if its chunk isn't loaded. */
export type SolidAt = (x: number, y: number, z: number) => boolean | undefined;

export interface RayHit {
  /** The solid unit cell hit (world units). */
  cell: [number, number, number];
  /** Outward normal of the face the ray entered through (one axis is +-1). */
  normal: [number, number, number];
  /** Point where the ray meets that face (world units). */
  point: [number, number, number];
  distance: number;
}

/**
 * Walks a ray through the unit grid (Amanatides-Woo) from `origin` along
 * `dir` (world units) and returns the first solid cell within `maxDistance`.
 * Stops without a hit at unloaded chunks. Starting inside a solid cell is not
 * a hit.
 */
export function raycastVoxels(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxDistance: number,
  solidAt: SolidAt,
): RayHit | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len === 0) return null;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  const cell = [Math.floor(origin[0]), Math.floor(origin[1]), Math.floor(origin[2])];
  const step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    if (d[a]! > 0) {
      step[a] = 1;
      tMax[a] = (cell[a]! + 1 - origin[a]!) / d[a]!;
      tDelta[a] = 1 / d[a]!;
    } else if (d[a]! < 0) {
      step[a] = -1;
      tMax[a] = (origin[a]! - cell[a]!) / -d[a]!;
      tDelta[a] = 1 / -d[a]!;
    }
  }
  let t = 0;
  while (t <= maxDistance) {
    const axis = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
    t = tMax[axis]!;
    if (t > maxDistance) return null;
    cell[axis]! += step[axis]!;
    tMax[axis]! += tDelta[axis]!;
    const solid = solidAt(cell[0]!, cell[1]!, cell[2]!);
    if (solid === undefined) return null;
    if (solid) {
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = -step[axis]!;
      return {
        cell: [cell[0]!, cell[1]!, cell[2]!],
        normal,
        point: [origin[0] + d[0]! * t, origin[1] + d[1]! * t, origin[2] + d[2]! * t],
        distance: t,
      };
    }
  }
  return null;
}

/** Axis-aligned voxel in world units. */
export interface Box {
  x: number;
  y: number;
  z: number;
  size: number;
}

/**
 * The cube's position on the face's plane: aligned snaps to multiples of the
 * size (which never crosses a 1 m gridline for the standard sizes), fine
 * centres it on the hit point in 1/16 m steps (and may cross gridlines).
 */
function facePosition(point: number, size: number, fine: boolean): number {
  return fine ? Math.floor(point - size / 2 + 0.5) : Math.floor(point / size) * size;
}

/**
 * Where a new voxel of `size` goes when placed on the face of `target` that
 * `hit` points at: flush against that face, and on the face's plane per
 * facePosition. It may cross 1 m gridlines (servers split it into pieces);
 * occupancy is checked separately.
 */
export function placementBox(hit: RayHit, target: Box, size: number, fine = false): Box {
  const axis = hit.normal[0] !== 0 ? 0 : hit.normal[1] !== 0 ? 1 : 2;
  const targetMin = [target.x, target.y, target.z];
  const corner = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (a === axis) corner[a] = hit.normal[a]! > 0 ? targetMin[a]! + target.size : targetMin[a]! - size;
    // Keep the hit point inside the target so aligned snapping uses the right cell at its edge.
    else corner[a] = facePosition(Math.min(hit.point[a]!, targetMin[a]! + target.size - 1e-6), size, fine);
  }
  const [x, y, z] = corner as [number, number, number];
  return { x, y, z, size };
}

/**
 * The dig box: a cube of `size` just behind the face `hit` points at (inside
 * the solid), positioned on the face's plane like placementBox. It is a
 * region, not a voxel, so it may cross 1 m gridlines in any direction.
 */
export function digBox(hit: RayHit, target: Box, size: number, fine = false): Box {
  const outside = placementBox(hit, target, size, fine);
  const axis = hit.normal[0] !== 0 ? 0 : hit.normal[1] !== 0 ? 1 : 2;
  const corner = [outside.x, outside.y, outside.z];
  // Mirror across the face: the face plane is where the placed voxel would start (+) or end (-).
  corner[axis] = hit.normal[axis]! > 0 ? corner[axis]! - size : corner[axis]! + size;
  const [x, y, z] = corner as [number, number, number];
  return { x, y, z, size };
}
