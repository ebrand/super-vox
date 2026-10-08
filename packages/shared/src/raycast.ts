import type { SolidAt } from './physics.js';

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
