import { describe, expect, it } from 'vitest';
import { fractalGrid, ridgedGrid, type Octave } from './noise.js';

const oct = (spacing: number, seed = 1, periodX = 0): Octave => ({ spacing, weight: 1, periodX, seed });

describe('ridgedGrid', () => {
  it('stays within 0..1, is deterministic, and depends on the seed', () => {
    const a = ridgedGrid([oct(64), oct(32)], -500, 300, 64, 64, 3);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(ridgedGrid([oct(64), oct(32)], -500, 300, 64, 64, 3)).toEqual(a);
    expect(ridgedGrid([oct(64, 2), oct(32, 2)], -500, 300, 64, 64, 3)).not.toEqual(a);
  });

  it('samples a block exactly like single columns (cached and uncached lattices agree)', () => {
    const os = [oct(256), oct(64), oct(16)];
    for (const step of [1, 7, 500]) {
      const block = ridgedGrid(os, 1000, -2000, 8, 8, step);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        expect(block[i + 8 * j]).toBeCloseTo(ridgedGrid(os, 1000 + i * step, -2000 + j * step, 1, 1)[0]!, 12);
      }
    }
  });

  it('wraps with a period along X', () => {
    const o = oct(100, 3, 20); // repeats every 2000 units
    const a = ridgedGrid([o], 0, 50, 40, 4, 5), b = ridgedGrid([o], 2000, 50, 40, 4, 5);
    a.forEach((v, k) => expect(v).toBeCloseTo(b[k]!, 12));
  });

  it('has no creases along lattice lines (unlike folded value noise)', () => {
    // Mean value exactly on lattice lines vs. between them. Folded value noise is systematically
    // different on lines (its creases sit there); gradient noise is zero at lattice points, so
    // ridges cross lines freely and the two means stay close.
    const S = 64, N = 4096;
    const R = ridgedGrid([oct(S)], -0.5, 0, N, 64, 1);
    const V = fractalGrid([oct(S)], -0.5, 0, N, 64, 1).map((v) => (1 - Math.abs(v * 2)) ** 2);
    const meanAt = (arr: Float64Array, pred: (x: number) => boolean) => {
      let s = 0, n = 0;
      for (let j = 0; j < 64; j++) for (let i = 0; i < N; i++) if (pred(i)) (s += arr[i + N * j]!), n++;
      return s / n;
    };
    const isLine = (x: number) => x % S === 0, isMid = (x: number) => x % S === S / 2;
    const gradientGap = Math.abs(meanAt(R, isLine) - meanAt(R, isMid));
    const valueGap = Math.abs(meanAt(V, isLine) - meanAt(V, isMid));
    expect(gradientGap).toBeLessThan(valueGap);
  });
});

describe('fractalAt', () => {
  it('gives exactly what fractalGrid gives at each sample, wrapping or not, any step', async () => {
    const { fractalAt, fractalGrid } = await import('./noise.js');
    const octaves = [
      { spacing: 4096, weight: 1, periodX: 0, seed: 11 },
      { spacing: 512, weight: 0.5, periodX: 8, seed: 12 },
      { spacing: 64, weight: 0.25, periodX: 0, seed: 13 },
      { spacing: 3, weight: 0.1, periodX: 0, seed: 14 },
    ];
    for (const [x0, z0, w, d, step] of [[0, 0, 40, 30, 1], [-517, 9001, 33, 17, 7], [4090, -3, 12, 12, 256], [123456, 65432, 64, 64, 16]] as const) {
      const grid = fractalGrid(octaves, x0, z0, w, d, step);
      for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) expect(fractalAt(octaves, x0 + i * step, z0 + j * step)).toBe(grid[i + w * j]);
    }
  });
});
