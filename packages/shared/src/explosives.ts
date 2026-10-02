/**
 * Explosives: TNT (Material.TNT) is lit with a click and, after FUSE_MS, blows out a crater around
 * itself: a sphere of blastRadius (by its size: a 1 m block, 4 m) carved down to small pieces at
 * its edge. TNT caught in a blast is lit too, on a short fuse, so stacks go off in a ripple; and
 * what's nearby is hurt (blastDamage).
 */

/** How long a lit TNT burns before it blows (ms). */
export const FUSE_MS = 4000;
/** The fuse of TNT lit by another's blast (ms): somewhere in this range, so stacks ripple. */
export const CHAIN_FUSE_MS: readonly [number, number] = [250, 750];

/** The radius (units) of the crater a TNT voxel of `size` (units) blows: 4 m for a 1 m block. */
export function blastRadius(size: number): number {
  return 4 * size;
}

/** Health lost `distance` (units) from a blast of `radius`: up to BLAST_DAMAGE at the centre, none beyond 1.6 radii. */
export function blastDamage(distance: number, radius: number): number {
  const reach = 1.6 * radius;
  if (distance >= reach) return 0;
  return Math.ceil(BLAST_DAMAGE * (1 - distance / reach) * Math.min(1, radius / 64));
}

/** Health a 1 m TNT takes from someone right at it (players have 20). */
export const BLAST_DAMAGE = 16;
