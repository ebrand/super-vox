import { BLOCK_SIZE } from './chunk.js';
import type { Aabb, SolidAt } from './physics.js';
import { raycastVoxels } from './raycast.js';

/**
 * Bows and arrows: a bow drawn (held) and let go shoots an arrow; it flies in an arc (gravity, no
 * drag) until it hits a mob, a player or the world, or it's flown long enough. The server flies
 * every arrow and says what each hit; players' games fly the same arc, from when it was shot, to
 * draw it.
 */
export const ARROW = {
  /** Speed at full draw (units/s), and at the least (a tap) as a share of it. */
  speed: 50 * BLOCK_SIZE,
  least: 0.25,
  /** Pull (units/s²), down. */
  gravity: 12 * BLOCK_SIZE,
  /** How long drawing it fully takes (ms); and the least time between shots. */
  drawMs: 900,
  cooldownMs: 450,
  /** How long one flies at most (ms) before it's gone. */
  lifeMs: 5000,
  /** Damage at full draw (as a sword's: health points; a player has 20), at the least a share of it. */
  damage: 7,
  /** What it knocks out of what it hits in the world: the piece (units) of the voxel there. */
  chip: BLOCK_SIZE / 4,
  /** How long one stuck in the world is shown (ms). */
  stuckMs: 30_000,
} as const;

/** An arrow as shot: from (x, y, z) at velocity (vx, vy, vz) (units, units/s), by player `by`. */
export interface ArrowShot {
  id: number;
  by: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** How much a draw held `ms` gives: 0..1 (a tap: the least; fully drawn at ARROW.drawMs). */
export function drawCharge(ms: number): number {
  return Math.max(0, Math.min(1, ms / ARROW.drawMs));
}

/** The speed (units/s) and damage of an arrow shot at `charge` (0..1). */
export function arrowSpeed(charge: number): number {
  return ARROW.speed * (ARROW.least + (1 - ARROW.least) * Math.max(0, Math.min(1, charge)));
}
export function arrowDamage(speed: number): number {
  return Math.max(1, Math.round((ARROW.damage * speed) / ARROW.speed));
}

/** Where an arrow is `t` seconds after it was shot (units), and how it's going. */
export function arrowAt(a: Pick<ArrowShot, 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz'>, t: number): { x: number; y: number; z: number; vx: number; vy: number; vz: number } {
  return { x: a.x + a.vx * t, y: a.y + a.vy * t - 0.5 * ARROW.gravity * t * t, z: a.z + a.vz * t, vx: a.vx, vy: a.vy - ARROW.gravity * t, vz: a.vz };
}

/** What an arrow hit, where (units), and how far along its step (0..1). */
export type ArrowHit =
  | { what: 'world'; at: [number, number, number]; cell: [number, number, number]; f: number }
  | { what: 'thing'; id: number; at: [number, number, number]; f: number };

/**
 * An arrow's flight from `t0` to `t1` seconds after it was shot, as a straight step: the first
 * thing it hits on the way, if any. `solidAt`: what stops it in the world (water too); `things`:
 * boxes (units) it can hit (mobs, players), by id.
 */
export function arrowStep(
  a: ArrowShot,
  t0: number,
  t1: number,
  solidAt: SolidAt,
  things: Iterable<{ id: number; box: Aabb }>,
): ArrowHit | null {
  const p = arrowAt(a, t0), q = arrowAt(a, t1);
  const d: [number, number, number] = [q.x - p.x, q.y - p.y, q.z - p.z];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len === 0) return null;
  let best: ArrowHit | null = null;
  const w = raycastVoxels([p.x, p.y, p.z], d, len, solidAt);
  if (w) best = { what: 'world', at: w.point, cell: w.cell, f: w.distance / len };
  for (const t of things) {
    const f = segmentBox([p.x, p.y, p.z], d, t.box);
    if (f !== null && (!best || f < best.f)) best = { what: 'thing', id: t.id, at: [p.x + d[0] * f, p.y + d[1] * f, p.z + d[2] * f], f };
  }
  return best;
}

/** Where along segment o + d·f (f in 0..1) it first meets a box, or null. */
function segmentBox(o: readonly number[], d: readonly number[], b: Aabb): number | null {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) {
      if (o[k]! < b.min[k]! || o[k]! > b.max[k]!) return null;
      continue;
    }
    let ta = (b.min[k]! - o[k]!) / d[k]!, tb = (b.max[k]! - o[k]!) / d[k]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
