/** Claims opened at a site from the site finder (see sites.ts): #site=x,z&rank=n in the URL's hash. */

/** The side (m) of the plot marked out around a site: room for a keep, a bailey and a wall. */
export const SITE_PLOT = 256;

/** The site asked for in a hash's parameters (metres), or null. */
export function siteOf(hash: URLSearchParams): { x: number; z: number; rank: number | null } | null {
  const raw = hash.get('site');
  if (raw === null) return null;
  const parts = raw.split(',');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) return null;
  const [x, z] = parts.map(Number) as [number, number];
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const rank = Number(hash.get('rank'));
  return { x, z, rank: Number.isInteger(rank) && rank > 0 ? rank : null };
}

/** A plot SITE_PLOT square (whole meters) centered on (x, z), moved inside a world `width` x `depth` meters. */
export function plotAround(at: { x: number; z: number }, width: number, depth: number): { x0: number; z0: number; x1: number; z1: number } {
  const side = Math.min(SITE_PLOT, Math.floor(width), Math.floor(depth));
  const corner = (v: number, size: number) => Math.max(0, Math.min(Math.floor(size) - side, Math.round(v - side / 2)));
  const x0 = corner(at.x, width), z0 = corner(at.z, depth);
  return { x0, z0, x1: x0 + side, z1: z0 + side };
}
