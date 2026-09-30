/**
 * Deterministic 2D value noise and fractal sums. Integer hashing uses
 * Math.imul so results are identical on every JS engine.
 */

/** Hashes lattice point (ix, iz) with a seed to a float in [0, 1). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Quintic smoothstep: C2-continuous interpolation weight. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface Octave {
  /** Lattice spacing in units. */
  spacing: number;
  /** Peak-to-peak weight of this octave. */
  weight: number;
  /**
   * Lattice period along X in lattice cells, or 0 for none. With a period,
   * the octave repeats every `period * spacing` units so a wrapping world
   * has no seam.
   */
  periodX: number;
  seed: number;
}

/**
 * Sums value-noise octaves over a `w x d` grid of unit columns starting at
 * (x0, z0), sampling at column centers. Returns values in [-sum/2, sum/2]
 * of weights, row-major (index x + w * z).
 */
export function fractalGrid(octaves: readonly Octave[], x0: number, z0: number, w: number, d: number): Float64Array {
  const out = new Float64Array(w * d);
  const fx = new Float64Array(w);
  const ix = new Int32Array(w);
  const fz = new Float64Array(d);
  const iz = new Int32Array(d);
  for (const o of octaves) {
    for (let i = 0; i < w; i++) {
      const p = (x0 + i + 0.5) / o.spacing;
      ix[i] = Math.floor(p);
      fx[i] = fade(p - ix[i]!);
    }
    for (let j = 0; j < d; j++) {
      const p = (z0 + j + 0.5) / o.spacing;
      iz[j] = Math.floor(p);
      fz[j] = fade(p - iz[j]!);
    }
    // Lattice values covering the region, cached per octave.
    const lx0 = ix[0]!, lz0 = iz[0]!;
    const lw = ix[w - 1]! - lx0 + 2;
    const ld = iz[d - 1]! - lz0 + 2;
    const lattice = new Float64Array(lw * ld);
    for (let b = 0; b < ld; b++) {
      for (let a = 0; a < lw; a++) {
        let gx = lx0 + a;
        if (o.periodX > 0) gx = ((gx % o.periodX) + o.periodX) % o.periodX;
        lattice[a + lw * b] = hash2(gx, lz0 + b, o.seed) - 0.5;
      }
    }
    for (let j = 0; j < d; j++) {
      const row = (iz[j]! - lz0) * lw;
      const tz = fz[j]!;
      for (let i = 0; i < w; i++) {
        const k = row + ix[i]! - lx0;
        const tx = fx[i]!;
        const a = lattice[k]! + (lattice[k + 1]! - lattice[k]!) * tx;
        const b = lattice[k + lw]! + (lattice[k + lw + 1]! - lattice[k + lw]!) * tx;
        out[i + w * j]! += (a + (b - a) * tz) * o.weight;
      }
    }
  }
  return out;
}
