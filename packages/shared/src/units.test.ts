import { describe, expect, it } from 'vitest';
import { breakSizesFor, isValidVoxelSize, metersToUnits, unitsToMeters } from './units.js';

describe('voxel sizes', () => {
  it('accepts exactly the integers 1..16', () => {
    for (let s = 1; s <= 16; s++) expect(isValidVoxelSize(s)).toBe(true);
    for (const s of [0, 17, -1, 1.5, NaN, Infinity]) expect(isValidVoxelSize(s)).toBe(false);
  });

  it('lists proper divisors as break sizes', () => {
    expect(breakSizesFor(16)).toEqual([1, 2, 4, 8]);
    expect(breakSizesFor(12)).toEqual([1, 2, 3, 4, 6]);
    expect(breakSizesFor(15)).toEqual([1, 3, 5]);
    expect(breakSizesFor(13)).toEqual([1]);
    expect(breakSizesFor(1)).toEqual([]);
  });

  it('rejects invalid sizes', () => {
    expect(() => breakSizesFor(0)).toThrow(RangeError);
    expect(() => breakSizesFor(17)).toThrow(RangeError);
  });
});

describe('unit conversion', () => {
  it('round-trips lattice values', () => {
    expect(metersToUnits(1)).toBe(16);
    expect(metersToUnits(0.0625)).toBe(1);
    expect(metersToUnits(16000)).toBe(256000);
    expect(unitsToMeters(256000)).toBe(16000);
  });

  it('rejects off-lattice meters', () => {
    expect(() => metersToUnits(0.1)).toThrow(RangeError);
  });
});
