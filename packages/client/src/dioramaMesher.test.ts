import { describe, expect, it } from 'vitest';
import { DIRT_DEPTH, Material, NO_CANOPY, NO_WATER } from '@super-vox/shared';
import { meshDioramaSection, type DioramaField } from './dioramaMesher.js';

const M = 16;
/** A 3 x 2 field 1 m apart: heights 10, 12, 10 m / 10, 10, 10 m (grass), base at 2 m. */
const field = (over: Partial<DioramaField> = {}): DioramaField => ({
  cols: 3, rows: 2, step: M,
  heights: Int32Array.of(10 * M, 12 * M, 10 * M, 10 * M, 10 * M, 10 * M),
  materials: new Uint16Array(6).fill(Material.Grass),
  canopy: null, water: null, base: 2 * M,
  ...over,
});

describe('meshDioramaSection', () => {
  it('draws tops, walls down to lower neighbours, layered cut faces at the edges, and a bottom', () => {
    const { ground, water } = meshDioramaSection(field(), 0, 0, 3, 2);
    expect(water).toEqual([]);
    const tops = ground.filter((q) => q.dir === 2);
    expect(tops).toHaveLength(6);
    expect(tops.map((q) => q.plane).sort((a, b) => a - b)).toEqual([8, 8, 8, 8, 8, 10].map((m) => m * M));
    // The 12 m column stands 2 m above its three neighbours inside the field: three 2 m walls.
    const walls = ground.filter((q) => q.dir !== 2 && q.dir !== 3 && q.material === Material.Grass && (q.du === 2 * M || q.dv === 2 * M));
    expect(walls.length).toBeGreaterThanOrEqual(3);
    // Edge faces reach the base (y 0, relative) in layers: grass 1 m, dirt to 3 m down, then stone.
    const edge = ground.filter((q) => q.dir === 5); // facing -Z: the north edge, all three columns
    expect(edge.filter((q) => q.material === Material.Stone)).toHaveLength(3);
    expect(edge.filter((q) => q.material === Material.Dirt)).toHaveLength(3);
    const lowest = Math.min(...edge.map((q) => q.v));
    expect(lowest).toBe(0);
    const stone = edge.find((q) => q.material === Material.Stone && q.u === 0)!;
    expect(stone.v + stone.dv).toBe(8 * M - DIRT_DEPTH);
    // One bottom face under it all.
    const bottom = ground.filter((q) => q.dir === 3);
    expect(bottom).toEqual([expect.objectContaining({ plane: 0, du: 2 * M, dv: 3 * M, material: Material.Stone })]);
  });

  it('meshes a section of a bigger field, relative to its corner, with walls to samples outside it', () => {
    const { ground } = meshDioramaSection(field(), 1, 0, 1, 1);
    const top = ground.find((q) => q.dir === 2)!;
    expect([top.u, top.v, top.plane]).toEqual([0, 0, 10 * M]);
    // Its neighbours are inside the field: no cut faces down to the base on the west/east sides.
    expect(ground.filter((q) => (q.dir === 0 || q.dir === 1) && q.material === Material.Stone)).toHaveLength(0);
  });

  it('draws water over the ground, with sides where it steps down and cut off at the edges', () => {
    const w = new Int32Array(6).fill(NO_WATER);
    w[3] = 11 * M; // over the 10 m ground at (0, 1)
    const { water } = meshDioramaSection(field({ water: w }), 0, 0, 3, 2);
    const top = water.filter((q) => q.dir === 2);
    expect(top).toHaveLength(1);
    expect(top[0]!.plane).toBe(9 * M);
    // Sides: down to its neighbour's ground (10 m) inside, and at the west and south edges down to its own ground.
    const sides = water.filter((q) => q.dir !== 2);
    expect(sides.length).toBe(4);
    for (const q of sides) expect(q.material).toBe(Material.Water);
  });

  it('draws forest canopy as slabs over the ground', () => {
    const top = new Int32Array(6).fill(NO_CANOPY), bottom = new Int32Array(6).fill(NO_CANOPY);
    top[4] = 20 * M;
    bottom[4] = 15 * M;
    const { ground } = meshDioramaSection(field({ canopy: { top, bottom, material: new Uint16Array(6).fill(Material.Leaves) } }), 0, 0, 3, 2);
    const leaves = ground.filter((q) => q.material === Material.Leaves);
    // Top, underside and four sides.
    expect(leaves).toHaveLength(6);
    expect(leaves.find((q) => q.dir === 2)!.plane).toBe(18 * M);
    expect(leaves.find((q) => q.dir === 3)!.plane).toBe(13 * M);
  });
});
