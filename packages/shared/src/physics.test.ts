import { describe, expect, it } from 'vitest';
import { PLAYER, intersectsSolid, moveAabb, playerBox, sweepAxis, type Aabb } from './physics.js';
import type { SolidAt } from './physics.js';

/** Flat ground: every cell with y < 0 is solid. Plus extra solid boxes. */
function world(...boxes: [number, number, number, number, number, number][]): SolidAt {
  return (x, y, z) => y < 0 || boxes.some(([x0, y0, z0, x1, y1, z1]) => x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1);
}

const box = (x: number, y: number, z: number, w = 10, h = 29): Aabb => ({ min: [x, y, z], max: [x + w, y + h, z + w] });

describe('playerBox', () => {
  it('puts the feet PLAYER.eye below the eye and centres the box on it', () => {
    const b = playerBox([100, 50, -20]);
    expect(b.min[1]).toBeCloseTo(50 - PLAYER.eye, 12);
    expect(b.max[1] - b.min[1]).toBeCloseTo(PLAYER.height, 12);
    expect((b.min[0] + b.max[0]) / 2).toBe(100);
    expect(b.max[2] - b.min[2]).toBeCloseTo(PLAYER.width, 12);
  });
});

describe('sweepAxis', () => {
  const w = world();
  it('stops a falling box exactly on the ground', () => {
    expect(sweepAxis(box(0.3, 5.5, 0.3), 1, -100, w)).toBeCloseTo(-5.5, 12);
    expect(sweepAxis(box(0.3, 0, 0.3), 1, -1, w)).toBe(0); // already resting
    expect(sweepAxis(box(0.3, 5.5, 0.3), 1, -3, w)).toBe(-3); // not far enough to touch
  });

  it('stops at walls in both directions, including at negative coordinates', () => {
    const wall = world([20, 0, -50, 22, 100, 50], [-30, 0, -50, -28, 100, 50]);
    expect(sweepAxis(box(5.5, 0, 0), 0, 50, wall)).toBeCloseTo(20 - 15.5, 12);
    expect(sweepAxis(box(-10.25, 0, 0), 0, -50, wall)).toBeCloseTo(-28 - -10.25, 12);
  });

  it('does not tunnel through a 1/16 m wall at any speed', () => {
    const thin = world([100, 0, -50, 101, 100, 50]);
    expect(sweepAxis(box(0, 0, 0), 0, 1e5, thin)).toBe(90);
  });

  it('treats unloaded cells as empty', () => {
    const unloaded: SolidAt = (_x, y) => (y < 0 ? undefined : false);
    expect(sweepAxis(box(0, 5, 0), 1, -100, unloaded)).toBe(-100);
  });
});

describe('moveAabb', () => {
  it('slides along a wall when moving diagonally into it', () => {
    const w = world([20, 0, -100, 22, 100, 100]);
    const r = moveAabb(box(5, 0, 0), [30, 0, 12], w);
    expect(r.delta[0]).toBeCloseTo(5, 12);
    expect(r.delta[2]).toBe(12);
    expect(r.blocked).toEqual([true, false, false]);
  });

  it('lands on the ground and reports it blocked vertically', () => {
    const r = moveAabb(box(0, 3, 0), [0, -10, 0], world());
    expect(r.delta[1]).toBeCloseTo(-3, 12);
    expect(r.blocked[1]).toBe(true);
  });

  it('bumps its head on a ceiling', () => {
    const r = moveAabb(box(0, 0, 0), [0, 20, 0], world([-50, 35, -50, 50, 40, 50]));
    expect(r.delta[1]).toBeCloseTo(35 - 29, 12);
  });

  it('climbs a 1/4 m ledge but not a 1 m wall', () => {
    const ledge = world([20, 0, -100, 60, 4, 100]);
    const up = moveAabb(box(8, 0, 0), [6, 0, 0], ledge);
    expect(up.delta[0]).toBe(6);
    expect(up.delta[1]).toBe(4); // now standing on top of the ledge
    const wall = world([20, 0, -100, 60, 16, 100]);
    const stuck = moveAabb(box(8, 0, 0), [6, 0, 0], wall);
    expect(stuck.delta[0]).toBe(2);
    expect(stuck.delta[1]).toBe(0);
    expect(stuck.blocked[0]).toBe(true);
  });

  it('does not step up where there is no headroom', () => {
    const lowCeiling = world([20, 0, -100, 60, 4, 100], [-100, 30, -100, 100, 40, 100]);
    const r = moveAabb(box(8, 0, 0), [6, 0, 0], lowCeiling);
    expect(r.delta[0]).toBe(2);
    expect(r.delta[1]).toBe(0);
  });

  it('lets a box that is already inside solid move freely, so it can escape', () => {
    const w = world();
    expect(intersectsSolid(box(0, -5, 0), w)).toBe(true);
    expect(moveAabb(box(0, -5, 0), [0, 10, 3], w).delta).toEqual([0, 10, 3]);
  });

  it('never ends a random move inside solid', () => {
    let s = 3;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const w = world([10, 0, 10, 14, 3, 14], [30, 0, -20, 31, 60, 40], [-40, 12, -40, 40, 13, 40], [5, 0, -5, 9, 20, 30]);
    // Start standing on the floating floor (y 12..13), clear of everything.
    let b = box(-20.3, 13, -20.7);
    expect(intersectsSolid(b, w)).toBe(false);
    for (let i = 0; i < 3000; i++) {
      const d: [number, number, number] = [(rand() - 0.5) * 12, (rand() - 0.5) * 12, (rand() - 0.5) * 12];
      const r = moveAabb(b, d, w);
      b = { min: [b.min[0] + r.delta[0], b.min[1] + r.delta[1], b.min[2] + r.delta[2]], max: [b.max[0] + r.delta[0], b.max[1] + r.delta[1], b.max[2] + r.delta[2]] };
      expect(intersectsSolid(b, w)).toBe(false);
    }
  });
});
