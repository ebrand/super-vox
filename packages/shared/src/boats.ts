import { BLOCK_SIZE } from './chunk.js';
import { designVoxels, type ObjectDesign } from './designs.js';
import { PLAYER, intersectsSolid, sweepAxis, type Aabb, type SolidAt } from './physics.js';

/**
 * Boats: a design standing in for the boat (see STATIONS), put in the water from the boat item,
 * and ridden. One stays where it's left (the world keeps it), for anyone to get into; the one
 * riding it moves it (their client, as it moves them), and everyone sees it go.
 */
export interface Boat {
  id: number;
  /** The design it's made from (its look and its size, as it was when it was put in the water). */
  design: string;
  /** The middle of its hull's bottom (units), and the way its bow points (radians; 0 = north, -Z; counter-clockwise). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Who's in it (a player's id), if anyone. */
  rider?: number;
}

/** How a boat goes (units, seconds, radians). */
export const BOAT = {
  /** Top speed ahead, and astern. */
  speed: 7 * BLOCK_SIZE,
  back: 2.5 * BLOCK_SIZE,
  /** Speeding up (units/s²); and slowing by itself, with nothing pressed. */
  accel: 4 * BLOCK_SIZE,
  drag: 3 * BLOCK_SIZE,
  /** Turning, at rest and at speed (it turns a little slower going fast). */
  turn: 1.6,
  /** How deep it sits (units): its bottom this far under the surface (its floor's top above it: not flooded inside). */
  draft: 1,
  /** How far one can reach to get in or take it (units). */
  reach: 5 * BLOCK_SIZE,
} as const;

/** What the rider presses: ahead (1) or astern (-1), and left (1) or right (-1). */
export interface BoatInput {
  forward: number;
  turn: number;
}

/** A boat as it moves (its speed along its heading, units/s, besides where it is). */
export interface BoatMotion {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
}

/** A boat's hull, from its design (as drawn, facing north): half its width (x) and length (z), and its height (units). */
export interface Hull {
  halfW: number;
  halfL: number;
  height: number;
  /** Where its voxels' box is in the design (its least corner, units): the model is drawn from there. */
  x0: number;
  y0: number;
  z0: number;
  /** Where the rider sits: their feet, above the hull's bottom (units). */
  seat: number;
}

/** A design's hull (see Hull); a design with nothing in it: a 1 m box. */
export function boatHull(design: ObjectDesign): Hull {
  const vs = designVoxels(design, 0, 'n');
  if (!vs.length) return { halfW: 8, halfL: 8, height: 8, x0: 0, y0: 0, z0: 0, seat: 2 };
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const v of vs) {
    x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); z0 = Math.min(z0, v.z);
    x1 = Math.max(x1, v.x + v.size); y1 = Math.max(y1, v.y + v.size); z1 = Math.max(z1, v.z + v.size);
  }
  // The seat: on whatever's highest under its middle (a bench, the bottom boards), no more than
  // 3/4 m up (not a mast); else on its bottom.
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, under = y0 + 12;
  let seat = 0;
  for (const v of vs) {
    if (v.x > cx || v.x + v.size < cx || v.z > cz || v.z + v.size < cz) continue;
    const top = v.y + v.size;
    if (top <= under) seat = Math.max(seat, top - y0);
  }
  return { halfW: (x1 - x0) / 2, halfL: (z1 - z0) / 2, height: y1 - y0, x0, y0, z0, seat };
}

/** The box around a hull turned to `yaw`, at a boat's place (units); from `bottom` up. */
export function hullBox(hull: Hull, x: number, z: number, yaw: number, bottom: number, top: number): Aabb {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const hx = c * hull.halfW + s * hull.halfL, hz = s * hull.halfW + c * hull.halfL;
  return { min: [x - hx, bottom, z - hz], max: [x + hx, top, z + hz] };
}

/**
 * The top of the water (units) in column (x, z) near height `y` (within 2 m above it and 3 m
 * below), or null for none there; undefined where it isn't known (not loaded). `waterAt`: whether
 * a unit cell is water.
 */
export function waterSurface(waterAt: SolidAt, x: number, y: number, z: number): number | null | undefined {
  const cx = Math.floor(x), cz = Math.floor(z);
  for (let cy = Math.floor(y) + 2 * BLOCK_SIZE; cy >= Math.floor(y) - 3 * BLOCK_SIZE; cy--) {
    const w = waterAt(cx, cy, cz);
    if (w === undefined) return undefined;
    if (w) return cy + 1;
  }
  return null;
}

/**
 * A boat's next place, `dt` seconds on, under `input`: turning, speeding up or slowing; floating
 * on the water (its bottom BOAT.draft under the top); stopped by anything solid above the water
 * and by the shore (it goes nowhere the water doesn't). `surface`: the water's top near a point
 * (see waterSurface); `solidAt`: what's solid.
 */
export function stepBoat(
  b: BoatMotion,
  input: BoatInput,
  dt: number,
  hull: Hull,
  surface: (x: number, y: number, z: number) => number | null | undefined,
  solidAt: SolidAt,
): BoatMotion {
  dt = Math.min(dt, 0.1);
  const want = input.forward > 0 ? BOAT.speed : input.forward < 0 ? -BOAT.back : 0;
  let speed = b.speed;
  if (want !== 0 && Math.sign(want) !== Math.sign(speed) && speed !== 0) speed -= Math.sign(speed) * Math.min(Math.abs(speed), (BOAT.accel + BOAT.drag) * dt);
  else if (Math.abs(want) > Math.abs(speed)) speed += Math.sign(want) * Math.min(Math.abs(want) - Math.abs(speed), BOAT.accel * dt);
  else speed -= Math.sign(speed) * Math.min(Math.abs(speed) - Math.abs(want), BOAT.drag * dt);
  const yaw = b.yaw + Math.sign(input.turn) * BOAT.turn * (1 - (0.4 * Math.abs(speed)) / BOAT.speed) * dt;
  const top = surface(b.x, b.y + BOAT.draft, b.z);
  // (Out of the water, or not known there: it stays.)
  if (top === null || top === undefined) return { ...b, yaw, speed: 0 };
  let { x, z } = b;
  let blocked = false;
  // (Its corners, a little in, with no water under them: where it's aground. It goes nowhere that grounds more of it.)
  const cs = Math.cos(yaw), sn = Math.sin(yaw), hw = Math.max(1, hull.halfW - 1), hl = Math.max(1, hull.halfL - 1);
  const aground = (px: number, pz: number) => {
    let n = 0;
    for (const [sx, sz] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const w = surface(px + cs * sx * hw - sn * sz * hl, top, pz - sn * sx * hw - cs * sz * hl);
      if (w === null || w === undefined) n++;
    }
    return n;
  };
  const d = [-Math.sin(yaw) * speed * dt, -Math.cos(yaw) * speed * dt];
  for (const axis of [0, 2] as const) {
    const want = d[axis === 0 ? 0 : 1]!;
    if (want === 0) continue;
    // What's above the water stops it; and it goes nowhere there's no water under its middle.
    const box = hullBox(hull, x, z, yaw, top + 1, top + Math.max(2, hull.height - BOAT.draft));
    const can = sweepAxis(box, axis, want, solidAt);
    const nx = axis === 0 ? x + can : x, nz = axis === 2 ? z + can : z;
    if (aground(nx, nz) > aground(x, z)) {
      blocked = true;
      continue;
    }
    if (Math.abs(can) < Math.abs(want) - 1e-9) blocked = true;
    x = nx;
    z = nz;
  }
  const y = (surface(x, top, z) ?? top) - BOAT.draft;
  // (Stopped, nose on to something: it loses its way. Scraping along a wall: it goes on.)
  const went = Math.hypot(x - b.x, z - b.z), meant = Math.abs(speed * dt);
  return { x, y, z, yaw, speed: blocked && went < 0.3 * meant ? speed * 0.5 : speed };
}

/**
 * Where someone getting out of a boat stands (their feet, units): on dry ground beside it if
 * there's any (to the left first, then the right, ahead, behind; the nearest it's moored to), else
 * in the water beside it (to swim). `b`: the boat (its hull's bottom), pointing `b.yaw`.
 */
export function getOutAt(b: { x: number; y: number; z: number; yaw: number }, hull: Hull, solidAt: SolidAt): [number, number, number] {
  const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
  const ways: [number, number, number][] = [
    [fz, -fx, hull.halfW], // left
    [-fz, fx, hull.halfW], // right
    [fx, fz, hull.halfL], // ahead
    [-fx, -fz, hull.halfL], // behind
  ];
  const half = PLAYER.width / 2;
  const free = (x: number, feet: number, z: number) =>
    !intersectsSolid({ min: [x - half, feet, z - half], max: [x + half, feet + PLAYER.height, z + half] }, solidAt);
  for (const [dx, dz, reach] of ways) {
    for (const out of [reach + half + 2, reach + half + 10]) {
      const x = b.x + dx * out, z = b.z + dz * out;
      // Ground under there, no more than 1 1/2 m above the water or 1/4 m below it (wading), with
      // room above it: not the bottom under the water.
      const water = b.y + BOAT.draft;
      for (let y = Math.ceil(water) + 24; y >= Math.floor(water) - 5; y--) {
        if (solidAt(Math.floor(x), y, Math.floor(z)) !== true) continue;
        if (free(x, y + 1, z)) return [x, y + 1, z];
        break;
      }
    }
  }
  const [dx, dz, reach] = ways[0]!;
  return [b.x + dx * (reach + half + 2), b.y + BOAT.draft, b.z + dz * (reach + half + 2)];
}
