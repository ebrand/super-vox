import { describe, expect, it } from 'vitest';
import { craterShape, openDirection } from './explosives.js';

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

describe('craterShape', () => {
  it('without a seed, is the sphere', () => {
    const c = craterShape(64);
    expect(c.contains(0, -64, 0)).toBe(true);
    expect(c.contains(0, -64.01, 0)).toBe(false);
    expect(c.classify(-8, -8, -8, 16)).toBe(1);
    expect(c.classify(60, 0, 0, 16)).toBe(0);
    expect(c.classify(70, 0, 0, 16)).toBe(-1);
  });

  it('with one, has lobes and rough walls: the same for the same seed, within its bounds', () => {
    const c = craterShape(128, 7), again = craterShape(128, 7), other = craterShape(128, 8);
    const reaches: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.399963, y = 1 - (2 * (i + 0.5)) / 2000, r = Math.sqrt(1 - y * y);
      const v = [Math.cos(a) * r * 50, y * 50, Math.sin(a) * r * 50] as const;
      const reach = c.reach(...v);
      expect(reach).toBe(again.reach(...v));
      expect(reach).toBeGreaterThanOrEqual(c.inner);
      expect(reach).toBeLessThanOrEqual(c.outer);
      reaches.push(reach);
    }
    // Not round: well short of the radius one way, well past it another, and a good spread between.
    reaches.sort((p, q) => p - q);
    expect(reaches[0]!).toBeLessThan(128 * 0.85);
    expect(reaches.at(-1)!).toBeGreaterThan(128 * 1.15);
    expect(reaches[1800]! - reaches[200]!).toBeGreaterThan(128 * 0.25);
    expect(reaches.some((r, i) => r !== other.reach(Math.cos(i * 2.399963) * 50, 0, Math.sin(i * 2.399963) * 50))).toBe(true);
  });

  it('never calls a box all in or all out when part of it is the other', () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (const radius of [18, 64, 128, 256]) {
      const c = craterShape(radius, 1234 + radius);
      const counts = { in: 0, out: 0, edge: 0 };
      for (let n = 0; n < 12000; n++) {
        const size = [1, 2, 4, 8, 16][Math.floor(rand() * 5)]!;
        // Mostly right at the crater's wall (where it's hard to tell), some anywhere.
        let dx: number, dy: number, dz: number;
        if (n % 4) {
          const u = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1], l = Math.hypot(u[0]!, u[1]!, u[2]!) || 1;
          const at = c.reach(u[0]!, u[1]!, u[2]!) + (rand() * 2 - 1) * size * 2;
          [dx, dy, dz] = [(u[0]! / l) * at - size / 2, (u[1]! / l) * at - size / 2, (u[2]! / l) * at - size / 2];
        } else {
          const span = c.outer * 1.2;
          [dx, dy, dz] = [(rand() * 2 - 1) * span, (rand() * 2 - 1) * span, (rand() * 2 - 1) * span];
        }
        const k = c.classify(dx, dy, dz, size);
        if (k === 0) {
          counts.edge++;
          continue;
        }
        counts[k === 1 ? 'in' : 'out']++;
        for (let s = 0; s < 27; s++) {
          const p = [dx + ((s % 3) / 2) * size, dy + ((Math.floor(s / 3) % 3) / 2) * size, dz + (Math.floor(s / 9) / 2) * size] as const;
          expect(c.contains(...p)).toBe(k === 1);
        }
      }
      expect(counts.in).toBeGreaterThan(0);
      expect(counts.out).toBeGreaterThan(0);
    }
  });
});

