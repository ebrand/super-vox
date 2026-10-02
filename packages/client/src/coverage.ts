/** A rectangle on the ground (world units): [x0, x1) x [z0, z1). */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function overlaps(a: Footprint, b: Footprint): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
}

/**
 * Replaced meshes (stale: no longer selected, still drawn so nothing goes missing) to drop now:
 * those whose ground `covered` says is drawn by what replaced them, and any kept past `maxAgeMs`
 * (a backstop, so they can't pile up). Oldest first; `stale` and `since` are in that order.
 */
export function staleToRetire(
  stale: Iterable<string>,
  since: (key: string) => number,
  footprint: (key: string) => Footprint,
  covered: (f: Footprint) => boolean,
  maxAgeMs: number,
  now: number,
): string[] {
  const out: string[] = [];
  for (const key of stale) if (now - since(key) >= maxAgeMs || covered(footprint(key))) out.push(key);
  return out;
}
