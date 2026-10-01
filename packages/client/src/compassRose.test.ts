import { describe, expect, it } from 'vitest';
import { roseRotation } from './compassRose.js';

describe('roseRotation', () => {
  it('turns the rose so N points to world north', () => {
    expect(roseRotation(0)).toBe(0); // facing north: N at the top
    expect(roseRotation(-Math.PI / 2)).toBeCloseTo(-90); // facing east: N on the left
    expect(roseRotation(Math.PI / 2)).toBeCloseTo(90); // facing west: N on the right
    expect(Math.abs(roseRotation(Math.PI))).toBeCloseTo(180); // facing south: N at the bottom
    expect(roseRotation(2 * Math.PI - Math.PI / 2)).toBeCloseTo(-90); // wraps
  });
});
