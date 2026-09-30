import { describe, expect, it } from 'vitest';
import { NO_GROUND, TILE_SAMPLES, tileStep, type Tile } from '@super-vox/shared';
import { packQuads } from './mesher.js';
import { meshTile, skirtDepth } from './tileMesher.js';

const n = TILE_SAMPLES;

function tile(level: number, f: (i: number, j: number) => number): Tile {
  const heights = new Int16Array(n * n);
  const materials = new Uint16Array(n * n).fill(3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + n * j] = f(i, j);
  return { level, tx: 0, tz: 0, heights, materials };
}

/** Sums quad area per direction. */
function areaByDir(quads: { dir: number; du: number; dv: number }[]): number[] {
  const a = [0, 0, 0, 0, 0, 0];
  for (const q of quads) a[q.dir]! += q.du * q.dv;
  return a;
}

describe('meshTile', () => {
  it('merges a flat tile into one top face plus four skirts', () => {
    const m = meshTile(tile(2, () => 100))!;
    const step = tileStep(2);
    expect(m.baseY).toBe(100 - skirtDepth(2));
    expect(m.quads.filter((q) => q.dir === 2)).toEqual([
      { dir: 2, plane: skirtDepth(2), u: 0, v: 0, du: n * step, dv: n * step, material: 3, size: 16 },
    ]);
    expect(m.quads.filter((q) => q.dir !== 2)).toHaveLength(4);
    expect(areaByDir(m.quads)).toEqual([n * step * skirtDepth(2), n * step * skirtDepth(2), n * n * step * step, 0, n * step * skirtDepth(2), n * step * skirtDepth(2)]);
  });

  it('builds exactly the walls a heightfield needs', () => {
    const f = (i: number, j: number) => ((i * 7 + j * 13) % 11) * 5 - 20;
    const level = 3;
    const m = meshTile(tile(level, f))!;
    const step = tileStep(level), skirt = skirtDepth(level);
    // Expected wall area per direction: drops to lower in-tile neighbours plus skirts at the tile edge.
    const expected = [0, 0, n * n * step * step, 0, 0, 0];
    const sides = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]] as const;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        for (const [di, dj, dir] of sides) {
          const ii = i + di, jj = j + dj;
          const drop = ii < 0 || jj < 0 || ii >= n || jj >= n ? skirt : Math.max(0, f(i, j) - f(ii, jj));
          expected[dir]! += drop * step;
        }
      }
    }
    expect(areaByDir(m.quads)).toEqual(expected);
    // Top faces sit at each cell's height.
    for (const q of m.quads.filter((q) => q.dir === 2)) {
      for (let u = q.u; u < q.u + q.du; u += step) {
        for (let v = q.v; v < q.v + q.dv; v += step) expect(q.plane + m.baseY).toBe(f(v / step, u / step));
      }
    }
  });

  it('skips cells outside the world and walls them off', () => {
    const m = meshTile(tile(1, (i) => (i >= 20 ? NO_GROUND : 50)))!;
    const step = tileStep(1);
    expect(areaByDir(m.quads)[2]).toBe(20 * n * step * step);
    // Cells at i = 19 face the missing ground with a skirt on +X.
    expect(m.quads.some((q) => q.dir === 0 && q.plane === 20 * step)).toBe(true);
    expect(meshTile(tile(1, () => NO_GROUND))).toBeNull();
  });

  it('fits the packed vertex format at every level', () => {
    for (const level of [1, 6]) {
      const m = meshTile(tile(level, (i, j) => (i * j) % 300 - 150))!;
      const buf = packQuads(m.quads);
      for (const q of m.quads) {
        expect(q.plane).toBeLessThanOrEqual(0xffff);
        expect(Math.max(q.u + q.du, q.v + q.dv)).toBeLessThanOrEqual(0xffff);
        expect(Math.min(q.u, q.v, q.plane)).toBeGreaterThanOrEqual(0);
      }
      expect(buf.quadCount).toBe(m.quads.length);
    }
  });
});
