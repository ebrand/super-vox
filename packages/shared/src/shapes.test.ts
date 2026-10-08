import { describe, expect, it } from 'vitest';
import { roundCells, type RoundSpec } from './shapes.js';

/** Round shapes as they were first worked out: every cell in the box round them, tried one by one. */
function bruteRound(r: RoundSpec): string[] {
  const out: string[] = [];
  const keys = ['x', 'y', 'z'] as const, ax = keys[r.axis];
  const eps = 1e-6, outer2 = r.outer * r.outer + eps;
  const inner = r.thickness === null ? -1 : r.outer - r.thickness, inner2 = inner > 0 ? inner * inner + eps : -1;
  const lo = (v: number) => Math.floor((v - r.outer) / r.size) * r.size, hi = (v: number) => Math.floor((v + r.outer) / r.size) * r.size;
  const layer = Math.floor(r.centre[ax] / r.size) * r.size;
  const range = (k: (typeof keys)[number]) => (k === ax && r.kind === 'circle' ? [layer, layer] : [lo(r.centre[k]), hi(r.centre[k])]);
  const [x0, x1] = range('x'), [y0, y1] = range('y'), [z0, z1] = range('z');
  for (let y = y0!; y <= y1!; y += r.size)
    for (let z = z0!; z <= z1!; z += r.size)
      for (let x = x0!; x <= x1!; x += r.size) {
        const d = { x: x + r.size / 2 - r.centre.x, y: y + r.size / 2 - r.centre.y, z: z + r.size / 2 - r.centre.z };
        if (r.kind === 'dome' && d[ax] * r.sign < -r.size / 2 + eps) continue;
        const d2 = keys.reduce((s, k) => s + (r.kind === 'circle' && k === ax ? 0 : d[k] * d[k]), 0);
        if (d2 > outer2) continue;
        if (inner2 >= 0 && d2 <= inner2) continue;
        out.push(`${x},${y},${z}`);
      }
  return out.sort();
}

describe('round shapes', () => {
  it('are worked out a column at a time, the same cells as trying every one', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 600; i++) {
      const size = [1, 2, 4, 8, 16][Math.floor(rnd() * 5)]!;
      const at = () => Math.floor(rnd() * 40) * size + (rnd() < 0.5 ? size / 2 : 0);
      const spec: RoundSpec = {
        kind: (['circle', 'dome', 'sphere'] as const)[Math.floor(rnd() * 3)]!,
        centre: { x: at(), y: at(), z: at() },
        axis: Math.floor(rnd() * 3) as 0 | 1 | 2,
        sign: rnd() < 0.5 ? 1 : -1,
        outer: rnd() < 0.5 ? (Math.floor(rnd() * 12) + 0.5) * size : rnd() * 12 * size + 0.01,
        thickness: rnd() < 0.5 ? null : size * (1 + Math.floor(rnd() * 3)),
        size,
      };
      const fast = roundCells(spec).map((c) => `${c.x},${c.y},${c.z}`).sort();
      expect(fast, JSON.stringify(spec)).toEqual(bruteRound(spec));
    }
  });
});
