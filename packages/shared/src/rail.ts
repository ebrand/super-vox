import { UNITS_PER_METER } from './units.js';
import { BLOCK_SIZE } from './chunk.js';
import { CHUNK_SIZE } from './world.js';
import { Material, type MaterialId } from './materials.js';

/**
 * Railways: a route drawn on the map (points, in order) laid as track: a smooth line through the
 * points (see layRoute), its height kept to the ground where it can be but no steeper than
 * MAX_GRADE (cut through rises, built up over dips: see profile), sampled every SAMPLE_M.
 */

/** Steepest the track climbs (rise over run), and its tightest curve (m), and how often it's sampled (m). */
export const MAX_GRADE = 0.03;
export const MIN_RADIUS_M = 25;
export const SAMPLE_M = 1;
/** The track bed: how wide (m, gravel, with a metre's shoulder either side), and how high it's cleared above the rails (m: trees and all). */
export const BED_WIDTH_M = 3;
export const SHOULDER_M = 1;
export const CLEARANCE_M = 12;
/** In survival: how much track a rail item lays (m). */
export const RAIL_M = 2;
/** A route's end this near a track's end (m) joins it (there, at its height). */
export const JOIN_M = 6;
/** Points a route may have, and its longest (m). */
export const MAX_ROUTE_POINTS = 64;
export const MAX_ROUTE_M = 4000;

/** A point on a laid track: where (units: x, z across; y the rails' foot), its heading (radians, 0 = -z, counter-clockwise as boats'), and how far along (units). */
export interface TrackPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
  s: number;
}

/** A route laid out: its points, and what it'd take (m: the most cut and filled; the steepest grade; the tightest curve). */
export interface TrackLayout {
  points: TrackPoint[];
  /** The ground under each point, as it is (units). */
  ground: number[];
  length: number;
  maxCut: number;
  maxFill: number;
  maxGrade: number;
  minRadius: number;
}

type XZ = { x: number; z: number };

/**
 * A smooth line through `pts` (centripetal Catmull-Rom: no loops or overshoots between close
 * points), sampled every `step` units along it (the last point too).
 */
export function smoothLine(pts: readonly XZ[], step: number): XZ[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  // (Ends: a point beyond each, in line, for the curve to start and end straight.)
  const ext = [{ x: 2 * pts[0]!.x - pts[1]!.x, z: 2 * pts[0]!.z - pts[1]!.z }, ...pts, { x: 2 * pts.at(-1)!.x - pts.at(-2)!.x, z: 2 * pts.at(-1)!.z - pts.at(-2)!.z }];
  const fine: XZ[] = [];
  for (let i = 1; i < ext.length - 2; i++) {
    const [p0, p1, p2, p3] = [ext[i - 1]!, ext[i]!, ext[i + 1]!, ext[i + 2]!];
    const d = (a: XZ, b: XZ) => Math.max(1e-6, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
    const t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / (step / 4)));
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a: XZ, b: XZ, ta: number, tb: number) => ({ x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta), z: ((tb - t) * a.z + (t - ta) * b.z) / (tb - ta) });
      const a1 = lerp(p0, p1, 0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2), b2 = lerp(a2, a3, t1, t3);
      fine.push(lerp(b1, b2, t1, t2));
    }
  }
  fine.push({ ...pts.at(-1)! });
  // Evenly along it.
  const out: XZ[] = [{ ...fine[0]! }];
  let carry = 0;
  for (let i = 1; i < fine.length; i++) {
    const a = fine[i - 1]!, b = fine[i]!, seg = Math.hypot(b.x - a.x, b.z - a.z);
    let along = step - carry;
    while (along <= seg) {
      const f = along / seg;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
      along += step;
    }
    carry = seg - (along - step);
  }
  if (Math.hypot(out.at(-1)!.x - fine.at(-1)!.x, out.at(-1)!.z - fine.at(-1)!.z) > step * 0.25) out.push({ ...fine.at(-1)! });
  return out;
}

/**
 * Heights for track over ground `ground` (one each, units), `step` units apart: as near the ground
 * as it can be, no steeper than `grade` (the least cut and fill that keeps to it: the ground
 * clamped from both ends, then the two met halfway).
 */
export function profile(ground: readonly number[], step: number, grade = MAX_GRADE): number[] {
  const n = ground.length, rise = grade * step;
  if (!n) return [];
  // Kept from rising or falling too fast: once each way, and the middle of the two.
  const fwd = [...ground], back = [...ground];
  for (let i = 1; i < n; i++) fwd[i] = Math.min(Math.max(fwd[i]!, fwd[i - 1]! - rise), fwd[i - 1]! + rise);
  for (let i = n - 2; i >= 0; i--) back[i] = Math.min(Math.max(back[i]!, back[i + 1]! - rise), back[i + 1]! + rise);
  let h = fwd.map((v, i) => (v + back[i]!) / 2);
  // (The middle may be steeper than the grade where the two differ: clamped again, both ways, till it isn't.)
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (let i = 1; i < n; i++) {
      const lo = h[i - 1]! - rise, hi = h[i - 1]! + rise;
      if (h[i]! < lo - 1e-9 || h[i]! > hi + 1e-9) (h[i] = Math.min(Math.max(h[i]!, lo), hi)), (changed = true);
    }
    for (let i = n - 2; i >= 0; i--) {
      const lo = h[i + 1]! - rise, hi = h[i + 1]! + rise;
      if (h[i]! < lo - 1e-9 || h[i]! > hi + 1e-9) (h[i] = Math.min(Math.max(h[i]!, lo), hi)), (changed = true);
    }
    if (!changed) break;
  }
  // Rounded through the changes of grade (a little: as many either side, fewer near the ends).
  h = h.map((_, i) => {
    const r = Math.min(4, i, n - 1 - i);
    let t = 0;
    for (let k = i - r; k <= i + r; k++) t += h[k]!;
    return t / (2 * r + 1);
  });
  // (And never steeper for it: kept to the grade again.)
  for (let i = 1; i < n; i++) h[i] = Math.min(Math.max(h[i]!, h[i - 1]! - rise), h[i - 1]! + rise);
  for (let i = n - 2; i >= 0; i--) h[i] = Math.min(Math.max(h[i]!, h[i + 1]! - rise), h[i + 1]! + rise);
  return h;
}

/**
 * A route (`pts`, units) laid over ground `groundAt` (units, at x, z): its smooth line, every
 * SAMPLE_M, heights by `profile`, and what it'd take. Null if it's too short (under two points).
 */
export function layRoute(pts: readonly XZ[], groundAt: (x: number, z: number) => number): TrackLayout | null {
  if (pts.length < 2) return null;
  const step = SAMPLE_M * UNITS_PER_METER;
  const line = smoothLine(pts, step);
  const ground = line.map((p) => groundAt(p.x, p.z));
  const ys = profile(ground, step);
  const points: TrackPoint[] = line.map((p, i) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    return { x: p.x, y: ys[i]!, z: p.z, heading: Math.atan2(-(b.x - a.x), -(b.z - a.z)), s: i * step };
  });
  let maxCut = 0, maxFill = 0, maxGrade = 0, minRadius = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = ys[i]! - ground[i]!;
    if (d > maxFill) maxFill = d;
    if (-d > maxCut) maxCut = -d;
    if (i > 0) maxGrade = Math.max(maxGrade, Math.abs(ys[i]! - ys[i - 1]!) / step);
    if (i > 0 && i < points.length - 1) {
      // (The circle through three points in a row.)
      const [a, b, c] = [line[i - 1]!, line[i]!, line[i + 1]!];
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
      if (Math.abs(cross) > 1e-9) minRadius = Math.min(minRadius, (ab * bc * ca) / (2 * Math.abs(cross)));
    }
  }
  const M = UNITS_PER_METER;
  return { points, ground, length: points.at(-1)!.s / M, maxCut: maxCut / M, maxFill: maxFill / M, maxGrade, minRadius: minRadius / M };
}

/** A route as it'd be laid, for the map (see the trackPlan message): what it'd take (m; rails, in survival), its line (units, x and z, a point every few metres) and its profile (m: the rails' height and the ground's, as far along). */
export interface TrackPlan {
  length: number;
  maxCut: number;
  maxFill: number;
  maxGrade: number;
  minRadius: number;
  rails: number;
  line: { x: number; z: number }[];
  profile: { s: number; y: number; ground: number }[];
}

/** A laid track (the world keeps it): its points (see TrackPoint), and the chunk columns its earthworks changed ("cx,cz": not "built on" for the next track: see the server). */
export interface Track {
  id: number;
  points: TrackPoint[];
  columns: string[];
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
 * The earthworks for a laid track over natural ground `groundAt` (units): every 1 m column within
 * the bed and its shoulders (of the nearest point) cleared from a metre under the rails' foot
 * (CLEARANCE_M up, or to the ground and a metre over in a cut: open, not a tunnel), then built up
 * from the ground to the rails' foot (1 m blocks of dirt, then 1/4 m voxels to the height; the top
 * metre gravel: the bed). Clear first: fill only goes where there's room.
 */
export function earthworks(points: readonly TrackPoint[], groundAt: (x: number, z: number) => number): { fill: EarthPiece[]; clear: EarthPiece[]; columns: string[] } {
  const B = BLOCK_SIZE, Q = B / 4, half = (BED_WIDTH_M / 2 + SHOULDER_M) * UNITS_PER_METER;
  // Each column (block x, z) near the line: the height of the nearest point.
  const top = new Map<string, { bx: number; bz: number; y: number; d: number }>();
  for (const p of points) {
    for (let bx = Math.floor((p.x - half) / B); bx <= Math.floor((p.x + half) / B); bx++)
      for (let bz = Math.floor((p.z - half) / B); bz <= Math.floor((p.z + half) / B); bz++) {
        const d = Math.hypot(bx * B + B / 2 - p.x, bz * B + B / 2 - p.z);
        if (d > half) continue;
        const key = `${bx},${bz}`, was = top.get(key);
        if (!was || d < was.d) top.set(key, { bx, bz, y: p.y, d });
      }
  }
  const fill: EarthPiece[] = [], clear: EarthPiece[] = [], columns = new Set<string>();
  const CHUNK = CHUNK_SIZE / B; // (blocks a chunk across)
  for (const { bx, bz, y } of top.values()) {
    const x = bx * B, z = bz * B, ground = groundAt(x + B / 2, z + B / 2);
    columns.add(`${Math.floor(bx / CHUNK)},${Math.floor(bz / CHUNK)}`);
    const foot = Math.floor(y / Q) * Q, whole = Math.floor(foot / B) * B;
    // Up from the ground: whole blocks, then quarters to the foot; gravel for the top metre.
    for (let b = Math.floor(ground / B) * B - B; b < whole; b += B) fill.push({ x, y: b, z, size: B, material: b >= whole - B ? Material.Gravel : Material.Dirt });
    for (let q = whole; q < foot; q += Q) for (let qx = 0; qx < B; qx += Q) for (let qz = 0; qz < B; qz += Q) fill.push({ x: x + qx, y: q, z: z + qz, size: Q, material: Material.Gravel });
    // Cleared from the metre under the bed's top (that metre made gravel again: the bed, even on
    // ground as it was), as high as needs be: whole blocks.
    const up = Math.max(foot + CLEARANCE_M * UNITS_PER_METER, ground + B);
    for (let b = whole - B; b < up; b += B) clear.push({ x, y: b, z, size: B, material: Material.Air });
  }
  return { fill, clear, columns: [...columns].sort() };
}
