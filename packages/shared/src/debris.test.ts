import { describe, expect, it } from 'vitest';
import { DEBRIS_FPS, DEBRIS_MAX_SECONDS, packDebris, throwDebris, unpackDebris } from './debris.js';

/** Flat ground: solid below y = 0 (units). */
const ground = (_x: number, y: number) => y < 0;

describe('throwDebris', () => {
  it('flies, falls, bounces and slides to rest on the ground, never through it', () => {
    const f = throwDebris([0, 64, 0], 8, [6, 8, 0], ground);
    expect(f.rested).toBe(true);
    for (const [, y] of f.path) expect(y).toBeGreaterThanOrEqual(-1e-6);
    const end = f.path.at(-1)!;
    expect(end[1]).toBeCloseTo(0, 6);
    // Thrown up and out: it got higher first, and ended well away along x.
    expect(Math.max(...f.path.map((p) => p[1]))).toBeGreaterThan(64);
    expect(end[0]).toBeGreaterThan(5 * 16);
    expect(f.path.length).toBeLessThan(DEBRIS_MAX_SECONDS * DEBRIS_FPS);
  });

  it('bounces off a wall in its way', () => {
    // A wall at x >= 32 (2 m), as tall as anything.
    const walled = (x: number, y: number) => y < 0 || x >= 32;
    const f = throwDebris([0, 0, 0], 8, [10, 2, 0], walled);
    for (const [x] of f.path) expect(x + 8).toBeLessThanOrEqual(32 + 1e-6);
    expect(f.path.at(-1)![0]).toBeLessThan(24);
  });

  it('stops where it is after the longest flight, falling forever', () => {
    const f = throwDebris([0, 0, 0], 8, [0, 0, 0], () => false);
    expect(f.rested).toBe(false);
    expect(f.path.length).toBe(DEBRIS_MAX_SECONDS * DEBRIS_FPS + 1);
  });

  it('packs a flight small and back again (to whole units)', () => {
    const f = throwDebris([100, 64, -40], 8, [3, 6, -2], ground);
    const piece = packDebris(4, 8, f);
    expect(piece.p.length).toBe(f.path.length * 3);
    const back = unpackDebris(piece);
    back.forEach((q, i) => q.forEach((v, a) => expect(Math.abs(v - f.path[i]![a]!)).toBeLessThanOrEqual(0.5 + 1e-9)));
  });
});
