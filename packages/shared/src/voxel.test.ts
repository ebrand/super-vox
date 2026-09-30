import { describe, expect, it } from 'vitest';
import { breakVoxel, validateVoxel, voxelFitsInBlock, type Voxel } from './voxel.js';

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

describe('1 m gridline rule', () => {
  it('accepts voxels inside one block, including at negative coordinates', () => {
    expect(voxelFitsInBlock(0, 0, 0, 16)).toBe(true);
    expect(voxelFitsInBlock(-16, -32, 16, 16)).toBe(true);
    expect(voxelFitsInBlock(4, 4, 4, 12)).toBe(true);
    expect(voxelFitsInBlock(15, 15, 15, 1)).toBe(true);
    expect(voxelFitsInBlock(-1, -1, -1, 1)).toBe(true);
    expect(voxelFitsInBlock(-12, 0, 0, 12)).toBe(true);
  });

  it('rejects voxels that cross a gridline on any axis', () => {
    expect(voxelFitsInBlock(1, 0, 0, 16)).toBe(false);
    expect(voxelFitsInBlock(0, 5, 0, 12)).toBe(false);
    expect(voxelFitsInBlock(0, 0, 15, 2)).toBe(false);
    expect(voxelFitsInBlock(-1, 0, 0, 2)).toBe(false);
    expect(voxelFitsInBlock(-11, 0, 0, 12)).toBe(false);
    expect(voxelFitsInBlock(0.5, 0, 0, 1)).toBe(false);
  });

  it('agrees with a brute-force block check for every offset and size', () => {
    for (let size = 1; size <= 16; size++) {
      for (let x = -40; x < 40; x++) {
        const fits = Math.floor(x / 16) === Math.floor((x + size - 1) / 16);
        expect(voxelFitsInBlock(x, 0, 0, size)).toBe(fits);
      }
    }
  });

  it('validateVoxel and breakVoxel refuse gridline-crossing voxels', () => {
    const crossing: Voxel = { x: 8, y: 0, z: 0, size: 12, material: 1 };
    expect(() => validateVoxel(crossing)).toThrow(/gridline/);
    expect(() => breakVoxel(crossing, 4)).toThrow(/gridline/);
    expect(() => validateVoxel({ x: 4, y: 0, z: 0, size: 12, material: 1 })).not.toThrow();
  });
});
