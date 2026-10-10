import { describe, expect, it } from 'vitest';
import { BLOCK_VOLUME, COAL_SECONDS, CRATE_BLOCKS, FLATBED_CRATES, Item, MAX_COAL, Material, PASSENGER_SEATS, UNITS_PER_METER, carPose, cratesFor, trackNet, type Track, type TrackPoint } from '@super-vox/shared';
import { TrainYard } from './trainYard.js';

const M = UNITS_PER_METER, EAST = -Math.PI / 2, WEST = Math.PI / 2;

/** A straight track east from x0 to x1 (m), along z 0, flat. */
function east(id: number, x0: number, x1: number, speed = 80): Track {
  const n = x1 - x0;
  const points: TrackPoint[] = Array.from({ length: n + 1 }, (_, i) => ({ x: (x0 + i) * M, y: 0, z: 0, heading: EAST, s: i * M }));
  return { id, points, speed, radius: null, columns: [] };
}

function yard() {
  const y = new TrainYard();
  y.setTracks([east(1, 0, 300), east(2, 300, 600)]);
  return y;
}

/** Steps the yard `s` seconds, 20 a second. */
const run = (y: TrainYard, s: number, burn = false) => {
  for (let i = 0; i < s * 20; i++) y.step(0.05, burn);
};
const xOf = (y: TrainYard, car: number) => y.carAt(car)!.x / M;

describe('trains in a world', () => {
  it('puts cars on track (near where aimed, facing the way looked), not off it, too near its end, or on another', () => {
    const y = yard();
    const e = y.place('engine', 100 * M, 0, 2 * M, EAST);
    if (typeof e === 'string') throw new Error(e);
    expect(xOf(y, e.id)).toBeCloseTo(100, 0);
    expect(y.place('flatbed', 100 * M, 0, 20 * M, EAST)).toMatch(/aim at it/);
    expect(y.place('flatbed', 2 * M, 0, 0, EAST)).toMatch(/end of the line/);
    expect(y.place('flatbed', 104 * M, 0, 0, EAST)).toMatch(/no room/);
    expect(y.list()).toHaveLength(1);
  });

  it('is driven: on, through the join; slow into a car, coupled (pulling it after); too fast into one, stopped dead', () => {
    const y = yard();
    const e = y.place('engine', 250 * M, 0, 0, EAST) as { id: number };
    const f = y.place('flatbed', 330 * M, 0, 0, WEST) as { id: number };
    expect(y.board(f.id, 7)).toMatch(/only an engine/);
    expect(y.board(e.id, 7)).toBe(true);
    expect(y.board(e.id, 8)).toMatch(/someone is driving/);
    // Gently ahead, then coasting into the flatbed.
    y.drive(7, 0.2, false, false);
    run(y, 5);
    y.drive(7, 0, false, false);
    for (let i = 0; i < 20 * 60 && y.list().length > 1; i++) y.step(0.05, false);
    expect(y.list()).toHaveLength(1);
    const t = y.list()[0]!;
    expect(t.cars.map((c) => c.id)).toEqual([f.id, e.id]);
    expect(t.driver).toBe(7);
    // Pulled back (west), the flatbed comes along.
    const before = xOf(y, f.id);
    y.drive(7, -0.5, false, false);
    run(y, 5);
    expect(xOf(y, f.id)).toBeLessThan(before - 1);
    expect(xOf(y, f.id) - xOf(y, e.id)).toBeGreaterThan(9); // (ahead of it, east, still)
    // Too fast into another car: both stopped, not coupled.
    const y2 = yard();
    const e2 = y2.place('engine', 100 * M, 0, 0, EAST) as { id: number };
    y2.place('flatbed', 400 * M, 0, 0, EAST);
    y2.board(e2.id, 7);
    y2.drive(7, 1, false, false);
    for (let i = 0; i < 20 * 120 && y2.list().every((t) => t.v >= 0) && !y2.list().some((t) => t.cars.length > 1); i++) {
      y2.step(0.05, false);
      if (y2.list().find((t) => t.driver === 7)!.v === 0 && i > 20) break;
    }
    expect(y2.list()).toHaveLength(2);
    expect(y2.list().every((t) => t.v === 0)).toBe(true);
  });

  it('uncouples, and takes cars off (stopped, at a train end, not driven); burns coal in survival', () => {
    const y = yard();
    const e = y.place('engine', 100 * M, 0, 0, EAST) as { id: number };
    const a = y.place('flatbed', 89 * M, 0, 0, EAST) as { id: number };
    const b = y.place('passenger', 77 * M, 0, 0, EAST) as { id: number };
    // (Pushed together by hand: coupled one by one.)
    y.board(e.id, 7);
    y.drive(7, -0.1, false, false);
    for (let i = 0; i < 20 * 60 && y.list().length > 1; i++) y.step(0.05, false);
    y.drive(7, 0, true, false);
    run(y, 10);
    expect(y.list()[0]!.cars.map((c) => c.id)).toEqual([e.id, a.id, b.id]);
    expect(y.take(a.id)).toMatch(/uncouple it first/);
    expect(y.take(e.id)).toMatch(/someone is driving/);
    expect(y.uncouple(b.id)).toBe(true);
    expect(y.list()).toHaveLength(2);
    expect(y.take(b.id)).toBe('passenger');
    expect(y.take(a.id)).toBe('flatbed');
    // Coal: none, no pull (survival); some, it goes, burning it.
    const start = xOf(y, e.id);
    y.drive(7, 1, false, false);
    run(y, 2, true);
    expect(xOf(y, e.id)).toBeCloseTo(start, 3);
    expect(y.fuel(e.id, 2)).toBe(2);
    expect(y.fuel(e.id, 99)).toBe(MAX_COAL - 2);
    expect(y.fuel(e.id, 1)).toMatch(/full/);
    run(y, 2, true);
    expect(xOf(y, e.id)).toBeGreaterThan(start + 0.5);
    expect(y.list()[0]!.cars[0]!.fuel).toBeLessThan(MAX_COAL * COAL_SECONDS);
    // Out: the brakes on, it stops; kept and read again, stopped, no one in it.
    y.leave(7);
    run(y, 30);
    expect(y.list()[0]!.v).toBe(0);
    const again = new TrainYard(JSON.parse(JSON.stringify(y.save())));
    again.setTracks([east(1, 0, 300), east(2, 300, 600)]);
    expect(again.list().map((t) => [t.cars.map((c) => c.kind), t.driver])).toEqual([[['engine'], null]]);
    expect(carPose(trackNet([east(1, 0, 300), east(2, 300, 600)]), again.list()[0]!.cars[0]!)!.x / M).toBeCloseTo(xOf(y, e.id), 3);
    // (Something not trains: none.)
    expect(new TrainYard({ trains: [{ id: 'x' }] }).list()).toEqual([]);
  });

  it("seats passengers (each in their own, till they're full); loads a flatbed in crates, as much as fits; neither taken off till empty", () => {
    const y = yard();
    const p = y.place('passenger', 100 * M, 0, 0, EAST) as { id: number };
    const f = y.place('flatbed', 200 * M, 0, 0, EAST) as { id: number };
    expect(y.sit(f.id, 1)).toMatch(/only a passenger car/);
    const seats = Array.from({ length: PASSENGER_SEATS }, (_, i) => y.sit(p.id, i + 1));
    expect(seats).toEqual(Array.from({ length: PASSENGER_SEATS }, (_, i) => i));
    expect(y.sit(p.id, 99)).toMatch(/every seat/);
    expect(y.take(p.id)).toMatch(/sitting/);
    // Out (one, and the rest): the seat's free again; kept without them.
    y.leave(3);
    expect(y.sit(p.id, 99)).toBe(2);
    expect(y.save().trains.flatMap((t) => t.cars).find((c) => c.id === p.id)!.seats!.every((s) => s === null)).toBe(true);
    for (let i = 1; i <= 99; i++) y.leave(i);
    expect(y.take(p.id)).toBe('passenger');
    // Loads: in crates (items by CRATE_ITEMS, blocks by CRATE_BLOCKS), as many as fit.
    expect(y.load(p.id + 99, Item.Stick, 1)).toMatch(/gone/);
    expect(y.load(f.id, Item.Stick, 100)).toBe(100);
    expect(cratesFor(y.list()[0]!.cars[0]!.cargo)).toBe(2);
    expect(y.load(f.id, Material.Stone, 1000 * BLOCK_VOLUME)).toBe((FLATBED_CRATES - 2) * CRATE_BLOCKS * BLOCK_VOLUME);
    expect(y.load(f.id, Item.Stick, 28)).toBe(28); // (the stick crate topped up)
    expect(y.load(f.id, Item.Stick, 1)).toMatch(/full/);
    expect(y.take(f.id)).toMatch(/unload/);
    expect(y.load(f.id, Item.Stick, -500)).toBe(128);
    expect(y.load(f.id, Item.Stick, -1)).toMatch(/none of that/);
    expect(y.load(f.id, Material.Stone, -1e9)).toBe((FLATBED_CRATES - 2) * CRATE_BLOCKS * BLOCK_VOLUME);
    expect(y.take(f.id)).toBe('flatbed');
  });
});