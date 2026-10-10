import { UNITS_PER_METER } from './units.js';
import type { Track } from './rail.js';
import { BLOCK_VOLUME, Item, isBlock, type ItemId } from './items.js';

/**
 * Trains: cars on track (see rail.ts), coupled into trains. A car's where its middle is on a track
 * (how far along, units) and which way along that track its train's "forward" is; a train moves all
 * its cars the same distance along the line (see alongLine), over the joins from one track to the
 * next, so they keep their spacing. An engine pulls (or pushes) its train; trains touching couple if
 * they meet slowly enough (see COUPLE_SPEED), else stop. A train no one drives has its brakes on.
 */

export type CarKind = 'engine' | 'flatbed' | 'passenger';
export const CAR_KINDS: readonly CarKind[] = ['engine', 'flatbed', 'passenger'];
/** The item each kind is (put on track; taken off: given back). */
export const CAR_ITEM: Record<CarKind, ItemId> = { engine: Item.Engine, flatbed: Item.FlatbedCar, passenger: Item.PassengerCar };
/** The kind of car an item is, if it's one. */
export const carOfItem = (item: ItemId | null): CarKind | null => CAR_KINDS.find((k) => CAR_ITEM[k] === item) ?? null;
/** A flatbed holds this many crates (two layers of two by six); a crate holds CRATE_ITEMS of an item, or CRATE_BLOCKS blocks of a material. */
export const FLATBED_CRATES = 24;
export const CRATE_ITEMS = 64;
export const CRATE_BLOCKS = 8;
/** How much of `item` fills a crate (as inventories keep it). */
export const crateOf = (item: ItemId): number => (isBlock(item) ? CRATE_BLOCKS * BLOCK_VOLUME : CRATE_ITEMS);
/** How many crates a load takes (each kind of thing in its own). */
export const cratesFor = (cargo: readonly [ItemId, number][] | undefined): number => (cargo ?? []).reduce((n, [item, amount]) => n + Math.ceil(amount / crateOf(item) - 1e-9), 0);
/** A passenger car's seats. */
export const PASSENGER_SEATS = 8;
/** Coal's put in an engine by the lump: an eighth of a block. */
export const COAL_LUMP = 1 / 8;

/** Each kind: its length over its buffers (m), its bogies' (or axles') distance from its middle (m), its mass (t). */
export const CAR_SPECS: Record<CarKind, { length: number; bogie: number; mass: number }> = {
  engine: { length: 10, bogie: 3.2, mass: 60 },
  flatbed: { length: 9, bogie: 3.2, mass: 12 },
  passenger: { length: 13, bogie: 4.6, mass: 28 },
};
/** Between coupled cars' buffers (m). */
export const CAR_GAP_M = 0.6;
/** An engine's pull (kN), at most and as its power (kW) allows; brakes (m/s², and for its speed limit); rolling resistance (of its weight). */
export const ENGINE_FORCE_KN = 160;
export const ENGINE_POWER_KW = 900;
export const BRAKE = 1.2;
export const LIMIT_BRAKE = 0.8;
export const ROLLING = 0.002;
const G = 9.81;
/** Trains meeting slower than this (m/s, between them) couple; faster, they stop dead. */
export const COUPLE_SPEED = 3;
/** Coal: how long one keeps an engine going at full throttle (s); the most it holds. */
export const COAL_SECONDS = 60;
export const MAX_COAL = 20;

/** Where a car is: on which track, how far along it (units), and which way along it its train's forward is (+1: increasing s). */
export interface CarPos {
  track: number;
  s: number;
  dir: 1 | -1;
}

export interface Car {
  id: number;
  kind: CarKind;
  pos: CarPos;
  /** Facing back along its train (its front toward the train's back). */
  flip: boolean;
  /** An engine's fuel (s at full throttle; survival). */
  fuel?: number;
  /** A flatbed's load: what, and how much (as inventories keep it: blocks by volume, items by count). */
  cargo?: [ItemId, number][];
  /** A passenger car's seats: who's in each (a player's id), or no one. Not kept: everyone's out when the world's opened again. */
  seats?: (number | null)[];
}

/** A train: its cars, front to back; its speed (m/s, + forward); who's driving (a player's id) and how. */
export interface Train {
  id: number;
  cars: Car[];
  v: number;
  driver: number | null;
  /** -1..1, the way its engine faces (+: ahead). */
  throttle: number;
  brake: boolean;
}

/** Track as a network: each track, and what each of its ends joins (another's start or end), if anything. */
export interface TrackNet {
  tracks: Map<number, Track>;
  links: Map<string, { track: number; end: 'start' | 'end' }>;
}

/** The network of `tracks`: ends within a metre of each other joined. */
export function trackNet(tracks: readonly Track[]): TrackNet {
  const map = new Map(tracks.map((t) => [t.id, t]));
  const links = new Map<string, { track: number; end: 'start' | 'end' }>();
  const ends = tracks.flatMap((t) => [
    { track: t.id, end: 'start' as const, p: t.points[0]! },
    { track: t.id, end: 'end' as const, p: t.points.at(-1)! },
  ]);
  for (const a of ends)
    for (const b of ends)
      if (a !== b && a.track !== b.track && Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) < UNITS_PER_METER) links.set(`${a.track}:${a.end}`, { track: b.track, end: b.end });
  return { tracks: map, links };
}

const lengthOf = (t: Track) => t.points.at(-1)!.s;

/**
 * `pos` moved `d` units along the line (+: its forward), over joins; stopped at the end of the
 * line if it gets there. Where it got to, and how far it went (units, ≥ 0).
 */
export function alongLine(net: TrackNet, pos: CarPos, d: number): { pos: CarPos; moved: number } {
  let { track, s, dir } = pos;
  let left = Math.abs(d), moved = 0;
  // (The way along this track it goes: its forward, or back.)
  let way = (d >= 0 ? dir : -dir) as 1 | -1;
  for (let hops = 0; hops < 1000; hops++) {
    const t = net.tracks.get(track);
    if (!t) break;
    const L = lengthOf(t), room = way > 0 ? L - s : s;
    if (left <= room) {
      s += way * left;
      moved += left;
      left = 0;
      break;
    }
    s = way > 0 ? L : 0;
    moved += room;
    left -= room;
    const link = net.links.get(`${track}:${way > 0 ? 'end' : 'start'}`);
    if (!link) break;
    const next = net.tracks.get(link.track)!;
    // On along the next: from its start (increasing) or its end (decreasing). Forward turns with it.
    const nextWay = link.end === 'start' ? 1 : -1;
    dir = (nextWay === way ? dir : -dir) as 1 | -1;
    way = nextWay;
    track = link.track;
    s = link.end === 'start' ? 0 : lengthOf(next);
  }
  return { pos: { track, s, dir }, moved };
}

/** Where a point on the line is (units) and the way its forward heads (radians, as headings; boats', 0 = -z), and how steep that way (rise over run). */
export function pointAt(net: TrackNet, pos: CarPos): { x: number; y: number; z: number; heading: number; grade: number } | null {
  const t = net.tracks.get(pos.track);
  if (!t) return null;
  const pts = t.points, step = pts.length > 1 ? pts[1]!.s - pts[0]!.s : 1;
  const f = Math.max(0, Math.min(pts.length - 1, pos.s / step)), i = Math.min(pts.length - 2, Math.floor(f)), k = f - i;
  const a = pts[i]!, b = pts[i + 1] ?? a;
  const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k, z = a.z + (b.z - a.z) * k;
  const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const fx = (b.x - a.x) * pos.dir, fz = (b.z - a.z) * pos.dir;
  return { x, y, z, heading: Math.atan2(-fx, -fz), grade: ((b.y - a.y) * pos.dir) / run };
}

/** A car in the world (units): its middle between its bogies, the way it faces (its front's way: heading), and its pitch (up its front). */
export function carPose(net: TrackNet, car: Car): { x: number; y: number; z: number; heading: number; pitch: number } | null {
  const b = CAR_SPECS[car.kind].bogie * UNITS_PER_METER;
  const f = pointAt(net, alongLine(net, car.pos, car.flip ? -b : b).pos), r = pointAt(net, alongLine(net, car.pos, car.flip ? b : -b).pos);
  if (!f || !r) return null;
  const dx = f.x - r.x, dz = f.z - r.z;
  return { x: (f.x + r.x) / 2, y: (f.y + r.y) / 2, z: (f.z + r.z) / 2, heading: Math.atan2(-dx, -dz), pitch: Math.atan2(f.y - r.y, Math.hypot(dx, dz) || 1) };
}

/** Where a car's coupler is (units), at its train-forward end (+1) or back (-1). */
export function couplerAt(net: TrackNet, car: Car, end: 1 | -1): { x: number; y: number; z: number } | null {
  const p = pointAt(net, alongLine(net, car.pos, (end * CAR_SPECS[car.kind].length * UNITS_PER_METER) / 2).pos);
  return p && { x: p.x, y: p.y, z: p.z };
}

/** A train's mass (t). */
export const trainMass = (t: Train) => t.cars.reduce((m, c) => m + CAR_SPECS[c.kind].mass, 0);

/** The slowest the track under a train lets it go (m/s). */
export function speedLimit(net: TrackNet, t: Train): number {
  let kmh = Infinity;
  for (const c of t.cars) kmh = Math.min(kmh, net.tracks.get(c.pos.track)?.speed ?? Infinity);
  return Number.isFinite(kmh) ? kmh / 3.6 : 30;
}

/**
 * A train's speed after `dt` s: its engines' pull (if driven, and they've fuel: `burn` says if it's
 * used), the slope under each car, rolling resistance, its brakes (on if no one's driving), and the
 * track's speed limit (held to it). Fuel burned is taken from the engines.
 */
export function accelerate(net: TrackNet, t: Train, dt: number, burn: boolean): number {
  const mass = trainMass(t) * 1000, limit = speedLimit(net, t);
  let force = 0;
  if (t.driver !== null && t.throttle !== 0) {
    for (const c of t.cars) {
      if (c.kind !== 'engine') continue;
      if (burn && !((c.fuel ?? 0) > 0)) continue;
      const way = c.flip ? -1 : 1, pull = Math.min(ENGINE_FORCE_KN * 1000, (ENGINE_POWER_KW * 1000) / Math.max(1, Math.abs(t.v)));
      // (At the limit, no more pull that way: a governor.)
      if (Math.abs(t.v) >= limit && Math.sign(t.throttle * way) === Math.sign(t.v)) continue;
      force += t.throttle * way * pull;
      if (burn) c.fuel = Math.max(0, (c.fuel ?? 0) - Math.abs(t.throttle) * dt);
    }
  }
  for (const c of t.cars) force -= CAR_SPECS[c.kind].mass * 1000 * G * (pointAt(net, c.pos)?.grade ?? 0);
  let v = t.v + (force / mass) * dt;
  // Slowing (never past stopping): rolling, the brakes, and the limit.
  const slow = (by: number) => {
    v = v > 0 ? Math.max(0, v - by) : Math.min(0, v + by);
  };
  slow(ROLLING * G * dt);
  if (t.brake || t.driver === null) slow(BRAKE * dt);
  if (Math.abs(v) > limit) v = Math.sign(v) * Math.max(limit, Math.abs(v) - LIMIT_BRAKE * dt);
  return v;
}

/**
 * Moves a train `d` units (+: forward), as far as the line goes: all its cars alike. How far it
 * went (units, ≥ 0: less than asked at the end of the line, its front or back car's buffers there).
 */
export function moveTrain(net: TrackNet, t: Train, d: number): number {
  if (!d || !t.cars.length) return 0;
  const lead = d > 0 ? t.cars[0]! : t.cars.at(-1)!, half = (CAR_SPECS[lead.kind].length * UNITS_PER_METER) / 2;
  const sign = Math.sign(d);
  // (How far its leading buffers can go.)
  const room = Math.max(0, alongLine(net, lead.pos, sign * (half + Math.abs(d))).moved - half);
  const go = Math.min(Math.abs(d), room);
  if (go > 0) for (const c of t.cars) c.pos = alongLine(net, c.pos, sign * go).pos;
  return go;
}

/** Where the car behind `car` (of `kind`, coupled) goes: back along the line from it. */
export function behind(net: TrackNet, car: Car, kind: CarKind): CarPos {
  return alongLine(net, car.pos, -((CAR_SPECS[car.kind].length + CAR_SPECS[kind].length) / 2 + CAR_GAP_M) * UNITS_PER_METER).pos;
}
