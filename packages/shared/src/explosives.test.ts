import { describe, expect, it } from 'vitest';
import { openDirection } from './explosives.js';

const R = 64; // a 1 m TNT's blast (4 m)
const angle = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!))) * 180) / Math.PI;

describe('openDirection', () => {
  it('is up on open ground', () => {
    const d = openDirection((_x, y) => y < 0, 0, 8, 0, R);
    expect(angle(d, [0, 1, 0])).toBeLessThan(5);
  });

  it('is out of a wall, for TNT dug into it', () => {
    // A wall (cliff) filling x < 0, its face at x = 0; the TNT 1 m in.
    const d = openDirection((x) => x < 0, -16, 200, 0, R);
    expect(angle(d, [1, 0, 0])).toBeLessThan(10);
    // Into a wall on the ground (solid below y = 0 too): out and up, between them.
    const e = openDirection((x, y) => x < 0 || y < 0, -16, 8, 0, R);
    expect(angle(e, [Math.SQRT1_2, Math.SQRT1_2, 0])).toBeLessThan(15);
  });

  it('is up a shaft, and up when buried (nowhere better) or floating (everywhere as good)', () => {
    // Solid all round but a 2 m shaft up from the TNT.
    const shaft = (x: number, _y: number, z: number, y = _y) => !(Math.abs(x) < 16 && Math.abs(z) < 16 && y > -16);
    expect(angle(openDirection(shaft, 0, -64, 0, R), [0, 1, 0])).toBeLessThan(5);
    expect(openDirection(() => true, 0, 0, 0, R)).toEqual([0, 1, 0]);
    expect(openDirection(() => false, 0, 0, 0, R)).toEqual([0, 1, 0]);
  });

  it('finds a crack: open only to one side (-z) through a narrow gap', () => {
    // Solid everywhere except a 4 m wide slot from the TNT out toward -z.
    const d = openDirection((x, y, z) => !(Math.abs(x) < 32 && Math.abs(y) < 32 && z < 8), 0, 0, 0, R);
    expect(angle(d, [0, 0, -1])).toBeLessThan(15);
  });
});
