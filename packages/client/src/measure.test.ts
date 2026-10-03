import { describe, expect, it } from 'vitest';
import { describeMeasure } from './diorama.js';

describe('describeMeasure', () => {
  it('gives the distance across the ground, and the rise or fall with its slope', () => {
    expect(describeMeasure({ x: 0, y: 10, z: 0 }, { x: 30, y: 10, z: 40 })).toBe('50.0 m · level');
    expect(describeMeasure({ x: 0, y: 10, z: 0 }, { x: 100, y: 15, z: 0 })).toBe('100.0 m · rise +5.0 m (5.0%)');
    expect(describeMeasure({ x: 0, y: 15, z: 0 }, { x: 100, y: 10, z: 0 })).toBe('100.0 m · fall −5.0 m (5.0%)');
    expect(describeMeasure({ x: 0, y: 0, z: 0 }, { x: 1234.5, y: 0, z: 0 })).toBe('1.23 km · level');
    expect(describeMeasure({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 })).toBe('0 m');
    // Straight up a cliff: no slope to give.
    expect(describeMeasure({ x: 0, y: 0, z: 0 }, { x: 0, y: 8, z: 0 })).toBe('0.0 m · rise +8.0 m');
  });
});
