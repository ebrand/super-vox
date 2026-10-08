import { describe, expect, it } from 'vitest';
import { DROP, canPickUp, restingY } from './drops.js';

describe('dropped things', () => {
  it('come to rest on the ground under them', () => {
    const ground = (_x: number, y: number) => y < 32;
    expect(restingY(5, 100, 5, ground)).toBe(32);
    expect(restingY(5, 32, 5, ground)).toBe(32);
    // Nothing under them for 8 m: where they are.
    expect(restingY(5, 300, 5, ground)).toBe(300);
  });

  it('are picked up by feet near enough (across, and up or down a little)', () => {
    const d = { x: 0, y: 0, z: 0 };
    expect(canPickUp(d, DROP.reach - 1, 0, 0)).toBe(true);
    expect(canPickUp(d, DROP.reach + 1, 0, 0)).toBe(false);
    expect(canPickUp(d, 0, DROP.reachUp - 1, 0)).toBe(true);
    expect(canPickUp(d, 0, -DROP.reachUp - 1, 0)).toBe(false);
  });
});
