/**
 * Light at a spot, as the client draws it (see its skyLight): sky light 15 in a block open to the
 * sky, block light from blocks that give it (torches: LIGHT_LEVEL), each one less per block away
 * through blocks that let light through. Worked out by spreading from the spot itself, as far as
 * light could reach it (15 blocks), so it's cheap where something's near and exact everywhere.
 */
export const SKY_LIGHT_LEVEL = 15;

/** The world as light sees it, in 1 m blocks. */
export interface LightWorld {
  /** Whether block (bx, by, bz) stops light (whole blocks of anything but water and leaves; not known: it does). */
  opaque(bx: number, by: number, bz: number): boolean;
  /** The light block (bx, by, bz) gives (0: none). */
  glow(bx: number, by: number, bz: number): number;
  /** Whether nothing above block (bx, by, bz) stops light. */
  skyOpen(bx: number, by: number, bz: number): boolean;
}

/** Most blocks a probe looks at (open ground at night, with a torch near: a few thousand). */
const MAX_VISITS = 20_000;

/**
 * The sky and block light (0..15) in block (bx, by, bz). `sky` / `block` false: that one isn't
 * wanted (left 0, and not looked for). `reach`: look only that many blocks out (light from
 * further off, which would be under 15 - reach, counts as none).
 */
export function lightAt(w: LightWorld, bx: number, by: number, bz: number, want: { sky?: boolean; block?: boolean; reach?: number } = { sky: true, block: true }): { sky: number; block: number } {
  let sky = 0, block = 0;
  if (w.opaque(bx, by, bz)) return { sky, block };
  const seen = new Set<string>([`${bx},${by},${bz}`]);
  let ring: [number, number, number][] = [[bx, by, bz]];
  for (let d = 0; ring.length && d < Math.min(SKY_LIGHT_LEVEL, want.reach ?? SKY_LIGHT_LEVEL); d++) {
    for (const [x, y, z] of ring) {
      if (want.sky && sky < SKY_LIGHT_LEVEL - d && w.skyOpen(x, y, z)) sky = SKY_LIGHT_LEVEL - d;
      if (want.block) block = Math.max(block, w.glow(x, y, z) - d);
    }
    // Anything further off gives less than what's found already: done.
    const skyMore = want.sky && SKY_LIGHT_LEVEL - (d + 1) > sky, blockMore = want.block && SKY_LIGHT_LEVEL - (d + 1) > block;
    if (!skyMore && !blockMore) break;
    const next: [number, number, number][] = [];
    for (const [x, y, z] of ring)
      for (const [dx, dy, dz] of STEPS) {
        const n: [number, number, number] = [x + dx, y + dy, z + dz], k = `${n[0]},${n[1]},${n[2]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (seen.size > MAX_VISITS) return { sky, block };
        if (!w.opaque(n[0], n[1], n[2])) next.push(n);
      }
    ring = next;
  }
  return { sky, block: Math.max(0, block) };
}

const STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
