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
 * Sums value-noise octaves over a `w x d` grid of unit columns: sample (i, j)
 * is the column at (x0 + i * step, z0 + j * step), evaluated at its centre.
 * Returns values in [-sum/2, sum/2] of weights, row-major (index i + w * j).
 */
export function fractalGrid(
  octaves: readonly Octave[],
  x0: number,
  z0: number,
  w: number,
  d: number,
  step = 1,
): Float64Array {
  const out = new Float64Array(w * d);
  const fx = new Float64Array(w);
  const ix = new Int32Array(w);
  const fz = new Float64Array(d);
  const iz = new Int32Array(d);
  const wrapX = (o: Octave, gx: number) => (o.periodX > 0 ? ((gx % o.periodX) + o.periodX) % o.periodX : gx);
  let A = new Float64Array(0), B = new Float64Array(0);
  for (const o of octaves) {
    for (let i = 0; i < w; i++) {
      const p = (x0 + i * step + 0.5) / o.spacing;
      ix[i] = Math.floor(p);
      fx[i] = fade(p - ix[i]!);
    }
    for (let j = 0; j < d; j++) {
      const p = (z0 + j * step + 0.5) / o.spacing;
      iz[j] = Math.floor(p);
      fz[j] = fade(p - iz[j]!);
    }
    const lx0 = ix[0]!, lz0 = iz[0]!;
    const lw = ix[w - 1]! - lx0 + 2;
    const ld = iz[d - 1]! - lz0 + 2;
    if (lw * ld <= 4 * w * d) {
      // Lattice values covering the region, computed once per octave.
      const lattice = new Float64Array(lw * ld);
      for (let b = 0; b < ld; b++) {
        for (let a = 0; a < lw; a++) lattice[a + lw * b] = hash2(wrapX(o, lx0 + a), lz0 + b, o.seed) - 0.5;
      }
      // Each pair of lattice rows, blended along x once for every sample row between them.
      if (A.length < w) [A, B] = [new Float64Array(w), new Float64Array(w)];
      let blended = -1;
      for (let j = 0; j < d; j++) {
        const row = (iz[j]! - lz0) * lw;
        const tz = fz[j]!;
        if (row !== blended) {
          blended = row;
          for (let i = 0; i < w; i++) {
            const k = row + ix[i]! - lx0;
            const tx = fx[i]!;
            A[i] = lattice[k]! + (lattice[k + 1]! - lattice[k]!) * tx;
            B[i] = lattice[k + lw]! + (lattice[k + lw + 1]! - lattice[k + lw]!) * tx;
          }
        }
        for (let i = 0; i < w; i++) {
          const a = A[i]!, b = B[i]!;
          out[i + w * j]! += (a + (b - a) * tz) * o.weight;
        }
      }
    } else {
      // Sparse samples (step much larger than the lattice): hash corners directly.
      for (let j = 0; j < d; j++) {
        const gz = iz[j]!;
        const tz = fz[j]!;
        for (let i = 0; i < w; i++) {
          const gx0 = wrapX(o, ix[i]!), gx1 = wrapX(o, ix[i]! + 1);
          const tx = fx[i]!;
          const v00 = hash2(gx0, gz, o.seed) - 0.5, v10 = hash2(gx1, gz, o.seed) - 0.5;
          const v01 = hash2(gx0, gz + 1, o.seed) - 0.5, v11 = hash2(gx1, gz + 1, o.seed) - 0.5;
          const a = v00 + (v10 - v00) * tx;
          const b = v01 + (v11 - v01) * tx;
          out[i + w * j]! += (a + (b - a) * tz) * o.weight;
        }
      }
    }
  }
  return out;
}

/**
 * fractalGrid at one sample, the column at (x, z) (units): exactly the value fractalGrid gives for
 * that sample (the same arithmetic, octave by octave), for when only a few samples of a block are
 * wanted.
 */
export function fractalAt(octaves: readonly Octave[], x: number, z: number): number {
  let out = 0;
  for (const o of octaves) {
    const px = (x + 0.5) / o.spacing, pz = (z + 0.5) / o.spacing;
    const ix = Math.floor(px), iz = Math.floor(pz);
    const tx = fade(px - ix), tz = fade(pz - iz);
    const gx0 = o.periodX > 0 ? ((ix % o.periodX) + o.periodX) % o.periodX : ix;
    const gx1 = o.periodX > 0 ? (((ix + 1) % o.periodX) + o.periodX) % o.periodX : ix + 1;
    const v00 = hash2(gx0, iz, o.seed) - 0.5, v10 = hash2(gx1, iz, o.seed) - 0.5;
    const v01 = hash2(gx0, iz + 1, o.seed) - 0.5, v11 = hash2(gx1, iz + 1, o.seed) - 0.5;
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    out += (a + (b - a) * tz) * o.weight;
  }
  return out;
}

/**
 * Ridged gradient noise over a `w x d` grid of columns (sampled like fractalGrid): each octave is
 * Perlin-style gradient noise n, folded into crests as (1 - |n|)^2, and the octaves are averaged
 * by weight. Returns values in [0, 1], high along ridgelines. Gradient noise has no lattice-aligned
 * creases, unlike folded value noise, so ridges follow the noise rather than the grid.
 */
export function ridgedGrid(octaves: readonly Octave[], x0: number, z0: number, w: number, d: number, step = 1): Float64Array {
  const out = new Float64Array(w * d);
  const fx = new Float64Array(w), ux = new Float64Array(w), ix = new Int32Array(w);
  const fz = new Float64Array(d), uz = new Float64Array(d), iz = new Int32Array(d);
  const wrapX = (o: Octave, gx: number) => (o.periodX > 0 ? ((gx % o.periodX) + o.periodX) % o.periodX : gx);
  let wsum = 0;
  for (const o of octaves) {
    wsum += o.weight;
    for (let i = 0; i < w; i++) {
      const p = (x0 + i * step + 0.5) / o.spacing;
      ix[i] = Math.floor(p);
      fx[i] = p - ix[i]!;
      ux[i] = fade(fx[i]!);
    }
    for (let j = 0; j < d; j++) {
      const p = (z0 + j * step + 0.5) / o.spacing;
      iz[j] = Math.floor(p);
      fz[j] = p - iz[j]!;
      uz[j] = fade(fz[j]!);
    }
    const lx0 = ix[0]!, lz0 = iz[0]!;
    const lw = ix[w - 1]! - lx0 + 2, ld = iz[d - 1]! - lz0 + 2;
    // Unit gradients at lattice points (cached for the region when it is small enough).
    const cached = lw * ld <= 4 * w * d;
    const gxs = cached ? new Float64Array(lw * ld) : null, gzs = cached ? new Float64Array(lw * ld) : null;
    if (gxs && gzs) {
      for (let b = 0; b < ld; b++) {
        for (let a = 0; a < lw; a++) {
          const t = hash2(wrapX(o, lx0 + a), lz0 + b, o.seed) * Math.PI * 2;
          gxs[a + lw * b] = Math.cos(t);
          gzs[a + lw * b] = Math.sin(t);
        }
      }
    }
    const corner = (gx: number, gz: number, px: number, pz: number) => {
      const t = hash2(wrapX(o, gx), gz, o.seed) * Math.PI * 2;
      return Math.cos(t) * px + Math.sin(t) * pz;
    };
    const wt = o.weight;
    for (let j = 0; j < d; j++) {
      const gz = iz[j]!, tz = fz[j]!, vz = uz[j]!, row = lw * (gz - lz0);
      for (let i = 0; i < w; i++) {
        const gx = ix[i]!, tx = fx[i]!, vx = ux[i]!;
        let n00: number, n10: number, n01: number, n11: number;
        if (gxs && gzs) {
          const k = gx - lx0 + row;
          n00 = gxs[k]! * tx + gzs[k]! * tz;
          n10 = gxs[k + 1]! * (tx - 1) + gzs[k + 1]! * tz;
          n01 = gxs[k + lw]! * tx + gzs[k + lw]! * (tz - 1);
          n11 = gxs[k + lw + 1]! * (tx - 1) + gzs[k + lw + 1]! * (tz - 1);
        } else {
          n00 = corner(gx, gz, tx, tz);
          n10 = corner(gx + 1, gz, tx - 1, tz);
          n01 = corner(gx, gz + 1, tx, tz - 1);
          n11 = corner(gx + 1, gz + 1, tx - 1, tz - 1);
        }
        const a = n00 + (n10 - n00) * vx;
        const b = n01 + (n11 - n01) * vx;
        // 2D gradient noise stays within about +-0.7; scale to about +-1 before folding.
        const v = a + (b - a) * vz;
        const nAbs = Math.min(1, (v < 0 ? -v : v) / 0.7);
        out[i + w * j]! += wt * (1 - nAbs) * (1 - nAbs);
      }
    }
  }
  if (wsum > 0) for (let k = 0; k < out.length; k++) out[k] = out[k]! / wsum;
  return out;
}
