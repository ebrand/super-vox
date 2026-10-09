import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MIN_RADIUS_M, Material, UNITS_PER_METER, defaultFlatGen } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';

const M = UNITS_PER_METER;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Flat ground (its top at y 0), kept in a scratch directory. */
function flat() {
  const dir = mkdtempSync(join(tmpdir(), 'tracks-'));
  dirs.push(dir);
  const make = () => new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), { store: new FileChunkStore(dir) });
  return { world: make(), again: make, dir };
}

describe('laying track', () => {
  it('plans a route: its length, flat on flat ground; too tight a curve, or too few points: why not', () => {
    const { world } = flat();
    const plan = world.planTrack([{ x: 1000 * M, z: 1000 * M }, { x: 1100 * M, z: 1000 * M }]);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.layout.length).toBeCloseTo(100, 0);
    expect(plan.layout.maxGrade).toBe(0);
    expect(world.planTrack([{ x: 1000 * M, z: 1000 * M }])).toMatch(/two points/);
    expect(world.planTrack([{ x: 1000 * M, z: 1000 * M }, { x: 1010 * M, z: 1000 * M }, { x: 1010 * M, z: 1010 * M }])).toMatch(/too tight/);
    expect(MIN_RADIUS_M).toBeGreaterThan(10);
    expect(world.planTrack([{ x: -5, z: 1000 * M }, { x: 100 * M, z: 1000 * M }])).toMatch(/off the world/);
  });

  it('lays it: a gravel bed under the rails, kept (and read again); a route from its end joins it there', () => {
    const { world, again, dir } = flat();
    const laid = world.layTrack([{ x: 1000 * M, z: 1000 * M }, { x: 1080 * M, z: 1000 * M }]);
    if (typeof laid === 'string') throw new Error(laid);
    expect(laid.results.length).toBeGreaterThan(0);
    const mid = laid.track.points[40]!;
    // (Its foot a quarter-metre up: gravel under it, air over it.)
    expect(world.materialAtUnit(Math.floor(mid.x), Math.floor(mid.y) - 1, Math.floor(mid.z))).toBe(Material.Gravel);
    expect(world.materialAtUnit(Math.floor(mid.x), Math.floor(mid.y) + 8, Math.floor(mid.z))).toBe(Material.Air);
    expect(JSON.parse(readFileSync(join(dir, 'tracks.json'), 'utf8'))).toHaveLength(1);
    expect(again().trackList().map((t) => t.points.length)).toEqual([laid.track.points.length]);
    // From 4 m off its end: from its end, at its height.
    const end = laid.track.points.at(-1)!;
    const more = world.layTrack([{ x: end.x + 4 * M, z: end.z + 2 * M }, { x: end.x + 80 * M, z: end.z + 20 * M }]);
    if (typeof more === 'string') throw new Error(more);
    expect(more.track.points[0]!.x).toBeCloseTo(end.x, 0);
    expect(more.track.points[0]!.z).toBeCloseTo(end.z, 0);
    expect(more.track.points[0]!.y).toBeCloseTo(end.y, 0);
    expect(world.trackList()).toHaveLength(2);
  });

  it("doesn't cut through what players have built (but goes on past other track)", () => {
    const { world } = flat();
    // A block someone's placed, 40 m along.
    world.applyEdit({ op: 'place', x: 2040 * M, y: 0, z: 2000 * M, size: 16, material: Material.Planks });

    expect(world.planTrack([{ x: 2000 * M, z: 2000 * M }, { x: 2080 * M, z: 2000 * M }])).toMatch(/cut through what's been built/);
    // Track elsewhere, and more alongside it (through its earthworks): fine.
    expect(typeof world.layTrack([{ x: 3000 * M, z: 3000 * M }, { x: 3080 * M, z: 3000 * M }])).not.toBe('string');
    expect(typeof world.planTrack([{ x: 3000 * M, z: 3004 * M }, { x: 3080 * M, z: 3004 * M }])).not.toBe('string');
  });
});
