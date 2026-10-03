/**
 * Explosives: TNT (Material.TNT) is lit with a click and, after FUSE_MS, blows out a crater around
 * itself: a sphere of blastRadius (by its size: a 1 m block, 4 m) carved down to small pieces at
 * its edge. TNT caught in a blast is lit too, on a short fuse, so stacks go off in a ripple; and
 * what's nearby is hurt (blastDamage).
 */

import { Material, type MaterialId } from './materials.js';

/**
 * Explosives, and how strong each is for its volume (blastRadius's scale: power 1 is a 4 m blast
 * from 1 m^3; the radius goes with the square root): TNT 4 (a 1 m block, 8 m); C4 163.84 (a 1/8 m
 * voxel, 2.3 m; 1/4 m, 6.4 m; 1/2 m or more, 16 m: the most). A blast's size is from the power it
 * all adds up to (tntEquivalent).
 */
export const EXPLOSIVE_POWER: Readonly<Partial<Record<MaterialId, number>>> = { [Material.TNT]: 4, [Material.C4]: 163.84 };

export function isExplosive(m: MaterialId): boolean {
  return EXPLOSIVE_POWER[m] !== undefined;
}

/** How much power-1 explosive (units cubed; see blastRadius) `volume` (units cubed) of explosive `m` equals (0 for what isn't one). */
export function tntEquivalent(m: MaterialId, volume: number): number {
  return (EXPLOSIVE_POWER[m] ?? 0) * volume;
}

/** How long a lit TNT burns before it blows (ms). */
export const FUSE_MS = 4000;
/** The fuse of TNT lit by another's blast (ms): somewhere in this range, so stacks ripple. */
export const CHAIN_FUSE_MS: readonly [number, number] = [250, 750];

/** The biggest blast's radius (units): 16 m. (Carving more stops the server for too long.) */
export const MAX_BLAST_RADIUS = 16 * 16;

/**
 * The radius (units) of a blast of `volume` (units cubed) of power-1 explosive (see
 * tntEquivalent): 4 m for 1 m^3. Touching explosives go off as one, and the radius grows with the
 * square root of what they add up to — far faster than a real blast's cube root: TNT blocks (power
 * 4) blow 8 m one, 11.3 m two, 16 m (the most) four or more.
 */
export function blastRadius(volume: number): number {
  return Math.min(MAX_BLAST_RADIUS, 64 * Math.sqrt(volume / 16 ** 3));
}

/** Health lost `distance` (units) from a blast of `radius`: up to BLAST_DAMAGE at the centre, none beyond 1.6 radii. */
export function blastDamage(distance: number, radius: number): number {
  const reach = 1.6 * radius;
  if (distance >= reach) return 0;
  return Math.ceil(BLAST_DAMAGE * (1 - distance / reach) * Math.min(1, radius / 64));
}

/** Health a 1 m TNT takes from someone right at it (players have 20). */
export const BLAST_DAMAGE = 16;

/**
 * How much more toward the open air than out a blast throws its debris (DEBRIS_LIFT times its
 * way out, added to the way out from its middle, before scaling to its speed): see openDirection.
 */
export const DEBRIS_LIFT = 2.5;

/** Directions (unit vectors) spread evenly over the sphere (a Fibonacci spiral), for openDirection. */
const DIRECTIONS: readonly (readonly [number, number, number])[] = (() => {
  const n = 64, golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * golden;
    return [Math.cos(a) * r, y, Math.sin(a) * r] as const;
  });
})();

/**
 * Which way a blast at (x, y, z) of `radius` (units) has to go: toward the open air around it
 * (`solidAt`, units: as before the blast). Out from just past the crater's edge in every direction,
 * how much of the way is air; the directions summed by that. On open ground, up; in a wall, out of
 * it; down a hole, up it. Buried all round (nowhere open), up. A unit vector.
 */
export function openDirection(solidAt: (x: number, y: number, z: number) => boolean | undefined, x: number, y: number, z: number, radius: number): [number, number, number] {
  let ox = 0, oy = 0, oz = 0;
  const steps = 6;
  for (const [dx, dy, dz] of DIRECTIONS) {
    let air = 0;
    for (let k = 0; k < steps; k++) {
      const d = radius * (1.1 + (0.8 * k) / (steps - 1)); // 1.1 to 1.9 radii out
      if (!solidAt(x + dx * d, y + dy * d, z + dz * d)) air++;
    }
    ox += (dx * air) / steps;
    oy += (dy * air) / steps;
    oz += (dz * air) / steps;
  }
  const len = Math.hypot(ox, oy, oz);
  // (Open all round, or nowhere, or evenly: no way's better than up.)
  if (len < 1) return [0, 1, 0];
  return [ox / len, oy / len, oz / len];
}

/** Value noise in 3D: smooth, in [-1, 1], about one wobble per unit; `seed` picks which. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => {
    let v = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177) + Math.imul(seed, 0x27d4eb2d)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    v ^= v >>> 16;
    return ((v >>> 0) / 4294967296) * 2 - 1;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), sx), lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), sx), sy),
    lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), sx), lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), sx), sy),
    sz,
  );
}
/** Value noise's steepest (per unit): its smoothstep's 1.5, over a rise of up to 2. */
const NOISE_SLOPE = 3;

/** A crater's lobes: noise over the way out (a unit vector), each octave's frequency and share of the radius. */
const LOBES = [{ f: 1.3, a: 0.3 }, { f: 2.7, a: 0.15 }, { f: 5.5, a: 0.07 }] as const;
/** The lobes' table: each of a cube map's six faces in LOBE_N by LOBE_N squares. */
const LOBE_N = 24;
/** And its walls' roughness: noise over where (each octave's scale and size, units; less for small blasts). */
const ROUGH = [{ scale: 24, a: 7 }] as const;

/**
 * The shape of a blast's crater (offsets from its centre, units): not a sphere but one with fractal
 * lobes and rough walls, from the blast's seed (so the server and every client make the same), or
 * without a seed, the sphere of `radius`. `reach` is how far it goes along the way to a point (the
 * point's in the crater if no farther); `inner` and `outer` bound it.
 */
export interface CraterShape {
  radius: number;
  inner: number;
  outer: number;
  reach(dx: number, dy: number, dz: number): number;
  /**
   * Whether a box (offsets of its corner from the centre, units; `size` across) is all in the
   * crater (1), all out of it (-1), or cut by its edge (0: decide its parts).
   */
  classify(dx: number, dy: number, dz: number, size: number): -1 | 0 | 1;
  /** Whether the point (offset from the centre, units) is in the crater. */
  contains(dx: number, dy: number, dz: number): boolean;
}

export function craterShape(radius: number, seed?: number): CraterShape {
  const k = Math.min(1, radius / 64);
  const lobes = seed === undefined ? 0 : LOBES.reduce((s, o) => s + o.a, 0);
  const rough = seed === undefined ? 0 : k * ROUGH.reduce((s, o) => s + o.a, 0);
  // How fast reach can change: across directions (per radian, times the radius), and from place to place.
  let lobeSlope = 0; // (set from the table, below)
  const roughSlope = k * ROUGH.reduce((s, o) => s + o.a / o.scale, 0) * NOISE_SLOPE;
  // The lobes go only with the way out: worked out once on a cube map of directions (six faces of
  // LOBE_N + 1 by LOBE_N + 1, the faces sharing their edges' samples, so it's continuous), looked up
  // between the nearest four, rather than three octaves of noise for each place. And how steep they
  // get (per radian), from the table itself: how far reach can change across a box (see classify).
  const N = LOBE_N, lobeTable = seed === undefined ? null : new Float32Array(6 * (N + 1) * (N + 1));
  const faceDir = (face: number, a: number, b: number): [number, number, number] => {
    const s = face & 1 ? -1 : 1, axis = face >> 1;
    const v: [number, number, number] = axis === 0 ? [s, a, b] : axis === 1 ? [a, s, b] : [a, b, s];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  let steepest = 0;
  if (lobeTable && seed !== undefined) {
    for (let face = 0; face < 6; face++) {
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const [ux, uy, uz] = faceDir(face, (i / N) * 2 - 1, (j / N) * 2 - 1);
          let f = 0;
          LOBES.forEach((o, n) => (f += o.a * noise3(ux * o.f, uy * o.f, uz * o.f, seed + n * 101)));
          lobeTable[face * (N + 1) * (N + 1) + i + (N + 1) * j] = f;
        }
      }
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const here = faceDir(face, (i / N) * 2 - 1, (j / N) * 2 - 1), f0 = lobeTable[face * (N + 1) * (N + 1) + i + (N + 1) * j]!;
          for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
            const ni = i + di, nj = j + dj;
            if (ni > N || nj < 0 || nj > N) continue;
            const there = faceDir(face, (ni / N) * 2 - 1, (nj / N) * 2 - 1);
            const angle = Math.acos(Math.min(1, here[0] * there[0] + here[1] * there[1] + here[2] * there[2]));
            steepest = Math.max(steepest, Math.abs(lobeTable[face * (N + 1) * (N + 1) + ni + (N + 1) * nj]! - f0) / angle);
          }
        }
      }
    }
  }
  const lobe = (dx: number, dy: number, dz: number): number => {
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    let face: number, a: number, b: number;
    if (ax >= ay && ax >= az) [face, a, b] = [dx >= 0 ? 0 : 1, dy / ax, dz / ax];
    else if (ay >= az) [face, a, b] = [dy >= 0 ? 2 : 3, dx / ay, dz / ay];
    else [face, a, b] = [dz >= 0 ? 4 : 5, dx / az, dy / az];
    const u = ((a + 1) / 2) * N, v = ((b + 1) / 2) * N;
    const i0 = Math.min(N - 1, Math.floor(u)), j0 = Math.min(N - 1, Math.floor(v)), fu = u - i0, fv = v - j0;
    const t = lobeTable!, o = face * (N + 1) * (N + 1);
    const p = t[o + i0 + (N + 1) * j0]!, q = t[o + i0 + 1 + (N + 1) * j0]!, r = t[o + i0 + (N + 1) * (j0 + 1)]!, w = t[o + i0 + 1 + (N + 1) * (j0 + 1)]!;
    return (p + (q - p) * fu) + ((r + (w - r) * fu) - (p + (q - p) * fu)) * fv;
  };
  lobeSlope = steepest * 1.25 * radius;
  const reach = (dx: number, dy: number, dz: number): number => {
    if (seed === undefined) return radius;
    let r = 0;
    ROUGH.forEach((o, i) => (r += k * o.a * noise3(dx / o.scale, dy / o.scale, dz / o.scale, seed + 1000 + i * 101)));
    return radius * (1 + lobe(dx, dy, dz)) + r;
  };
  const inner = radius * (1 - lobes) - rough, outer = radius * (1 + lobes) + rough;
  return {
    radius,
    inner,
    outer,
    reach,
    contains: (dx, dy, dz) => {
      const d = Math.hypot(dx, dy, dz);
      return d <= inner || (d <= outer && d <= reach(dx, dy, dz));
    },
    classify: (dx, dy, dz, size) => {
      let near = 0, far = 0;
      for (const lo of [dx, dy, dz]) {
        near += Math.max(lo, 0, -(lo + size)) ** 2;
        far += Math.max(lo * lo, (lo + size) ** 2);
      }
      near = Math.sqrt(near);
      far = Math.sqrt(far);
      if (near >= outer) return -1;
      if (far <= inner) return 1;
      if (seed === undefined) return near >= radius ? -1 : far <= radius ? 1 : 0;
      // Against the reach at its middle, give or take how much that can change across the box.
      const cx = dx + size / 2, cy = dy + size / 2, cz = dz + size / 2;
      const d = Math.hypot(cx, cy, cz), half = (size * Math.sqrt(3)) / 2;
      const r = reach(cx, cy, cz), slack = half * (lobeSlope / Math.max(d - half, half) + roughSlope);
      if (near >= r + slack) return -1;
      if (far <= r - slack) return 1;
      return 0;
    },
  };
}
