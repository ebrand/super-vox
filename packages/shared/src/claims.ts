/**
 * Claims: plots of land players take for their own (to plan a keep, a house, an estate on, and
 * build it). A rectangle of whole metres, at most MAX_CLAIM_SIDE a side, not overlapping
 * another. For now a claim only marks the land (nothing stops others building there).
 */
export interface Claim {
  id: string;
  /** What its owner calls it. */
  name: string;
  /** Who claimed it: their account id (null on a server without sign-in), and their name. */
  owner: string | null;
  ownerName: string;
  /** Its corners, metres: [x0, x1) x [z0, z1), within the world (it doesn't cross a round world's seam). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** When it was claimed (ms). */
  at: number;
}

/** Sides of a claim: 16 m (a chunk) to 4 km. */
export const MIN_CLAIM_SIDE = 16;
export const MAX_CLAIM_SIDE = 4096;
/** Most claims one player may hold in a world. */
export const MAX_CLAIMS_EACH = 8;
export const MAX_CLAIM_NAME = 40;

/** Why `r` (metres) can't be a claim in a world `width` x `depth` metres; null if it can. */
export function refuseClaimRect(r: { x0: number; z0: number; x1: number; z1: number }, width: number, depth: number): string | null {
  const { x0, z0, x1, z1 } = r;
  if (![x0, z0, x1, z1].every(Number.isInteger)) return 'its corners must be whole metres';
  if (x0 < 0 || z0 < 0 || x1 > width || z1 > depth) return 'it must lie within the world';
  const w = x1 - x0, d = z1 - z0;
  if (w < MIN_CLAIM_SIDE || d < MIN_CLAIM_SIDE) return `its sides must be at least ${MIN_CLAIM_SIDE} m`;
  if (w > MAX_CLAIM_SIDE || d > MAX_CLAIM_SIDE) return `its sides can be at most ${MAX_CLAIM_SIDE / 1000} km`;
  return null;
}

/** Whether two claims' land overlaps (touching edges don't). */
export function claimsOverlap(a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
}

/** Whether a value read back (from disk) is a claim. */
export function isClaim(v: unknown): v is Claim {
  const c = v as Claim;
  return (
    typeof c === 'object' && c !== null && typeof c.id === 'string' && typeof c.name === 'string' && (c.owner === null || typeof c.owner === 'string') &&
    typeof c.ownerName === 'string' && [c.x0, c.z0, c.x1, c.z1, c.at].every(Number.isFinite)
  );
}
