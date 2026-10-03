import { CHAIN_FUSE_MS, DEBRIS_FPS, EditError, FUSE_MS, Material, blastRadius, isWater, packDebris, throwDebris, type DebrisPiece, type MaterialId } from '@super-vox/shared';
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

/** Debris pieces' size (units): 1/2 m. */
export const PIECE = 8;
/** Most pieces from a 1 m TNT's blast (fewer for smaller ones). */
export const MAX_PIECES = 60;
/** Longest a tick spends blowing things up (ms), after its first blast: more wait for the next. */
const TICK_BUDGET_MS = 100;
/** Longest a tick spends working out debris's flights (ms): the rest are thrown on later ticks. */
const DEBRIS_BUDGET_MS = 25;
/** Most pieces waiting to be thrown: a big chain's beyond that go without. */
export const MAX_WAITING_PIECES = 600;

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
  private readonly throwing: { x: number; y: number; z: number; material: MaterialId; from: [number, number, number]; radius: number }[] = [];

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
      const here = this.world.tntAt(tnt.x, tnt.y, tnt.z);
      if (!here || here.x !== tnt.x || here.y !== tnt.y || here.z !== tnt.z || here.size !== tnt.size) continue;
      // Everything touching it goes off with it, as one: from their middle, as big as their volume makes it.
      const cluster = this.world.tntCluster(tnt);
      let volume = 0, cx = 0, cy = 0, cz = 0;
      for (const t of cluster) {
        const v = t.size ** 3, h = t.size / 2;
        volume += v;
        cx += (t.x + h) * v;
        cy += (t.y + h) * v;
        cz += (t.z + h) * v;
        this.lit.delete(`${t.x},${t.y},${t.z}`);
      }
      const x = cx / volume, y = cy / volume, z = cz / volume, radius = blastRadius(volume);
      const { result, tnt: caught, removed } = this.world.explode(x, y, z, radius, new Set(cluster.map((t) => `${t.x},${t.y},${t.z}`)));
      // Lit by it: TNT it caught, and any of the cluster out of its reach.
      const lit: Blast['lit'] = [];
      const left = cluster.filter((t) => this.world.tntAt(t.x, t.y, t.z));
      for (const t of [...caught, ...left]) {
        const ms = this.light(t, now, CHAIN_FUSE_MS[0] + random() * (CHAIN_FUSE_MS[1] - CHAIN_FUSE_MS[0]));
        if (ms !== null) lit.push({ tnt: t, ms });
      }
      // Debris: pieces of what it blew out, to be thrown up and away from the centre.
      const want = Math.min(MAX_WAITING_PIECES - this.throwing.length, Math.max(4, Math.round(MAX_PIECES * Math.min(2.5, radius / 64))));
      for (const cell of pickPieces(removed, want, random)) this.throwing.push({ ...cell, from: [x, y, z], radius });
      blasts.push({ x, y, z, radius, result, lit });
    }
    return { blasts, debris: this.throw(now, random), landed: this.settle(now) };
  }

  /** Works out the flights of waiting debris (as many as there's time for; at least one), from now. */
  private throw(now: number, random: () => number): DebrisPiece[] {
    const out: DebrisPiece[] = [];
    const started = performance.now(), budget = this.opts.debrisBudgetMs ?? DEBRIS_BUDGET_MS;
    while (this.throwing.length && (!out.length || performance.now() - started < budget)) {
      const { x, y, z, material, from, radius } = this.throwing.shift()!;
      const c = [x + PIECE / 2 - from[0], y + PIECE / 2 - from[1], z + PIECE / 2 - from[2]];
      const len = Math.hypot(c[0]!, c[1]!, c[2]!) || 1;
      const dir = [c[0]! / len, c[1]! / len + 0.9, c[2]! / len];
      const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
      const speed = (5 + 7 * random()) * Math.sqrt(Math.min(2, radius / 64));
      const flight = throwDebris([x, y, z], PIECE, [(dir[0]! / dl) * speed, (dir[1]! / dl) * speed, (dir[2]! / dl) * speed], this.world.solidAt);
      out.push(packDebris(material, PIECE, flight));
      if (flight.rested && this.opts.keepDebris?.()) {
        const end = flight.path.at(-1)!;
        this.landing.push({ at: now + ((flight.path.length - 1) / DEBRIS_FPS) * 1000, x: end[0], y: end[1], z: end[2], material });
      }
    }
    return out;
  }

  /** Places debris that's come to rest by now (on the 1/2 m grid where it lies; a step up if that's taken; else not). */
  private settle(now: number): EditResult[] {
    const out: EditResult[] = [];
    for (let i = this.landing.length - 1; i >= 0; i--) {
      const l = this.landing[i]!;
      if (l.at > now) continue;
      this.landing.splice(i, 1);
      const x = Math.round(l.x / PIECE) * PIECE, z = Math.round(l.z / PIECE) * PIECE, y = Math.round(l.y / PIECE) * PIECE;
      for (const yy of [y, y + PIECE]) {
        try {
          out.push(this.world.applyEdit({ op: 'place', x, y: yy, z, size: PIECE, material: l.material }));
          break;
        } catch (err) {
          if (!(err instanceof EditError)) throw err;
        }
      }
    }
    return out;
  }
}

/**
 * Up to `want` pieces (1/2 m cells on the grid, each of the material most of it was) from what a
 * blast took out, chosen at random.
 */
export function pickPieces(removed: readonly { x: number; y: number; z: number; size: number; material: MaterialId }[], want: number, random: () => number): { x: number; y: number; z: number; material: MaterialId }[] {
  const cells = new Map<string, { x: number; y: number; z: number; material: MaterialId; volume: number }>();
  const add = (x: number, y: number, z: number, material: MaterialId, volume: number) => {
    const cx = Math.floor(x / PIECE) * PIECE, cy = Math.floor(y / PIECE) * PIECE, cz = Math.floor(z / PIECE) * PIECE;
    const key = `${cx},${cy},${cz}`, c = cells.get(key);
    if (!c) cells.set(key, { x: cx, y: cy, z: cz, material, volume });
    else if (volume > c.volume) Object.assign(c, { material, volume });
  };
  for (const v of removed) {
    if (isWater(v.material) || v.material === Material.TNT) continue;
    if (v.size <= PIECE) add(v.x, v.y, v.z, v.material, v.size ** 3);
    else for (let dy = 0; dy < v.size; dy += PIECE) for (let dz = 0; dz < v.size; dz += PIECE) for (let dx = 0; dx < v.size; dx += PIECE) add(v.x + dx, v.y + dy, v.z + dz, v.material, PIECE ** 3);
  }
  const all = [...cells.values()];
  // A random few (Fisher-Yates, as far as needed).
  for (let i = 0; i < Math.min(want, all.length); i++) {
    const j = i + Math.floor(random() * (all.length - i));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, want).map(({ x, y, z, material }) => ({ x, y, z, material }));
}
