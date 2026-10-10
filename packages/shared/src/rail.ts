import { UNITS_PER_METER } from './units.js';
import { BLOCK_SIZE } from './chunk.js';
import { CHUNK_SIZE } from './world.js';
import { Material, type MaterialId } from './materials.js';

/**
 * Railways, laid a segment at a time (see segmentLine): a straight, or a curve on from a track's
 * end (an arc, tangent to it), sampled every SAMPLE_M; its height kept to the ground where it can
 * be but no steeper than MAX_GRADE (cut through rises, built up over dips: see profile), as deep
 * or high as MAX_CUT_M and MAX_FILL_M at most. A curve's radius sets how fast a train may take it
 * (see curveSpeed); the track's laid for a design speed, and a tighter curve is slower.
 */

/** Steepest the track climbs (rise over run), its tightest curve (m), and how often it's sampled (m). */
export const MAX_GRADE = 0.03;
export const MIN_RADIUS_M = 25;
export const SAMPLE_M = 1;
/** The track bed: how wide (m, gravel, with a metre's shoulder either side), and how high it's cleared above the rails (m: trees and all). */
export const BED_WIDTH_M = 3;
export const SHOULDER_M = 1;
export const CLEARANCE_M = 12;
/** In survival: how much track a rail item lays (m). */
export const RAIL_M = 2;
/** A segment's start this near a point along a track (m), not at its end, branches from it there (a switch); switches and crossings this far from a track's ends at least (m); crossings this sharp at least (degrees). */
export const BRANCH_M = 3;
export const SWITCH_CLEAR_M = 12;
export const CROSSING_ANGLE = 25;

/** Where two segments (x, z) cross: how far along each (0..1); null if they don't. */
export function segmentsCross(p1: { x: number; z: number }, p2: { x: number; z: number }, q1: { x: number; z: number }, q2: { x: number; z: number }): { t: number; u: number } | null {
  const rx = p2.x - p1.x, rz = p2.z - p1.z, sx = q2.x - q1.x, sz = q2.z - q1.z, den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = q1.x - p1.x, qz = q1.z - p1.z, t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

/** A segment's start or end this near a track's end (m) joins it (there, at its height). */
export const JOIN_M = 6;
/** In survival: how far from where you stand (m) you may lay track (both its ends). */
export const TRACK_REACH_M = 250;
/** A segment's shortest and longest (m). */
export const MIN_SEGMENT_M = 4;
export const MAX_SEGMENT_M = 400;
/** Ground's grade is measured over this far (m): steps and bumps shorter than it are cut or filled. */
export const GRADE_WINDOW_M = 20;
/** Deepest cut and highest fill (m) a segment may have (tunnels and bridges: later). */
export const MAX_CUT_M = 10;
export const MAX_FILL_M = 15;
/** Most a segment's end may turn from the track end it meets (radians: about 6 degrees). */
export const MAX_KINK = 0.1;
/** Speeds track's laid for (km/h), and how hard a train may be pushed sideways in a curve (m/s²: a game's, not a real railway's 1). */
export const DESIGN_SPEEDS = [40, 60, 80, 100] as const;
export const LATERAL_ACCEL = 2;

/** How fast (km/h) a curve of `radius` m may be taken (v² = a r). */
export function curveSpeed(radius: number): number {
  return Number.isFinite(radius) ? Math.sqrt(LATERAL_ACCEL * radius) * 3.6 : Infinity;
}

/** The tightest curve (m) taken at `speed` km/h. */
export function radiusFor(speed: number): number {
  return (speed / 3.6) ** 2 / LATERAL_ACCEL;
}

/** A point on a laid track: where (units: x, z across; y the rails' foot), its heading (radians, 0 = -z, counter-clockwise as boats'), and how far along (units). */
export interface TrackPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
  s: number;
}

/** A segment laid out: its points, and what it'd take (m: the most cut and filled, and where; the steepest grade). */
export interface TrackLayout {
  points: TrackPoint[];
  /** The ground under each point, as it is (units). */
  ground: number[];
  length: number;
  maxCut: number;
  maxFill: number;
  /** How far along (m) the deepest cut and the highest fill are. */
  cutAt: number;
  fillAt: number;
  maxGrade: number;
  /** The natural ground's steepest grade along it (over GRADE_WINDOW_M), and how far along (m) it's centred. */
  groundGrade: number;
  groundGradeAt: number;
}

type XZ = { x: number; z: number };

/** The way heading `h` goes (x, z), and the heading of a way. */
export const headingDir = (h: number): XZ => ({ x: -Math.sin(h), z: -Math.cos(h) });
export const dirHeading = (x: number, z: number): number => Math.atan2(-x, -z);

/** A segment asked for (units): from where, heading which way (a track's end: null, from anywhere), to where; straight, or curved. */
export interface SegmentAsk {
  from: XZ;
  heading: number | null;
  to: XZ;
  curve: boolean;
}

/** A segment's line: its points (units, every `step`), its radius (m; Infinity, straight), and the heading at its end. */
export interface SegmentLine {
  line: XZ[];
  radius: number;
  endHeading: number;
}

/**
 * The line of a segment (see SegmentAsk), every `step` units: straight from `from` to `to` (on
 * from a heading: straight on, as far as `to` is ahead); or curved (on from a heading only: the arc
 * leaving along it that passes through `to`, turning less than half round). Or why not.
 */
export function segmentLine(ask: SegmentAsk, step: number): SegmentLine | string {
  const M = UNITS_PER_METER, { from, to } = ask;
  const vx = to.x - from.x, vz = to.z - from.z;
  const sample = (L: number, at: (s: number) => XZ): XZ[] => {
    const n = Math.max(1, Math.round(L / step));
    return Array.from({ length: n + 1 }, (_, i) => at((L * i) / n));
  };
  const straight = (dx: number, dz: number, L: number): SegmentLine | string => {
    if (L < MIN_SEGMENT_M * M) return ask.heading !== null && L <= 0 ? 'straight on from a track goes ahead of its end' : `too short (${MIN_SEGMENT_M} m at least)`;
    if (L > MAX_SEGMENT_M * M) return `too long: ${Math.round(L / M)} m (${MAX_SEGMENT_M} m at most a segment)`;
    return { line: sample(L, (s) => ({ x: from.x + dx * s, z: from.z + dz * s })), radius: Infinity, endHeading: dirHeading(dx, dz) };
  };
  if (ask.heading === null) {
    if (ask.curve) return "a curve goes on from a track's end: start from one";
    const L = Math.hypot(vx, vz);
    return L > 0 ? straight(vx / L, vz / L, L) : 'too short';
  }
  const d = headingDir(ask.heading);
  const ahead = d.x * vx + d.z * vz;
  if (!ask.curve) return straight(d.x, d.z, ahead);
  if (ahead <= 0) return 'a curve turns less than half round: aim ahead of the end';
  const side = d.x * vz - d.z * vx, chord = Math.hypot(vx, vz);
  // (Nearly in line: straight.)
  if (Math.abs(side) < 1e-3 * chord) return straight(d.x, d.z, ahead);
  // The circle through `to`, tangent to the heading at `from`: its centre to the side `to` is on.
  const sinPhi = Math.abs(side) / chord, R = chord / (2 * sinPhi), turn = 2 * Math.atan2(Math.abs(side), ahead), L = R * turn;
  if (L > MAX_SEGMENT_M * M) return `too long: ${Math.round(L / M)} m (${MAX_SEGMENT_M} m at most a segment)`;
  if (L < MIN_SEGMENT_M * M) return `too short (${MIN_SEGMENT_M} m at least)`;
  const sign = Math.sign(side), nx = -d.z * sign, nz = d.x * sign;
  const cx = from.x + nx * R, cz = from.z + nz * R, r0x = from.x - cx, r0z = from.z - cz;
  // (Turned about the centre the way the heading goes.)
  const rot = sign;
  const at = (s: number): XZ => {
    const t = (rot * s) / R, c = Math.cos(t), si = Math.sin(t);
    return { x: cx + r0x * c - r0z * si, z: cz + r0x * si + r0z * c };
  };
  const t = (rot * L) / R, ex = r0x * Math.cos(t) - r0z * Math.sin(t), ez = r0x * Math.sin(t) + r0z * Math.cos(t);
  return { line: sample(L, at), radius: R / M, endHeading: dirHeading(-ez * rot, ex * rot) };
}

/**
 * Heights for track over ground `ground` (one each, units), `step` units apart: as near the ground
 * as it can be, no steeper than `grade` (the least cut and fill that keeps to it: the ground
 * clamped from both ends, then the two met halfway). `pins`: heights it must have at its start or
 * end (a track's end it goes on from); null if they can't both be kept to at that grade.
 */
export function profile(ground: readonly number[], step: number, grade = MAX_GRADE, pins: { start?: number; end?: number; at?: readonly { i: number; y: number }[] } = {}): number[] | null {
  const n = ground.length, rise = grade * step;
  if (!n) return [];
  // Every height it must have (its ends, and points along it: level crossings), in order; none too far from the next for the grade.
  const fixed = [...(pins.start !== undefined ? [{ i: 0, y: pins.start }] : []), ...(pins.at ?? []).map((p) => ({ i: Math.max(0, Math.min(n - 1, Math.round(p.i))), y: p.y })), ...(pins.end !== undefined ? [{ i: n - 1, y: pins.end }] : [])].sort((a, b) => a.i - b.i);
  for (let k = 1; k < fixed.length; k++) if (Math.abs(fixed[k]!.y - fixed[k - 1]!.y) > rise * (fixed[k]!.i - fixed[k - 1]!.i) * 0.98 + 1e-9) return null;
  const g = [...ground];
  for (const f of fixed) g[f.i] = f.y;
  const clampFwd = (h: number[]) => {
    for (let i = 1; i < n; i++) h[i] = Math.min(Math.max(h[i]!, h[i - 1]! - rise), h[i - 1]! + rise);
  };
  const clampBack = (h: number[]) => {
    for (let i = n - 2; i >= 0; i--) h[i] = Math.min(Math.max(h[i]!, h[i + 1]! - rise), h[i + 1]! + rise);
  };
  // Kept from rising or falling too fast: once each way, and the middle of the two.
  const fwd = [...g], back = [...g];
  clampFwd(fwd);
  clampBack(back);
  let h = fwd.map((v, i) => (v + back[i]!) / 2);
  // (The middle may be steeper than the grade where the two differ: clamped again, both ways, till it isn't.)
  for (let pass = 0; pass < 50; pass++) {
    const before = h.join();
    clampFwd(h);
    clampBack(h);
    if (h.join() === before) break;
  }
  // Rounded through the changes of grade (a little: as many either side, fewer near the ends).
  h = h.map((_, i) => {
    const r = Math.min(4, i, n - 1 - i);
    let t = 0;
    for (let k = i - r; k <= i + r; k++) t += h[k]!;
    return t / (2 * r + 1);
  });
  // Pinned ends where they're pinned: the rest kept to the grade from them (and never steeper for the rounding).
  const fix = () => {
    for (const f of fixed) h[f.i] = f.y;
  };
  for (let pass = 0; pass < 100; pass++) {
    const before = h.join();
    fix();
    clampFwd(h);
    clampBack(h);
    fix();
    if (h.join() === before) break;
  }
  // (Never settled, pinned too near the grade's limit: not to be had.)
  for (let i = 1; i < n; i++) if (Math.abs(h[i]! - h[i - 1]!) > rise + 1e-6) return null;
  return h;
}

/**
 * A segment's line (units) laid over ground `groundAt` (units, at x, z): heights by `profile`
 * (pinned where it starts or ends at a track's end), headings along it, and what it'd take. Null
 * if its pinned ends are too far apart in height for the grade.
 */
export function layLine(line: readonly XZ[], groundAt: (x: number, z: number) => number, pins: { start?: number; end?: number; at?: readonly { i: number; y: number }[] } = {}): TrackLayout | null {
  const M = UNITS_PER_METER, step = line.length > 1 ? Math.hypot(line[1]!.x - line[0]!.x, line[1]!.z - line[0]!.z) : SAMPLE_M * M;
  const ground = line.map((p) => groundAt(p.x, p.z));
  const ys = profile(ground, step, MAX_GRADE, pins);
  if (!ys) return null;
  const points: TrackPoint[] = line.map((p, i) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    return { x: p.x, y: ys[i]!, z: p.z, heading: dirHeading(b.x - a.x, b.z - a.z), s: i * step };
  });
  let maxCut = 0, maxFill = 0, cutAt = 0, fillAt = 0, maxGrade = 0;
  for (let i = 0; i < points.length; i++) {
    const d = ys[i]! - ground[i]!;
    if (d > maxFill) (maxFill = d), (fillAt = points[i]!.s);
    if (-d > maxCut) (maxCut = -d), (cutAt = points[i]!.s);
    if (i > 0) maxGrade = Math.max(maxGrade, Math.abs(ys[i]! - ys[i - 1]!) / step);
  }
  const steep = groundGrade(ground, step);
  return { points, ground, length: points.at(-1)!.s / M, maxCut: maxCut / M, maxFill: maxFill / M, cutAt: cutAt / M, fillAt: fillAt / M, maxGrade, groundGrade: steep.grade, groundGradeAt: steep.at / M };
}

/**
 * The steepest the ground `ground` (units, `step` apart) climbs or falls over GRADE_WINDOW_M (or
 * the whole of it, if shorter), and where (units along: the window's middle).
 */
export function groundGrade(ground: readonly number[], step: number): { grade: number; at: number } {
  const n = ground.length;
  if (n < 2) return { grade: 0, at: 0 };
  const w = Math.min(n - 1, Math.max(1, Math.round((GRADE_WINDOW_M * UNITS_PER_METER) / step)));
  let grade = 0, at = 0;
  for (let i = 0; i + w < n; i++) {
    const g = Math.abs(ground[i + w]! - ground[i]!) / (w * step);
    if (g > grade) (grade = g), (at = (i + w / 2) * step);
  }
  return { grade, at };
}

/**
 * A segment as it'd be laid (see the trackPlan message): what it'd take (m; rails, in survival),
 * its radius (m; Infinity: straight, sent as null) and the speed it's good for (km/h: the design
 * speed, or less in a tighter curve), its end and the heading there (to go on from), its line
 * (units, a point every few metres, with the rails' height) and its profile (m: the rails' height
 * and the ground's, as far along: the same points).
 */
export interface TrackPlan {
  length: number;
  maxCut: number;
  maxFill: number;
  maxGrade: number;
  /** The ground's steepest, along it (see groundGrade). */
  groundGrade: number;
  radius: number | null;
  speed: number;
  rails: number;
  end: { x: number; z: number; heading: number };
  line: { x: number; y: number; z: number }[];
  profile: { s: number; y: number; ground: number }[];
}

/** A laid track (the world keeps it): its points (see TrackPoint), how fast it may be taken (km/h) and its radius (m; null, straight), and the chunk columns its earthworks changed ("cx,cz": not "built on" for the next track: see the server). */
export interface Track {
  id: number;
  points: TrackPoint[];
  speed: number;
  radius: number | null;
  columns: string[];
}

/**
 * Track ends nothing goes on from yet (units, and the heading out of the track there; y the
 * rails' foot). (Two ends together, where one track goes on from another: neither free.)
 */
export function freeEnds(tracks: readonly Track[]): { x: number; y: number; z: number; heading: number }[] {
  const ends = tracks.flatMap((t) => [
    { x: t.points[0]!.x, y: t.points[0]!.y, z: t.points[0]!.z, heading: t.points[0]!.heading + Math.PI },
    { x: t.points.at(-1)!.x, y: t.points.at(-1)!.y, z: t.points.at(-1)!.z, heading: t.points.at(-1)!.heading },
  ]);
  return ends.filter((e, i) => !ends.some((o, j) => j !== i && Math.hypot(o.x - e.x, o.z - e.z) < UNITS_PER_METER));
}

/** A piece of earthworks: a cube (units: its least corner, its size), of a material. */
export interface EarthPiece {
  x: number;
  y: number;
  z: number;
  size: number;
  material: MaterialId;
}

/**
 * The earthworks for a laid track over natural ground `groundAt` (units): the ground within the
 * bed and its shoulders (of the nearest point) cleared from a metre under the rails' foot
 * (CLEARANCE_M up, or to the ground and a metre over in a cut: open, not a tunnel), then built up
 * from the ground to the rails' foot (dirt, then gravel: the top metre, the bed). Clear first: fill
 * only goes where there's room. Blocks wholly within: in whole metres (and quarters to the foot);
 * blocks the edge crosses, in 1/4 m columns, those within (so its edges are fine), up to the
 * block's ground; over that (trees), in whole blocks again.
 */
export function earthworks(points: readonly TrackPoint[], groundAt: (x: number, z: number) => number): { fill: EarthPiece[]; clear: EarthPiece[]; columns: string[] } {
  const B = BLOCK_SIZE, Q = B / 4, half = (BED_WIDTH_M / 2 + SHOULDER_M) * UNITS_PER_METER, PER = B / Q;
  // Each quarter column (x, z, in quarters) near the line: the height of the nearest point, and how near.
  const near = new Map<number, { y: number; d: number }>();
  const key = (qx: number, qz: number) => qx * 4194304 + qz; // (quarter coordinates well within 2^22)
  for (const p of points)
    for (let qx = Math.floor((p.x - half) / Q); qx <= Math.floor((p.x + half) / Q); qx++)
      for (let qz = Math.floor((p.z - half) / Q); qz <= Math.floor((p.z + half) / Q); qz++) {
        const d = Math.hypot(qx * Q + Q / 2 - p.x, qz * Q + Q / 2 - p.z);
        if (d > half) continue;
        const k = key(qx, qz), was = near.get(k);
        if (!was || d < was.d) near.set(k, { y: p.y, d });
      }
  // By block: which of its quarter columns are within.
  const blocks = new Map<string, { bx: number; bz: number; quarters: { qx: number; qz: number; y: number; d: number }[] }>();
  for (const [k, v] of near) {
    const qx = Math.round(k / 4194304), qz = k - qx * 4194304, bx = Math.floor(qx / PER), bz = Math.floor(qz / PER);
    const bk = `${bx},${bz}`;
    const b = blocks.get(bk) ?? blocks.set(bk, { bx, bz, quarters: [] }).get(bk)!;
    b.quarters.push({ qx, qz, y: v.y, d: v.d });
  }
  const fill: EarthPiece[] = [], clear: EarthPiece[] = [], columns = new Set<string>();
  const CHUNK = CHUNK_SIZE / B; // (blocks a chunk across)
  const footOf = (y: number) => Math.floor(y / Q) * Q;
  for (const { bx, bz, quarters } of blocks.values()) {
    const x = bx * B, z = bz * B;
    columns.add(`${Math.floor(bx / CHUNK)},${Math.floor(bz / CHUNK)}`);
    if (quarters.length === PER * PER) {
      // Wholly within: as high as its nearest quarter's point.
      const y = quarters.reduce((a, b) => (b.d < a.d ? b : a)).y;
      const ground = groundAt(x + B / 2, z + B / 2), foot = footOf(y), whole = Math.floor(foot / B) * B;
      // Up from the ground: whole blocks, then quarters to the foot; gravel for the top metre.
      // (From the bed's bottom at least: in a cut, that's been cleared.)
      for (let b = Math.min(Math.floor(ground / B) * B - B, whole - B); b < whole; b += B) fill.push({ x, y: b, z, size: B, material: b >= whole - B ? Material.Gravel : Material.Dirt });
      for (let q = whole; q < foot; q += Q) for (let qx = 0; qx < B; qx += Q) for (let qz = 0; qz < B; qz += Q) fill.push({ x: x + qx, y: q, z: z + qz, size: Q, material: Material.Gravel });
      // Cleared from the metre under the bed's top (that metre made gravel again: the bed, even on
      // ground as it was), as high as needs be: whole blocks.
      const up = Math.max(foot + CLEARANCE_M * UNITS_PER_METER, ground + B);
      for (let b = whole - B; b < up; b += B) clear.push({ x, y: b, z, size: B, material: Material.Air });
      continue;
    }
    // The edge crosses it: quarter columns, those within, up to the top of the block's ground (all of it, within or not); whole blocks over that.
    let top = -Infinity, highest = -Infinity;
    for (let qx = 0; qx < PER; qx++) for (let qz = 0; qz < PER; qz++) top = Math.max(top, groundAt(x + qx * Q + Q / 2, z + qz * Q + Q / 2));
    for (const q of quarters) highest = Math.max(highest, q.y);
    const solidTop = Math.ceil(top / B) * B;
    for (const q of quarters) {
      const qx = q.qx * Q, qz = q.qz * Q, ground = groundAt(qx + Q / 2, qz + Q / 2), foot = footOf(q.y), bedBottom = foot - B;
      // Up from the ground (to a quarter): dirt, the top metre gravel.
      for (let h = Math.min(Math.floor(ground / Q) * Q - Q, bedBottom); h < foot; h += Q) fill.push({ x: qx, y: h, z: qz, size: Q, material: h >= bedBottom ? Material.Gravel : Material.Dirt });
      // Cleared from the metre under the bed's top to the block's ground top.
      for (let h = bedBottom; h < solidTop; h += Q) clear.push({ x: qx, y: h, z: qz, size: Q, material: Material.Air });
    }
    // Over the ground (trees), as high as for the rest: whole blocks.
    const up = Math.max(footOf(highest) + CLEARANCE_M * UNITS_PER_METER, top + B);
    for (let b = solidTop; b < up; b += B) clear.push({ x, y: b, z, size: B, material: Material.Air });
  }
  return { fill, clear, columns: [...columns].sort() };
}
