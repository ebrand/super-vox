import { CHAIN_FUSE_MS, FUSE_MS, blastRadius } from '@super-vox/shared';
import type { EditResult, World } from './world.js';

/** A TNT voxel: its corner and size (units). */
export interface Tnt {
  x: number;
  y: number;
  z: number;
  size: number;
}

/** An explosion that happened: where (its centre, units), how big, what it changed, and the TNT it lit (with their fuses, ms). */
export interface Blast {
  x: number;
  y: number;
  z: number;
  radius: number;
  result: EditResult | null;
  lit: { tnt: Tnt; ms: number }[];
}

/**
 * A world's lit TNT: each blows when its fuse runs out (see World.explode), lighting TNT its blast
 * catches on a short fuse. A few explosions a tick at most, so a huge stack goes off as a ripple
 * rather than stopping the server; TNT taken away before it blows doesn't.
 */
export class Explosives {
  private readonly lit = new Map<string, { tnt: Tnt; at: number }>();

  constructor(
    private readonly world: World,
    private readonly perTick = 6,
    private readonly random: () => number = Math.random,
  ) {}

  get count(): number {
    return this.lit.size;
  }

  /** Lights TNT, if it isn't already: its fuse (ms), or null. */
  light(tnt: Tnt, now: number, fuse = FUSE_MS): number | null {
    const key = `${tnt.x},${tnt.y},${tnt.z}`;
    if (this.lit.has(key)) return null;
    this.lit.set(key, { tnt, at: now + fuse });
    return fuse;
  }

  /** Blows the TNT whose fuses have run out (the soonest first, `perTick` at most). */
  tick(now: number): Blast[] {
    const due = [...this.lit.entries()].filter(([, l]) => l.at <= now).sort((a, b) => a[1].at - b[1].at).slice(0, this.perTick);
    const out: Blast[] = [];
    for (const [key, { tnt }] of due) {
      this.lit.delete(key);
      // Still there? (Dug out or blown apart meanwhile: it doesn't go off.)
      const here = this.world.tntAt(tnt.x, tnt.y, tnt.z);
      if (!here || here.x !== tnt.x || here.y !== tnt.y || here.z !== tnt.z || here.size !== tnt.size) continue;
      const radius = blastRadius(tnt.size), h = tnt.size / 2;
      const x = tnt.x + h, y = tnt.y + h, z = tnt.z + h;
      const { result, tnt: caught } = this.world.explode(x, y, z, radius, tnt);
      const lit: Blast['lit'] = [];
      for (const t of caught) {
        const ms = this.light(t, now, CHAIN_FUSE_MS[0] + this.random() * (CHAIN_FUSE_MS[1] - CHAIN_FUSE_MS[0]));
        if (ms !== null) lit.push({ tnt: t, ms });
      }
      out.push({ x, y, z, radius, result, lit });
    }
    return out;
  }
}
