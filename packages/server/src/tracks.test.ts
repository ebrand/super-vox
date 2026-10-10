import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MAX_FILL_M, MIN_RADIUS_M, Material, UNITS_PER_METER, curveSpeed, defaultFlatGen } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';

const M = UNITS_PER_METER, EAST = -Math.PI / 2;
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

/** A straight east from (x, z) m, `len` m, at `speed` km/h. */
const east = (x: number, z: number, len: number, speed = 60) => ({ from: { x: x * M, z: z * M }, heading: null, to: { x: (x + len) * M, z: z * M }, curve: false, speed });

describe('laying track, a segment at a time', () => {
  it('plans a straight: its length, flat on flat ground, at the speed asked; or why not', () => {
    const { world } = flat();
    const plan = world.planSegment(east(1000, 1000, 100));
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.layout.length).toBeCloseTo(100, 6);
    expect(plan.layout.maxGrade).toBe(0);
    expect(plan.speed).toBe(60);
    expect(plan.radius).toBe(Infinity);
    expect(world.planSegment(east(1000, 1000, 100, 55))).toMatch(/km\/h/);
    expect(world.planSegment(east(1000, 1000, 2))).toMatch(/too short/);
    expect(world.planSegment(east(1000, 1000, 500))).toMatch(/too long/);
    expect(world.planSegment({ ...east(1000, 1000, 100), from: { x: -5, z: 1000 * M } })).toMatch(/off the world/);
    // A curve from nowhere in particular: there's no way to go on from.
    expect(world.planSegment({ ...east(1000, 1000, 100), curve: true })).toMatch(/track's end/);
  });

  it('lays it (a gravel bed under the rails), kept and read again; on from its end, straight and curved: slower in a tight curve', () => {
    const { world, again, dir } = flat();
    const laid = world.layTrack(east(1000, 1000, 80));
    if (typeof laid === 'string') throw new Error(laid);
    expect(laid.results.length).toBeGreaterThan(0);
    const mid = laid.track.points[40]!;
    // (Its foot a quarter-metre up: gravel under it, air over it.)
    expect(world.materialAtUnit(Math.floor(mid.x), Math.floor(mid.y) - 1, Math.floor(mid.z))).toBe(Material.Gravel);
    expect(world.materialAtUnit(Math.floor(mid.x), Math.floor(mid.y) + 8, Math.floor(mid.z))).toBe(Material.Air);
    expect(JSON.parse(readFileSync(join(dir, 'tracks.json'), 'utf8'))).toHaveLength(1);
    expect(again().trackList().map((t) => [t.points.length, t.speed])).toEqual([[laid.track.points.length, 60]]);
    // From 4 m off its end, aimed off a little: from its end, its way, at its height.
    const end = laid.track.points.at(-1)!;
    const on = world.layTrack({ from: { x: end.x + 3 * M, z: end.z + 2 * M }, heading: 1, to: { x: end.x + 60 * M, z: end.z + 9 * M }, curve: false, speed: 60 });
    if (typeof on === 'string') throw new Error(on);
    expect(on.track.points[0]!.x).toBeCloseTo(end.x, 0);
    expect(on.track.points[0]!.z).toBeCloseTo(end.z, 0);
    expect(on.track.points[0]!.y).toBeCloseTo(end.y, 0);
    expect(on.track.points.every((p) => Math.abs(p.z - end.z) < 1)).toBe(true); // (straight on, east)
    // Curved on from that end, a 40 m radius: slower than 60 (as fast as 40 m lets it be, in fives).
    const e2 = on.track.points.at(-1)!;
    const curve = world.layTrack({ from: { x: e2.x, z: e2.z }, heading: null, to: { x: e2.x + 40 * M, z: e2.z + 40 * M }, curve: true, speed: 60 });
    if (typeof curve === 'string') throw new Error(curve);
    expect(curve.track.radius).toBeCloseTo(40, 0);
    expect(curve.track.speed).toBe(Math.floor(curveSpeed(40) / 5) * 5);
    expect(curve.track.speed).toBeLessThan(60);
    // The ends where one goes on from another aren't free: only the first's start and the curve's end.
    const free = world.freeTrackEnds();
    expect(free).toHaveLength(2);
    expect(free.map((e) => Math.round(e.x / M))).toEqual([1000, Math.round(e2.x / M + 40)]);
    // (Too tight a curve: refused.)
    const e3 = curve.track.points.at(-1)!;
    expect(world.planSegment({ from: { x: e3.x, z: e3.z }, heading: null, to: { x: e3.x + 20 * M, z: e3.z + 10 * M }, curve: true, speed: 60 })).toMatch(new RegExp(`${MIN_RADIUS_M} m at least`));
  });

  it("isn't laid up or down ground steeper than the grade, or cut deeper than it may be, or through what players have built", () => {
    const shaped = (h: (x: number) => number) => {
      const g = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4));
      g.surfaceHeightAt = ((x: number) => h(x / M) * M) as typeof g.surfaceHeightAt;
      return new World(FLAT_WORLD_16KM, g);
    };
    // A hill 25 m high at x 2040 m (its sides 5% and more): too steep.
    expect(shaped((x) => Math.max(0, 25 - Math.abs(x - 2040) * 0.5)).planSegment(east(2000, 2000, 80))).toMatch(/ground's \d+\.\d% steep .*3% at most/);
    // A gentle rise (2%): fine, the track up it.
    const gentle = shaped((x) => Math.max(0, (x - 2000) * 0.02)).planSegment(east(2000, 2000, 80));
    if (typeof gentle === 'string') throw new Error(gentle);
    expect(gentle.layout.groundGrade).toBeCloseTo(0.02, 3);
    // On from a track's end high over the ground (the ground lowered under it, as if it had been laid
    // on a ridge): built up too high where it starts.
    let level = 0;
    const lowered = shaped(() => level);
    const first = lowered.layTrack(east(2000, 2000, 50));
    if (typeof first === 'string') throw new Error(first);
    level = -20;
    const end = first.track.points.at(-1)!;
    expect(lowered.planSegment({ from: { x: end.x, z: end.z }, heading: null, to: { x: end.x + 80 * M, z: end.z }, curve: false, speed: 60 })).toMatch(new RegExp(`built up \\d+ m high .*${MAX_FILL_M} m at most`));
    const { world: w } = flat();
    // A block someone's placed, 40 m along.
    w.applyEdit({ op: 'place', x: 2040 * M, y: 0, z: 2000 * M, size: 16, material: Material.Planks });
    expect(w.planSegment(east(2000, 2000, 80))).toMatch(/cut through what's been built/);
    // Track elsewhere, and more alongside it (through its earthworks): fine; across it, not.
    expect(typeof w.layTrack(east(3000, 3000, 80))).not.toBe('string');
    expect(typeof w.planSegment(east(3000, 3010, 80))).not.toBe('string');
    expect(w.planSegment({ from: { x: 3040 * M, z: 2960 * M }, heading: null, to: { x: 3040 * M, z: 3040 * M }, curve: false, speed: 60 })).toMatch(/cross track 3\d m along/);
  });

  it('drops track kept before segments (no speed): its earthworks stay', () => {
    const { again, dir } = flat();
    writeFileSync(join(dir, 'tracks.json'), JSON.stringify([{ id: 1, points: [{ x: 0, y: 0, z: 0, heading: 0, s: 0 }], columns: [] }]));
    expect(again().trackList()).toEqual([]);
  });
});
