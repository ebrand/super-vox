import { GRAVITY } from './walking.js';
import { sweepAxis, type Aabb, type SolidAt } from './physics.js';
import type { MaterialId } from './materials.js';

/**
 * Debris: pieces of what an explosion blew apart, thrown out of the crater, falling, bouncing off
 * the world and sliding to rest. The server works out each piece's flight (throwDebris) so every
 * player sees the same; in creative, where a piece comes to rest it stays, as a voxel.
 */

/** How often a flight is recorded (frames a second). */
export const DEBRIS_FPS = 15;
/** Steps simulated per recorded frame. */
const SUBSTEPS = 2;
/** Longest flight (s): anything still going by then stops where it is. */
export const DEBRIS_MAX_SECONDS = 5;
/** Of a piece's speed into a surface, how much it keeps bouncing back. */
const BOUNCE = 0.3;
/** Slower than this into the ground (m/s), it stops bouncing. */
const SETTLE_SPEED = 1.5;
/** How fast sliding along the ground slows (per second, exponential). */
const FRICTION = 5;
/** Slower than this along the ground (m/s), it's at rest. */
const REST_SPEED = 0.3;

/** A piece's flight: its positions (corner, units), DEBRIS_FPS a second, the last at rest; and whether it came to rest. */
export interface DebrisFlight {
  path: [number, number, number][];
  rested: boolean;
}

/**
 * The flight of a cube `size` units across with its corner at `start` (units), thrown at
 * `velocity` (m/s), under gravity through the world (`solidAt`, units): it bounces off what it
 * hits, losing most of its speed, and slides along the ground until it stops.
 */
export function throwDebris(start: readonly [number, number, number], size: number, velocity: readonly [number, number, number], solidAt: SolidAt): DebrisFlight {
  const M = 16, dt = 1 / (DEBRIS_FPS * SUBSTEPS);
  const v: [number, number, number] = [velocity[0] * M, velocity[1] * M, velocity[2] * M];
  const box: Aabb = { min: [start[0], start[1], start[2]], max: [start[0] + size, start[1] + size, start[2] + size] };
  const path: [number, number, number][] = [[start[0], start[1], start[2]]];
  let grounded = false;
  for (let frame = 1; frame <= DEBRIS_MAX_SECONDS * DEBRIS_FPS; frame++) {
    for (let s = 0; s < SUBSTEPS; s++) {
      v[1] -= GRAVITY * M * dt;
      if (grounded) {
        const f = Math.exp(-FRICTION * dt);
        v[0] *= f;
        v[2] *= f;
      }
      const want: [number, number, number] = [v[0]! * dt, v[1]! * dt, v[2]! * dt];
      // Up/down, then across (sweeping cell by cell, so nothing's tunnelled through; no stepping up).
      const blocked = [false, false, false];
      for (const a of [1, 0, 2] as const) {
        if (want[a] === 0) continue;
        const d = sweepAxis(box, a, want[a], solidAt);
        box.min[a]! += d;
        box.max[a]! += d;
        blocked[a] = Math.abs(d - want[a]) > 1e-9;
      }
      grounded = blocked[1]! && v[1]! < 0;
      if (blocked[1]) v[1] = Math.abs(v[1]!) < SETTLE_SPEED * M ? 0 : -v[1]! * BOUNCE;
      if (blocked[0]) v[0] = -v[0]! * BOUNCE;
      if (blocked[2]) v[2] = -v[2]! * BOUNCE;
    }
    path.push([box.min[0], box.min[1], box.min[2]]);
    if (grounded && Math.hypot(v[0]!, v[2]!) < REST_SPEED * M && v[1] === 0) return { path, rested: true };
  }
  return { path, rested: false };
}

/** A piece as clients are told of it: material, size (units), and its path (units) as a start and then the steps from frame to frame. */
export interface DebrisPiece {
  m: MaterialId;
  s: number;
  /** x, y, z of the start, then dx, dy, dz for each frame after (whole units, rounded). */
  p: number[];
  /** How long (ms) it had been flying when sent (worked out a little after its blast), if at all. */
  a?: number;
}

/** A flight packed as a DebrisPiece. */
export function packDebris(material: MaterialId, size: number, flight: DebrisFlight): DebrisPiece {
  const p: number[] = [];
  let last = [0, 0, 0];
  flight.path.forEach((q, i) => {
    const r = q.map(Math.round);
    if (i === 0) p.push(...r);
    else p.push(r[0]! - last[0]!, r[1]! - last[1]!, r[2]! - last[2]!);
    last = r;
  });
  return { m: material, s: size, p };
}

/** A DebrisPiece's path back as positions (units). */
export function unpackDebris(piece: DebrisPiece): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < piece.p.length; i += 3) {
    const prev = out.at(-1);
    out.push(prev ? [prev[0] + piece.p[i]!, prev[1] + piece.p[i + 1]!, prev[2] + piece.p[i + 2]!] : [piece.p[i]!, piece.p[i + 1]!, piece.p[i + 2]!]);
  }
  return out;
}
