import { BLOCK_SIZE } from './chunk.js';
import type { ItemId } from './items.js';
import type { SolidAt } from './physics.js';

/**
 * Things dropped on the ground (a pig's pork): where they lie (units: resting on the ground), for
 * anyone to pick up by walking up to them, until they're gone (DROP.lifeMs). Kept by the server
 * while it runs (not saved).
 */
export interface DroppedItem {
  id: number;
  item: ItemId;
  amount: number;
  x: number;
  y: number;
  z: number;
}

export const DROP = {
  /** Picked up within this (units) of the feet, horizontally; and this far up or down. */
  reach: 1.5 * BLOCK_SIZE,
  reachUp: 2 * BLOCK_SIZE,
  /** How long one lies there before it's gone (ms). */
  lifeMs: 5 * 60_000,
  /** At most this many lying about in a world (the oldest go first). */
  max: 300,
} as const;

/** Whether feet at (x, y, z) (units) are close enough to pick up `d`. */
export function canPickUp(d: Pick<DroppedItem, 'x' | 'y' | 'z'>, x: number, y: number, z: number): boolean {
  return Math.hypot(d.x - x, d.z - z) <= DROP.reach && d.y - y <= DROP.reachUp && y - d.y <= DROP.reachUp;
}

/**
 * Where something dropped at (x, y, z) (units) comes to rest: the top of the ground under it
 * (within 8 m down; none: where it is).
 */
export function restingY(x: number, y: number, z: number, solidAt: SolidAt): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  for (let cy = Math.ceil(y); cy >= Math.floor(y) - 8 * BLOCK_SIZE; cy--) if (solidAt(cx, cy, cz) === true) return cy + 1;
  return y;
}
