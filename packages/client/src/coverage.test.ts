import { describe, expect, it } from 'vitest';
import { overlaps, staleToRetire, type Footprint } from './coverage.js';

const f = (x0: number, z0: number, x1: number, z1: number): Footprint => ({ x0, z0, x1, z1 });

describe('stale mesh retirement', () => {
  it('overlaps only when areas share ground (touching edges is not overlapping)', () => {
    expect(overlaps(f(0, 0, 10, 10), f(5, 5, 15, 15))).toBe(true);
    expect(overlaps(f(0, 0, 10, 10), f(10, 0, 20, 10))).toBe(false);
    expect(overlaps(f(0, 0, 10, 10), f(2, 2, 3, 3))).toBe(true);
  });

  it('drops a replaced mesh once its ground is drawn again, or when it is too old, never before', () => {
    const since = new Map([['a', 0], ['b', 100], ['c', 200]]);
    const where = new Map([['a', f(0, 0, 16, 16)], ['b', f(16, 0, 32, 16)], ['c', f(32, 0, 48, 16)]]);
    // Only the middle one's ground is drawn again.
    const covered = (g: Footprint) => g.x0 === 16;
    expect(staleToRetire(since.keys(), (k) => since.get(k)!, (k) => where.get(k)!, covered, 30_000, 1000)).toEqual(['b']);
    // Long after: all of them, covered or not.
    expect(staleToRetire(since.keys(), (k) => since.get(k)!, (k) => where.get(k)!, covered, 30_000, 30_150)).toEqual(['a', 'b']);
  });
});
