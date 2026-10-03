/**
 * Explosives: TNT (Material.TNT) is lit with a click and, after FUSE_MS, blows out a crater around
 * itself: a sphere of blastRadius (by its size: a 1 m block, 4 m) carved down to small pieces at
 * its edge. TNT caught in a blast is lit too, on a short fuse, so stacks go off in a ripple; and
 * what's nearby is hurt (blastDamage).
 */

import { Material, type MaterialId } from './materials.js';

/**
 * Explosives, and how strong each is for its volume (blastRadius's scale: power 1 is a 4 m blast
 * from 1 m^3; the radius goes with the square root): TNT 4 (a 1 m block, 8 m); C4 327.68 (a 1/8 m
 * voxel, 3.2 m). A blast's size is from the power it all adds up to (tntEquivalent).
 */
export const EXPLOSIVE_POWER: Readonly<Partial<Record<MaterialId, number>>> = { [Material.TNT]: 4, [Material.C4]: 327.68 };

export function isExplosive(m: MaterialId): boolean {
  return EXPLOSIVE_POWER[m] !== undefined;
}

/** How much power-1 explosive (units cubed; see blastRadius) `volume` (units cubed) of explosive `m` equals (0 for what isn't one). */
export function tntEquivalent(m: MaterialId, volume: number): number {
  return (EXPLOSIVE_POWER[m] ?? 0) * volume;
}

/** How long a lit TNT burns before it blows (ms). */
export const FUSE_MS = 4000;
/** The fuse of TNT lit by another's blast (ms): somewhere in this range, so stacks ripple. */
export const CHAIN_FUSE_MS: readonly [number, number] = [250, 750];

/** The biggest blast's radius (units): 16 m. (Carving more stops the server for too long.) */
export const MAX_BLAST_RADIUS = 16 * 16;

/**
 * The radius (units) of a blast of `volume` (units cubed) of power-1 explosive (see
 * tntEquivalent): 4 m for 1 m^3. Touching explosives go off as one, and the radius grows with the
 * square root of what they add up to — far faster than a real blast's cube root: TNT blocks (power
 * 4) blow 8 m one, 11.3 m two, 16 m (the most) four or more.
 */
export function blastRadius(volume: number): number {
  return Math.min(MAX_BLAST_RADIUS, 64 * Math.sqrt(volume / 16 ** 3));
}

/** Health lost `distance` (units) from a blast of `radius`: up to BLAST_DAMAGE at the centre, none beyond 1.6 radii. */
export function blastDamage(distance: number, radius: number): number {
  const reach = 1.6 * radius;
  if (distance >= reach) return 0;
  return Math.ceil(BLAST_DAMAGE * (1 - distance / reach) * Math.min(1, radius / 64));
}

/** Health a 1 m TNT takes from someone right at it (players have 20). */
export const BLAST_DAMAGE = 16;

/**
 * How much more toward the open air than out a blast throws its debris (DEBRIS_LIFT times its
 * way out, added to the way out from its middle, before scaling to its speed): see openDirection.
 */
export const DEBRIS_LIFT = 2.5;

/** Directions (unit vectors) spread evenly over the sphere (a Fibonacci spiral), for openDirection. */
const DIRECTIONS: readonly (readonly [number, number, number])[] = (() => {
  const n = 64, golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * golden;
    return [Math.cos(a) * r, y, Math.sin(a) * r] as const;
  });
})();

/**
 * Which way a blast at (x, y, z) of `radius` (units) has to go: toward the open air around it
 * (`solidAt`, units: as before the blast). Out from just past the crater's edge in every direction,
 * how much of the way is air; the directions summed by that. On open ground, up; in a wall, out of
 * it; down a hole, up it. Buried all round (nowhere open), up. A unit vector.
 */
export function openDirection(solidAt: (x: number, y: number, z: number) => boolean | undefined, x: number, y: number, z: number, radius: number): [number, number, number] {
  let ox = 0, oy = 0, oz = 0;
  const steps = 6;
  for (const [dx, dy, dz] of DIRECTIONS) {
    let air = 0;
    for (let k = 0; k < steps; k++) {
      const d = radius * (1.1 + (0.8 * k) / (steps - 1)); // 1.1 to 1.9 radii out
      if (!solidAt(x + dx * d, y + dy * d, z + dz * d)) air++;
    }
    ox += (dx * air) / steps;
    oy += (dy * air) / steps;
    oz += (dz * air) / steps;
  }
  const len = Math.hypot(ox, oy, oz);
  // (Open all round, or nowhere, or evenly: no way's better than up.)
  if (len < 1) return [0, 1, 0];
  return [ox / len, oy / len, oz / len];
}
