import { describe, expect, it } from 'vitest';
import type { Track, TrackPoint } from './rail.js';
import { CAR_GAP_M, CAR_SPECS, accelerate, alongLine, behind, carPose, moveTrain, pointAt, speedLimit, trackNet, type Car, type Train } from './trains.js';
import { UNITS_PER_METER } from './units.js';

const M = UNITS_PER_METER;

/** A straight track (m): from (x0, z0) to (x1, z1), a point a metre; height `y(s)` (m, s metres along). */
function straight(id: number, x0: number, z0: number, x1: number, z1: number, y: (s: number) => number = () => 0, speed = 80): Track {
  const L = Math.hypot(x1 - x0, z1 - z0), n = Math.round(L);
  const heading = Math.atan2(-(x1 - x0), -(z1 - z0));
  const points: TrackPoint[] = Array.from({ length: n + 1 }, (_, i) => ({ x: (x0 + ((x1 - x0) * i) / n) * M, y: y(i) * M, z: (z0 + ((z1 - z0) * i) / n) * M, heading, s: i * M }));
  return { id, points, speed, radius: null, columns: [] };
}

const train = (cars: Car[], v = 0, driver: number | null = null, throttle = 0): Train => ({ id: 1, cars, v, driver, throttle, brake: false });

describe('along the line', () => {
  it('goes on over joins (either way round), and stops at the end of the line', () => {
    // A east 0..100 m; B on east from A's end; C drawn from 300 back to 200, its end at B's end.
    const net = trackNet([straight(1, 0, 0, 100, 0), straight(2, 100, 0, 200, 0), straight(3, 300, 0, 200, 0)]);
    const on = alongLine(net, { track: 1, s: 95 * M, dir: 1 }, 10 * M);
    expect(on.pos).toEqual({ track: 2, s: 5 * M, dir: 1 });
    // Into C from its end: going down it, its forward the other way along it.
    const into = alongLine(net, on.pos, 100 * M);
    expect(into.pos.track).toBe(3);
    expect(into.pos.s).toBeCloseTo(95 * M, 6);
    expect(into.pos.dir).toBe(-1);
    expect(pointAt(net, into.pos)!.x).toBeCloseTo(205 * M, 6);
    // (Still heading east, its forward.)
    expect(pointAt(net, into.pos)!.heading).toBeCloseTo(-Math.PI / 2, 6);
    // And back, the same way it came.
    expect(alongLine(net, into.pos, -110 * M).pos).toEqual({ track: 1, s: 95 * M, dir: 1 });
    // Past the end of the line (C's start, at 300 m): as far as it goes.
    const end = alongLine(net, into.pos, 200 * M);
    expect(end.moved).toBeCloseTo(95 * M, 6);
    expect(pointAt(net, end.pos)!.x).toBeCloseTo(300 * M, 6);
  });

  it('moves a train, its cars keeping their spacing over a join; at the end of the line it stops against the buffers', () => {
    const net = trackNet([straight(1, 0, 0, 100, 0), straight(2, 200, 0, 100, 0)]);
    const engine: Car = { id: 1, kind: 'engine', pos: { track: 1, s: 80 * M, dir: 1 }, flip: false };
    const flat: Car = { id: 2, kind: 'flatbed', pos: behind(net, engine, 'flatbed'), flip: false };
    const t = train([engine, flat]);
    const gap = () => carPose(net, engine)!.x - carPose(net, flat)!.x;
    const spacing = ((CAR_SPECS.engine.length + CAR_SPECS.flatbed.length) / 2 + CAR_GAP_M) * M;
    expect(gap()).toBeCloseTo(spacing, 3);
    expect(moveTrain(net, t, 30 * M)).toBeCloseTo(30 * M, 6);
    expect(engine.pos.track).toBe(2);
    expect(gap()).toBeCloseTo(spacing, 3);
    // To the end (200 m): its front buffers there, no further.
    const went = moveTrain(net, t, 500 * M);
    expect(carPose(net, engine)!.x + (CAR_SPECS.engine.length / 2) * M).toBeCloseTo(200 * M, 3);
    expect(went).toBeLessThan(100 * M);
  });

  it('an engine pulls, the brakes stop it, a train no one drives stays put on a slope; held to the speed limit', () => {
    const net = trackNet([straight(1, 0, 0, 1000, 0, (s) => s * 0.03, 40)]);
    const engine = (): Car => ({ id: 1, kind: 'engine', pos: { track: 1, s: 500 * M, dir: 1 }, flip: false, fuel: 100 });
    const driven = train([engine()], 0, 7, 1);
    for (let i = 0; i < 20; i++) driven.v = accelerate(net, driven, 0.1, false);
    expect(driven.v).toBeGreaterThan(0.5); // (up a 3% slope)
    const parked = train([engine()], 0, null);
    for (let i = 0; i < 50; i++) parked.v = accelerate(net, parked, 0.1, false);
    expect(parked.v).toBe(0);
    // Out of fuel (survival): no pull.
    const dry = train([{ ...engine(), fuel: 0 }], 0, 7, 1);
    for (let i = 0; i < 10; i++) dry.v = accelerate(net, dry, 0.1, true);
    expect(dry.v).toBeLessThanOrEqual(0);
    // Fuel burned: a second at full throttle, a second's worth.
    const burning = train([engine()], 0, 7, 1);
    accelerate(net, burning, 1, true);
    expect(burning.cars[0]!.fuel).toBeCloseTo(99, 6);
    // Fast, on 40 km/h track: slowed to it.
    const fast = train([engine()], 20, 7, 1);
    for (let i = 0; i < 200; i++) fast.v = accelerate(net, fast, 0.1, false);
    expect(fast.v).toBeLessThanOrEqual(speedLimit(net, fast) + 1e-9);
    expect(speedLimit(net, fast)).toBeCloseTo(40 / 3.6, 9);
  });

  it('switches: three ends meeting, the trunk and its legs (left, right; the straighter); through as set, back from either leg onto the trunk', () => {
    // A trunk east to x 100; on east, straight (B), and a leg bearing left, north-east (C: -z is north).
    const net = trackNet([straight(1, 0, 0, 100, 0), straight(2, 100, 0, 200, 0), straight(3, 100, 0, 190, -40)]);
    const node = net.nodes.find((n) => n.legs)!;
    expect(node.trunk).toEqual({ track: 1, end: 'end' });
    expect(node.legs).toEqual([{ track: 3, end: 'start' }, { track: 2, end: 'start' }]);
    expect(node.straight).toBe(1);
    expect(net.set.get(node.key)).toBe(1); // (set straight, to start)
    const from = { track: 1, s: 95 * M, dir: 1 as const };
    expect(alongLine(net, from, 10 * M).pos.track).toBe(2);
    net.set.set(node.key, 0);
    expect(alongLine(net, from, 10 * M).pos.track).toBe(3);
    // Back from either leg: onto the trunk, however it's set.
    expect(alongLine(net, { track: 2, s: 5 * M, dir: 1 }, -10 * M).pos).toEqual({ track: 1, s: 95 * M, dir: 1 });
    expect(alongLine(net, { track: 3, s: 5 * M, dir: 1 }, -10 * M).pos.track).toBe(1);
    // As kept: set left, it's left.
    expect(trackNet([straight(1, 0, 0, 100, 0), straight(2, 100, 0, 200, 0), straight(3, 100, 0, 190, -40)], { [node.key]: 0 }).set.get(node.key)).toBe(0);
    // A train through it: its leading car the way the chooser says (setting it), the rest after it.
    net.set.set(node.key, 1);
    const engine: Car = { id: 1, kind: 'engine', pos: { track: 1, s: 90 * M, dir: 1 }, flip: false };
    const flat: Car = { id: 2, kind: 'flatbed', pos: behind(net, engine, 'flatbed'), flip: false };
    const t = train([engine, flat]);
    const left = (n: typeof node) => (n.legs ? (net.set.set(n.key, 0), n.legs[0]) : null);
    moveTrain(net, t, 40 * M, left);
    expect([engine.pos.track, flat.pos.track]).toEqual([3, 3]);
    expect(net.set.get(node.key)).toBe(0);
  });
});