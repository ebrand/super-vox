import { ARROW, arrowSpeed, arrowStep, type Aabb, type ArrowHit, type ArrowShot } from '@super-vox/shared';
import type { World } from './world.js';

/** Something an arrow can hit: a mob or a player (by id), and its box (units). */
export interface Target {
  id: number;
  kind: 'mob' | 'player';
  box: Aabb;
}

/** An arrow that's stopped: what it hit (null: nothing, it flew its time). */
export interface Stopped {
  shot: ArrowShot;
  hit: (ArrowHit & { kind?: 'mob' | 'player'; water?: boolean }) | null;
  /** Where it stopped (units). */
  at: [number, number, number];
}

/** A world's arrows in flight (see arrows.ts): shot, flown a step at a time, and stopped by what they hit. */
export class ArrowFlights {
  private readonly flying = new Map<number, { shot: ArrowShot; born: number; t: number }>();
  private nextId = 1;
  /** At most this many in flight (the oldest go first). */
  static readonly MAX = 300;

  constructor(private readonly world: World) {}

  get count(): number {
    return this.flying.size;
  }

  /** Shoots one: by player `by`, from (x, y, z) along `dir` (units; any length), drawn `charge`. */
  shoot(by: number, x: number, y: number, z: number, dir: readonly [number, number, number], charge: number, now: number): ArrowShot {
    const len = Math.hypot(...dir) || 1, v = arrowSpeed(charge);
    const shot: ArrowShot = { id: this.nextId++, by, x, y, z, vx: (dir[0] / len) * v, vy: (dir[1] / len) * v, vz: (dir[2] / len) * v };
    if (this.flying.size >= ArrowFlights.MAX) this.flying.delete(this.flying.keys().next().value!);
    this.flying.set(shot.id, { shot, born: now, t: 0 });
    return shot;
  }

  /**
   * Flies every arrow on to `now`: those that hit something (the world, water, a target: never
   * the one who shot it) or flew their time stop, and are returned.
   */
  step(now: number, targets: readonly Target[]): Stopped[] {
    const out: Stopped[] = [];
    const stops = (x: number, y: number, z: number) => this.world.solidAt(x, y, z) || this.world.waterAt(x, y, z) === true;
    for (const [id, f] of this.flying) {
      const t1 = Math.min((now - f.born) / 1000, ARROW.lifeMs / 1000);
      const things = targets.filter((g) => !(g.kind === 'player' && g.id === f.shot.by));
      const hit = arrowStep(f.shot, f.t, t1, stops, things);
      f.t = t1;
      if (hit) {
        this.flying.delete(id);
        const kind = hit.what === 'thing' ? targets.find((g) => g.id === hit.id)?.kind : undefined;
        const water = hit.what === 'world' && this.world.waterAt(...hit.cell) === true;
        out.push({ shot: f.shot, hit: { ...hit, ...(kind ? { kind } : {}), ...(water ? { water } : {}) }, at: hit.at });
      } else if (t1 >= ARROW.lifeMs / 1000) {
        this.flying.delete(id);
        const p = f.shot, t = t1;
        out.push({ shot: p, hit: null, at: [p.x + p.vx * t, p.y + p.vy * t - 0.5 * ARROW.gravity * t * t, p.z + p.vz * t] });
      }
    }
    return out;
  }
}
