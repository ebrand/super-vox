import { describe, expect, it } from 'vitest';
import { entityBrightness, interpolate, rayBox } from './entities.js';

const snap = (x: number, yaw: number) => ({ id: 1, kind: 'pig' as const, x, y: 0, z: 0, yaw });

describe('entities', () => {
  it('move smoothly between snapshots, turning the short way round', () => {
    expect(interpolate(snap(0, 0), snap(16, 0), 0.25).x).toBe(4);
    expect(interpolate(snap(0, 0), snap(16, 0), 2).x).toBe(16); // held at the latest
    const turn = interpolate(snap(0, 3), snap(0, -3), 0.5); // across ±π: about π, not 0
    expect(Math.abs(Math.abs(turn.yaw) - Math.PI)).toBeLessThan(0.15);
  });

  it('are picked by a ray where it enters their box, not behind or past it', () => {
    const min = [10, 0, -5], max = [20, 10, 5];
    expect(rayBox([0, 5, 0], [1, 0, 0], min, max)).toBe(10);
    expect(rayBox([0, 5, 0], [-1, 0, 0], min, max)).toBeNull(); // behind
    expect(rayBox([0, 50, 0], [1, 0, 0], min, max)).toBeNull(); // above
    expect(rayBox([15, 5, 0], [1, 0, 0], min, max)).toBe(0); // inside
  });
});

describe('entityBrightness', () => {
  it('is full in daylight under the sky, dark in a cave, lit by a torch, and dim at night', () => {
    expect(entityBrightness(15, 0, 1)).toBe(1);
    expect(entityBrightness(0, 0, 1)).toBeLessThan(0.01);
    expect(entityBrightness(0, 14, 1)).toBeCloseTo(0.7);
    expect(entityBrightness(15, 0, 0.15)).toBeCloseTo(0.15);
    expect(entityBrightness(15, 14, 0.15)).toBeCloseTo(0.7);
    // Further from the torch, darker.
    expect(entityBrightness(0, 8, 1)).toBeLessThan(entityBrightness(0, 12, 1));
  });
});
