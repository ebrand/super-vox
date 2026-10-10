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
    // Track elsewhere, and more alongside it (clear of its bed): fine; across it too.
    expect(typeof w.layTrack(east(3000, 3000, 80))).not.toBe('string');
    expect(typeof w.planSegment(east(3000, 3010, 80))).not.toBe('string');
    // (Square across it, mid-way: a level crossing, fine.)
    expect(typeof w.planSegment({ from: { x: 3040 * M, z: 2960 * M }, heading: null, to: { x: 3040 * M, z: 3040 * M }, curve: false, speed: 60 })).not.toBe('string');
  });

  it('drops track kept before segments (no speed): its earthworks stay', () => {
    const { again, dir } = flat();
    writeFileSync(join(dir, 'tracks.json'), JSON.stringify([{ id: 1, points: [{ x: 0, y: 0, z: 0, heading: 0, s: 0 }], columns: [] }]));
    expect(again().trackList()).toEqual([]);
  });

  it('branches from a point along a track (curving away: a switch there, the track split in two); not too near its ends', () => {
    const { world } = flat();
    const main = world.layTrack(east(1000, 1000, 200));
    if (typeof main === 'string') throw new Error(main);
    // From 100 m along it, curving off north-east (-z).
    const ask = { from: { x: 1100 * M, z: 1001 * M }, heading: null, to: { x: 1160 * M, z: 980 * M }, curve: true, speed: 60 };
    expect(world.planSegment({ ...ask, curve: false })).toMatch(/curves away/);
    expect(world.planSegment({ ...ask, from: { x: 1190 * M, z: 1000 * M } })).toMatch(/too near the end/);
    const branch = world.layTrack(ask);
    if (typeof branch === 'string') throw new Error(branch);
    expect(branch.track.points[0]!.x).toBeCloseTo(1100 * M, 0);
    expect(world.trackList()).toHaveLength(3);
    // (The main line in two, end to start at the branch.)
    const [a, b] = world.trackList().filter((t) => t.id !== branch.track.id);
    expect(a!.points.at(-1)!.x).toBeCloseTo(b!.points[0]!.x, 3);
    const node = world.trains.switchAt('1100,1000');
    expect(node?.legs).toHaveLength(2);
    expect(world.trains.switches()['1100,1000']).toBe(node!.straight);
    // A train through it: the driver meaning left, it goes left (onto the branch); thrown while it's on it: not.
    const engine = world.trains.place('engine', 1060 * M, 0, 1000 * M, EAST);
    if (typeof engine === 'string') throw new Error(engine);
    world.trains.board(engine.id, 7);
    world.trains.drive(7, 0.6, false, false, 'left');
    let threw: string | number = 0;
    for (let i = 0; i < 20 * 40; i++) {
      world.trains.step(0.05, false);
      const at = world.trains.list()[0]!.cars[0]!.pos;
      if (at.track === branch.track.id && threw === 0) threw = world.trains.throwSwitch('1100,1000');
      if (at.track === branch.track.id && at.s > 30 * M) break;
    }
    expect(world.trains.list()[0]!.cars[0]!.pos.track).toBe(branch.track.id);
    expect(threw).toMatch(/train is on it/);
    expect(world.trains.switches()['1100,1000']).toBe(0);
  });

  it('crosses other track level (square enough, not near its ends); not alongside it, too sharply, or by its end', () => {
    const { world } = flat();
    expect(typeof world.layTrack(east(2000, 2000, 200))).not.toBe('string');
    // North across it at x 2100 m: fine, level with it there.
    const across = world.planSegment({ from: { x: 2100 * M, z: 2050 * M }, heading: null, to: { x: 2100 * M, z: 1950 * M }, curve: false, speed: 60 });
    if (typeof across === 'string') throw new Error(across);
    const mid = across.layout.points[50]!;
    expect(Math.abs(mid.z - 2000 * M)).toBeLessThan(M);
    // Alongside it, 3 m off: too near.
    expect(world.planSegment(east(2020, 2003, 150))).toMatch(/too near track/);
    // At 10 degrees: too sharp.
    const t = Math.tan((10 * Math.PI) / 180);
    expect(world.planSegment({ from: { x: 2050 * M, z: (2000 - 50 * t) * M }, heading: null, to: { x: 2150 * M, z: (2000 + 50 * t) * M }, curve: false, speed: 60 })).toMatch(/at 1\d° \(25° at least\)/);
    // By its end: not.
    expect(world.planSegment({ from: { x: 2195 * M, z: 2050 * M }, heading: null, to: { x: 2195 * M, z: 1950 * M }, curve: false, speed: 60 })).toMatch(/too near its end/);
    // Laid across: two tracks, no switch (nothing meets).
    expect(typeof world.layTrack({ from: { x: 2100 * M, z: 2050 * M }, heading: null, to: { x: 2100 * M, z: 1950 * M }, curve: false, speed: 60 })).not.toBe('string');
    expect(world.trackList()).toHaveLength(2);
    expect(Object.keys(world.trains.switches())).toHaveLength(0);
  });
});