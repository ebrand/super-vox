import { describe, expect, it } from 'vitest';
import { breakVoxel, type Voxel } from './voxel.js';

const cube = (size: number): Voxel => ({ x: 32, y: -16, z: 48, size, material: 7 });

/** Total volume and exact coverage: every unit cell of the parent is hit exactly once. */
function assertExactTiling(parent: Voxel, pieces: Voxel[]): void {
  const seen = new Set<string>();
  for (const p of pieces) {
    expect(p.material).toBe(parent.material);
    for (let i = 0; i < p.size; i++)
      for (let j = 0; j < p.size; j++)
        for (let k = 0; k < p.size; k++) {
          const x = p.x + i, y = p.y + j, z = p.z + k;
          expect(x >= parent.x && x < parent.x + parent.size).toBe(true);
          expect(y >= parent.y && y < parent.y + parent.size).toBe(true);
          expect(z >= parent.z && z < parent.z + parent.size).toBe(true);
          const key = `${x},${y},${z}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
  }
  expect(seen.size).toBe(parent.size ** 3);
}

describe('breakVoxel', () => {
  it('tiles every valid (size, divisor) pair exactly', () => {
    for (let size = 2; size <= 16; size++) {
      for (let piece = 1; piece < size; piece++) {
        if (size % piece !== 0) continue;
        const parent = cube(size);
        const pieces = breakVoxel(parent, piece);
        expect(pieces).toHaveLength((size / piece) ** 3);
        assertExactTiling(parent, pieces);
      }
    }
  });

  it('refuses non-divisor, equal, and larger sizes', () => {
    expect(() => breakVoxel(cube(16), 3)).toThrow(RangeError);
    expect(() => breakVoxel(cube(16), 16)).toThrow(RangeError);
    expect(() => breakVoxel(cube(8), 16)).toThrow(RangeError);
    expect(() => breakVoxel(cube(1), 1)).toThrow(RangeError);
    expect(() => breakVoxel(cube(17), 1)).toThrow(RangeError);
  });
});
