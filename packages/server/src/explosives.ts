import { CHAIN_FUSE_MS, DEBRIS_FPS, DEBRIS_LIFT, FUSE_MS, blastRadius, isExplosive, isWater, openDirection, packDebris, throwDebris, tntEquivalent, type DebrisPiece, type MaterialId } from '@super-vox/shared';
import type { EditResult, World } from './world.js';

/** An explosive voxel (TNT, C4) to light: its corner and size (units). */
export interface Tnt {
  x: number;
  y: number;
  z: number;
  size: number;
}

/**
 * An explosion that happened: where (its centre, units), how big, what it changed, the TNT it lit
 * (with their fuses, ms), and a seed for the dust clients make of it themselves (see ExplosionView).
 */
export interface Blast {
  x: number;
  y: number;
  z: number;
  radius: number;
  seed: number;
  /** Which way it goes (a unit vector: toward the open air; see openDirection). */
  open: [number, number, number];
  result: EditResult | null;
  lit: { tnt: Tnt; ms: number }[];
}

/** Debris pieces' size (units): 1/4 m. */
export const PIECE = 4;
/** Most pieces a blast throws that everyone sees the same (and that stay, in creative); clients add their own dust. */
export const MAX_PIECES = 1000;
/** Longest a tick spends blowing things up (ms), after its first blast: more wait for the next. */
const TICK_BUDGET_MS = 100;
/** Longest a tick spends working out debris's flights (ms): the rest are thrown on later ticks. */
const DEBRIS_BUDGET_MS = 25;
/** Most pieces waiting to be thrown: a big chain's beyond that go without. */
export const MAX_WAITING_PIECES = 3000;

/**
 * A world's lit TNT: each blows when its fuse runs out (see World.explode), lighting TNT its blast
 * catches on a short fuse, and throwing debris: pieces of what it blew apart (see throwDebris),
 * which (where `keepDebris`: creative) stay where they come to rest, as voxels. A few explosions a
 * tick at most, so a huge stack goes off as a ripple rather than stopping the server; TNT taken
 * away before it blows doesn't.
 */
export class Explosives {
  private readonly lit = new Map<string, { tnt: Tnt; at: number }>();
  /** Debris on its way to rest, to be placed then (creative). */
  private readonly landing: { at: number; x: number; y: number; z: number; material: MaterialId }[] = [];
  /** Pieces blown out, still to be thrown: each from its cell, away from its blast's centre (units). */
  private readonly throwing: { x: number; y: number; z: number; material: MaterialId; from: [number, number, number]; open: [number, number, number]; radius: number; at: number }[] = [];

  constructor(
    private readonly world: World,
    private readonly opts: { perTick?: number; random?: () => number; keepDebris?: () => boolean; debrisBudgetMs?: number } = {},
  ) {}

  /** TNT burning, and debris yet to be thrown or still flying to where it'll stay. */
  get count(): number {
    return this.lit.size + this.throwing.length + this.landing.length;
  }

  /** Lights TNT, if it isn't already: its fuse (ms), or null. */
  light(tnt: Tnt, now: number, fuse = FUSE_MS): number | null {
    const key = `${tnt.x},${tnt.y},${tnt.z}`;
    if (this.lit.has(key)) return null;
    this.lit.set(key, { tnt, at: now + fuse });
    return fuse;
  }

  /**
   * Blows the TNT whose fuses have run out (the soonest first, `perTick` at most), throws what
   * debris there's time for (`debris`: each piece's flight, for clients to show), and settles
   * debris that's come to rest (`landed`: what that changed).
   */
  tick(now: number): { blasts: Blast[]; debris: DebrisPiece[]; landed: EditResult[] } {
    const random = this.opts.random ?? Math.random;
    const due = [...this.lit.entries()].filter(([, l]) => l.at <= now).sort((a, b) => a[1].at - b[1].at).slice(0, this.opts.perTick ?? 6);
    const blasts: Blast[] = [];
    const started = performance.now();
    for (const [key, { tnt }] of due) {
      // (A big blast takes a while: the rest wait for the next tick.)
      if (blasts.length && performance.now() - started > TICK_BUDGET_MS) break;
      if (!this.lit.has(key)) continue; // (gone off with one it touched)
      this.lit.delete(key);
      // Still there? (Dug out or blown apart meanwhile: it doesn't go off.)
      const here = this.world.explosiveAt(tnt.x, tnt.y, tnt.z);
      if (!here || here.x !== tnt.x || here.y !== tnt.y || here.z !== tnt.z || here.size !== tnt.size) continue;
      // Everything touching it goes off with it, as one: from their middle, as big as the TNT they equal makes it.
      const cluster = this.world.explosiveCluster(here);
      let volume = 0, cx = 0, cy = 0, cz = 0;
      for (const t of cluster) {
        const v = tntEquivalent(t.material, t.size ** 3), h = t.size / 2;
        volume += v;
        cx += (t.x + h) * v;
        cy += (t.y + h) * v;
        cz += (t.z + h) * v;
        this.lit.delete(`${t.x},${t.y},${t.z}`);
      }
      const x = cx / volume, y = cy / volume, z = cz / volume, radius = blastRadius(volume);
      // Which way it'll go: toward the open air around (up from the ground, out of a wall).
      const open = openDirection(this.world.solidAt, x, y, z, radius);
      const { result, tnt: caught, removed } = this.world.explode(x, y, z, radius, new Set(cluster.map((t) => `${t.x},${t.y},${t.z}`)));
      // Lit by it: TNT it caught, and any of the cluster out of its reach.
      const lit: Blast['lit'] = [];
      const left = cluster.filter((t) => this.world.explosiveAt(t.x, t.y, t.z));
      for (const t of [...caught, ...left]) {
        const ms = this.light(t, now, CHAIN_FUSE_MS[0] + random() * (CHAIN_FUSE_MS[1] - CHAIN_FUSE_MS[0]));
        if (ms !== null) lit.push({ tnt: t, ms });
      }
      // Debris: pieces of what it blew out, to be thrown up and away from the centre.
      const want = Math.min(MAX_WAITING_PIECES - this.throwing.length, MAX_PIECES);
      for (const cell of pickPieces(removed, want, random)) this.throwing.push({ ...cell, from: [x, y, z], open, radius, at: now });
      blasts.push({ x, y, z, radius, seed: Math.floor(random() * 2 ** 31), open, result, lit });
    }
    return { blasts, debris: this.throw(now, random), landed: this.settle(now) };
  }

  /**
   * Works out the flights of waiting debris (as many as there's time for; at least one), each from
   * its blast: those worked out later are sent part way through (`a`, ms flown already).
   */
  private throw(now: number, random: () => number): DebrisPiece[] {
    const out: DebrisPiece[] = [];
    const started = performance.now(), budget = this.opts.debrisBudgetMs ?? DEBRIS_BUDGET_MS;
    while (this.throwing.length && (!out.length || performance.now() - started < budget)) {
      const { x, y, z, material, from, open, radius, at } = this.throwing.shift()!;
      const c = [x + PIECE / 2 - from[0], y + PIECE / 2 - from[1], z + PIECE / 2 - from[2]];
      const len = Math.hypot(c[0]!, c[1]!, c[2]!) || 1;
      const dir = [c[0]! / len + DEBRIS_LIFT * open[0], c[1]! / len + DEBRIS_LIFT * open[1], c[2]! / len + DEBRIS_LIFT * open[2]];
      const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
      const speed = (5 + 7 * random()) * Math.sqrt(Math.min(2, radius / 64));
      const flight = throwDebris([x, y, z], PIECE, [(dir[0]! / dl) * speed, (dir[1]! / dl) * speed, (dir[2]! / dl) * speed], this.world.solidAt);
      out.push({ ...packDebris(material, PIECE, flight), ...(now > at ? { a: now - at } : {}) });
      if (flight.rested && this.opts.keepDebris?.()) {
        const end = flight.path.at(-1)!;
        this.landing.push({ at: at + ((flight.path.length - 1) / DEBRIS_FPS) * 1000, x: end[0], y: end[1], z: end[2], material });
      }
    }
    return out;
  }

  /** Places debris that's come to rest by now, all at once (on the PIECE grid where it lies; a step up if that's taken; else not). */
  private settle(now: number): EditResult[] {
    const due: { x: number; y: number; z: number; size: number; material: MaterialId }[] = [];
    for (let i = this.landing.length - 1; i >= 0; i--) {
      const l = this.landing[i]!;
      if (l.at > now) continue;
      this.landing.splice(i, 1);
      due.push({ x: Math.round(l.x / PIECE) * PIECE, y: Math.round(l.y / PIECE) * PIECE, z: Math.round(l.z / PIECE) * PIECE, size: PIECE, material: l.material });
    }
    const result = due.length ? this.world.placeMany(due) : null;
    return result ? [result] : [];
  }
}

/**
 * Up to `want` pieces (PIECE-sized cells on the grid) from what a blast took out, chosen at random
 * by volume (without listing every cell: a big blast takes out hundreds of thousands), never explosives or water.
 */
export function pickPieces(removed: readonly { x: number; y: number; z: number; size: number; material: MaterialId }[], want: number, random: () => number): { x: number; y: number; z: number; material: MaterialId }[] {
  const solid = removed.filter((v) => !isWater(v.material) && !isExplosive(v.material));
  const cellsOf = (size: number) => (size <= PIECE ? 1 : (size / PIECE) ** 3);
  const count = solid.reduce((n, v) => n + cellsOf(v.size), 0);
  const cell = (v: (typeof solid)[number], k: number) => {
    // Cell k of voxel v (a voxel smaller than a cell: the cell it's in).
    if (v.size <= PIECE) return { x: Math.floor(v.x / PIECE) * PIECE, y: Math.floor(v.y / PIECE) * PIECE, z: Math.floor(v.z / PIECE) * PIECE, material: v.material };
    const n = v.size / PIECE;
    return { x: v.x + (k % n) * PIECE, y: v.y + Math.floor(k / (n * n)) * PIECE, z: v.z + (Math.floor(k / n) % n) * PIECE, material: v.material };
  };
  const picked = new Map<string, { x: number; y: number; z: number; material: MaterialId }>();
  const add = (c: { x: number; y: number; z: number; material: MaterialId }) => {
    const key = `${c.x},${c.y},${c.z}`;
    if (!picked.has(key)) picked.set(key, c);
  };
  if (count <= want * 2) {
    // Few: all of them, then a random few of those (Fisher-Yates, as far as needed).
    for (const v of solid) for (let k = 0; k < cellsOf(v.size); k++) add(cell(v, k));
    const all = [...picked.values()];
    for (let i = 0; i < Math.min(want, all.length); i++) {
      const j = i + Math.floor(random() * (all.length - i));
      [all[i], all[j]] = [all[j]!, all[i]!];
    }
    return all.slice(0, want);
  }
  // Many: cells at random, each voxel as likely as its share of the volume (a few tries at most).
  const cumulative = new Float64Array(solid.length);
  let total = 0;
  solid.forEach((v, i) => (cumulative[i] = total += cellsOf(v.size)));
  for (let tries = 0; picked.size < want && tries < want * 6; tries++) {
    const r = random() * total;
    let lo = 0, hi = solid.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! > r) hi = mid;
      else lo = mid + 1;
    }
    const v = solid[lo]!;
    add(cell(v, Math.floor(random() * cellsOf(v.size))));
  }
  return [...picked.values()];
}
