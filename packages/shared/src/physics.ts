/** Whether a unit cell (world units) is solid; undefined where the world isn't known (not loaded). */
export type SolidAt = (x: number, y: number, z: number) => boolean | undefined;

/**
 * Axis-aligned box in world units (1/16 m), occupying [min, max) on each
 * axis. Positions may be fractional.
 */
export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

/** Player body: 0.6 m wide, 1.8 m tall, eyes 1.62 m above the feet (units). */
export const PLAYER = { width: 0.6 * 16, height: 1.8 * 16, eye: 1.62 * 16 } as const;

/** Highest ledge climbed automatically when walking into it: 1/2 m. */
export const STEP_HEIGHT = 8;

/** Unloaded chunks count as empty so moving fast never gets stuck waiting for data. */
const solid = (solidAt: SolidAt, x: number, y: number, z: number) => solidAt(x, y, z) === true;

/** The player's box for a given eye position (units). */
export function playerBox(eye: readonly [number, number, number]): Aabb {
  const h = PLAYER.width / 2;
  const feet = eye[1] - PLAYER.eye;
  return { min: [eye[0] - h, feet, eye[2] - h], max: [eye[0] + h, feet + PLAYER.height, eye[2] + h] };
}

/** Unit cells overlapped by [lo, hi) on one axis. */
function cellRange(lo: number, hi: number): [number, number] {
  return [Math.floor(lo), Math.ceil(hi) - 1];
}

/** Whether any solid unit cell overlaps the box. */
export function intersectsSolid(box: Aabb, solidAt: SolidAt): boolean {
  const [x0, x1] = cellRange(box.min[0], box.max[0]);
  const [y0, y1] = cellRange(box.min[1], box.max[1]);
  const [z0, z1] = cellRange(box.min[2], box.max[2]);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (solid(solidAt, x, y, z)) return true;
  return false;
}

/**
 * How far the box can move along `axis` by up to `d` units before touching a
 * solid cell. Sweeps every cell layer on the way, so fast movement cannot
 * tunnel through thin voxels.
 */
export function sweepAxis(box: Aabb, axis: 0 | 1 | 2, d: number, solidAt: SolidAt): number {
  if (d === 0) return 0;
  const b = axis === 0 ? 1 : 0;
  const c = axis === 2 ? 1 : 2;
  const [b0, b1] = cellRange(box.min[b], box.max[b]);
  const [c0, c1] = cellRange(box.min[c], box.max[c]);
  const layerSolid = (k: number) => {
    const p = [0, 0, 0];
    p[axis] = k;
    for (let i = b0; i <= b1; i++) {
      p[b] = i;
      for (let j = c0; j <= c1; j++) {
        p[c] = j;
        if (solid(solidAt, p[0]!, p[1]!, p[2]!)) return true;
      }
    }
    return false;
  };
  if (d > 0) {
    const edge = box.max[axis];
    for (let k = Math.ceil(edge); k < edge + d; k++) if (layerSolid(k)) return k - edge;
    return d;
  }
  const edge = box.min[axis];
  for (let k = Math.floor(edge) - 1; k + 1 > edge + d; k--) if (layerSolid(k)) return k + 1 - edge;
  return d;
}

function shifted(box: Aabb, axis: 0 | 1 | 2, d: number): Aabb {
  const out: Aabb = { min: [...box.min], max: [...box.max] };
  out.min[axis] += d;
  out.max[axis] += d;
  return out;
}

export interface MoveResult {
  /** How far the box actually moved (units). */
  delta: [number, number, number];
  /** Axes on which movement was cut short. */
  blocked: [boolean, boolean, boolean];
}

/**
 * Moves the box by `delta` (units) through the voxel world: Y first, then X
 * and Z, each clipped where it would enter a solid cell, so movement slides
 * along walls. A horizontal move blocked by a ledge up to `stepHeight` high
 * climbs onto it. A box that already overlaps solid moves freely (so an edit
 * landing on the player never traps them).
 */
export function moveAabb(
  box: Aabb,
  delta: readonly [number, number, number],
  solidAt: SolidAt,
  stepHeight = STEP_HEIGHT,
): MoveResult {
  if (intersectsSolid(box, solidAt)) return { delta: [delta[0], delta[1], delta[2]], blocked: [false, false, false] };
  let cur = box;
  const moved: [number, number, number] = [0, 0, 0];
  const blocked: [boolean, boolean, boolean] = [false, false, false];

  const dy = sweepAxis(cur, 1, delta[1], solidAt);
  blocked[1] = Math.abs(dy - delta[1]) > 1e-9;
  cur = shifted(cur, 1, dy);
  moved[1] = dy;

  for (const axis of [0, 2] as const) {
    const want = delta[axis];
    if (want === 0) continue;
    const d = sweepAxis(cur, axis, want, solidAt);
    if (Math.abs(d - want) <= 1e-9 || stepHeight <= 0) {
      cur = shifted(cur, axis, d);
      moved[axis] = d;
      blocked[axis] = Math.abs(d - want) > 1e-9;
      continue;
    }
    // Blocked: try stepping up onto the obstacle, then settling back down onto it.
    const up = sweepAxis(cur, 1, stepHeight, solidAt);
    const raised = shifted(cur, 1, up);
    const d2 = sweepAxis(raised, axis, want, solidAt);
    if (up > 0 && Math.abs(d2) > Math.abs(d) + 1e-9) {
      const stepped = shifted(raised, axis, d2);
      const down = sweepAxis(stepped, 1, -up, solidAt);
      cur = shifted(stepped, 1, down);
      moved[1] += up + down;
      moved[axis] = d2;
      blocked[axis] = Math.abs(d2 - want) > 1e-9;
    } else {
      cur = shifted(cur, axis, d);
      moved[axis] = d;
      blocked[axis] = true;
    }
  }
  return { delta: moved, blocked };
}
