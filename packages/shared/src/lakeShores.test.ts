import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM } from './world.js';
import { PLATE_CELL, PlateHeights, defaultPlateTerrain } from './plates.js';
import { NO_WATER } from './water.js';

/**
 * Lakes' edges: water stands only where it's held, by the ground or more water at its level. Over
 * whole grid cells along lakes' edges (sampled per unit column), a column with lake water next to
 * one with none and lower ground would be a wall of water (seen as a sheer face over dry land).
 */
describe("lakes' shores", () => {
  // (Rivers off: a river's own water can stand over the ground beside its channel, lakes or not.)
  for (const seed of [21, 4, 9]) it(`never leave water standing beside lower dry ground (no walls of water; world ${seed})`, () => {
    const config = { ...defaultPlateTerrain(seed), rivers: 0, lakes: 80, mountains: 50 };
    const p = new PlateHeights(FLAT_WORLD_16KM, config);
    const h = p.hydrology!;
    expect(h.lakeCount).toBeGreaterThan(0);
    const cols = FLAT_WORLD_16KM.widthUnits / PLATE_CELL, rows = FLAT_WORLD_16KM.depthUnits / PLATE_CELL;
    const isLake = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && !Number.isNaN(h.lakeLevel[c + cols * r]!);
    // Cells beside a lake but not in it: where its edge (and any wall) would be.
    const edge: [number, number][] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (!isLake(c, r) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => isLake(c + dc!, r + dr!))) edge.push([c, r]);
    expect(edge.length).toBeGreaterThan(0);
    let walls = 0, shoreline = 0;
    const N = PLATE_CELL + 2;
    for (const [c, r] of edge.slice(0, 16)) {
      const x0 = c * PLATE_CELL - 1, z0 = r * PLATE_CELL - 1;
      const H = p.heights(x0, z0, N, N), W = p.water(x0, z0, N, N);
      if (!W) continue;
      for (let j = 1; j < N - 1; j++)
        for (let i = 1; i < N - 1; i++) {
          const k = i + N * j, top = W[k]!;
          if (top === NO_WATER || top <= H[k]!) continue;
          for (const n of [k + 1, k - 1, k + N, k - N]) {
            const dry = W[n] === NO_WATER || W[n]! < top;
            if (!dry) continue;
            shoreline++;
            if (H[n]! < top) walls++;
          }
        }
    }
    expect(shoreline).toBeGreaterThan(0);
    expect(walls).toBe(0);
  }, 60_000);
});
