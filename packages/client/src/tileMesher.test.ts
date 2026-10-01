import { describe, expect, it } from 'vitest';
import { Material, NO_GROUND, TILE_SAMPLES, tileStep, type Tile } from '@super-vox/shared';
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
    const step = tileStep(level);
    // Expected wall area per direction: drops to lower in-tile neighbours, plus skirts at the tile
    // edge reaching down to the tile's base.
    const expected = [0, 0, n * n * step * step, 0, 0, 0];
    const sides = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]] as const;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        for (const [di, dj, dir] of sides) {
          const ii = i + di, jj = j + dj;
          const drop = ii < 0 || jj < 0 || ii >= n || jj >= n ? f(i, j) - m.baseY : Math.max(0, f(i, j) - f(ii, jj));
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

  it('walls tall edge columns (forest canopy) all the way down, leaving no opening', () => {
    // One 20 m column of canopy on the tile's east edge, the rest ground at 0.
    const level = 2, step = tileStep(level);
    const m = meshTile(tile(level, (i, j) => (i === n - 1 && j === 5 ? 320 : 0)))!;
    // Its outward (+X) skirt (possibly merged with neighbours' into several quads) covers
    // everything from the tile's base to its top.
    const pieces = m.quads
      .filter((q) => q.dir === 0 && q.plane === n * step && q.v <= 5 * step && q.v + q.dv > 5 * step)
      .map((q) => [q.u, q.u + q.du] as const)
      .sort((a, b) => a[0] - b[0]);
    let reached = 0;
    for (const [a, b] of pieces) {
      expect(a).toBeLessThanOrEqual(reached); // no gap
      reached = Math.max(reached, b);
    }
    expect(reached).toBe(320 - m.baseY);
  });

  it('draws forest canopy as slabs over the ground, without walls between touching crowns', () => {
    const level = 1, step = tileStep(level);
    const t = tile(level, () => 0);
    const N = n * n;
    t.canopyTop = new Int16Array(N).fill(NO_GROUND);
    t.canopyBottom = new Int16Array(N).fill(NO_GROUND);
    t.canopyMaterials = new Uint16Array(N);
    // Two neighbouring crowns: 4-10 m and 6-12 m over cells (5,5) and (6,5).
    const set = (i: number, j: number, b: number, top: number) => ((t.canopyBottom![i + n * j] = b), (t.canopyTop![i + n * j] = top), (t.canopyMaterials![i + n * j] = 13));
    set(5, 5, 64, 160);
    set(6, 5, 96, 192);
    const m = meshTile(t)!;
    const leaves = m.quads.filter((q) => q.material === 13);
    // The ground is still drawn under them, as one flat top face.
    expect(m.quads.filter((q) => q.dir === 2 && q.material !== 13).reduce((a, q) => a + q.du * q.dv, 0)).toBe(N * step * step);
    // Tops and undersides at the crowns' heights.
    expect(leaves.filter((q) => q.dir === 2).map((q) => q.plane + m.baseY).sort()).toEqual([160, 192]);
    expect(leaves.filter((q) => q.dir === 3).map((q) => q.plane + m.baseY).sort()).toEqual([64, 96]);
    // Between them (+X face of cell 5 at x = 6 steps), only the part of 4-10 m the other crown
    // (6-12 m) doesn't cover: 4-6 m.
    const between = leaves.filter((q) => q.dir === 0 && q.plane === 6 * step);
    expect(between.map((q) => [q.u + m.baseY, q.u + q.du + m.baseY])).toEqual([[64, 96]]);
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

describe('tile water', () => {
  it('draws a river or lake surface as water over its bed, and only there', () => {
    const N = TILE_SAMPLES * TILE_SAMPLES;
    const heights = new Int16Array(N).fill(160);
    const water = new Int16Array(N).fill(NO_GROUND);
    heights[5] = 100;
    water[5] = 150; // 50 units of water over a dip
    const m = meshTile({ level: 1, tx: 0, tz: 0, heights, materials: new Uint16Array(N).fill(4), water })!;
    const tops = m.quads.filter((q) => q.dir === 2);
    const wet = tops.filter((q) => q.material === Material.Water);
    expect(wet).toHaveLength(1);
    expect(wet[0]!.plane + m.baseY).toBe(150);
    // The bed is still there, under it.
    expect(tops.some((q) => q.material !== Material.Water && q.plane + m.baseY === 100)).toBe(true);
  });
});
