import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { KNOCKDOWN_REACH, Knockdown, knockdownFor } from './knockdown.js';
import type { Mover } from './walking.js';
import { ExplosionView } from './explosions.js';

describe('knockdownFor', () => {
  it('only within reach; harder the bigger and nearer', () => {
    expect(knockdownFor(16 * KNOCKDOWN_REACH, 16, { x: 1, z: 0 })).toBeNull();
    expect(knockdownFor(5, 2.3, { x: 1, z: 0 })).toBeNull();
    // (Anywhere its crater can reach: its lobes go about 1.5 radii.)
    expect(knockdownFor(2.3 * 1.55, 2.3, { x: 1, z: 0 })).not.toBeNull();
    const smallNear = knockdownFor(1, 2.3, { x: 1, z: 0 })!, bigNear = knockdownFor(1, 16, { x: 1, z: 0 })!, bigFar = knockdownFor(20, 16, { x: 1, z: 0 })!;
    expect(bigNear.strength).toBeGreaterThan(smallNear.strength);
    expect(bigNear.strength).toBeGreaterThan(bigFar.strength);
    expect(bigNear.strength).toBeLessThanOrEqual(1);
  });

  it('throws you away from the blast', () => {
    // (Blast to the east: thrown west.)
    expect(knockdownFor(2, 8, { x: 3, z: 0 })!.away).toEqual({ x: -1, z: -0 });
  });
});

/** Flat ground (the eye can't go below 1.62 m), and a wall at x = wallX if given: the player's mover. */
function ground(pos: { x: number; y: number; z: number }, wallX = Infinity): Mover {
  return ([dx, dy, dz]) => {
    let mx = dx, my = dy;
    const bx = pos.x + dx > wallX - 0.3;
    if (bx) mx = 0;
    const by = pos.y + dy < 1.62;
    if (by) my = 1.62 - pos.y;
    pos.x += mx;
    pos.y += my;
    pos.z += dz;
    return { delta: [mx, my, dz], blocked: [bx, by, false] };
  };
}

describe('Knockdown', () => {
  /** Runs one through at 60 fps from standing at the origin: the poses, where you ended up, and the time it took. */
  function run(k: ReturnType<typeof knockdownFor>, wallX = Infinity) {
    const kd = new Knockdown(), pos = { x: 0, y: 1.62, z: 0 }, move = ground(pos, wallX);
    kd.begin(k!);
    const poses = [];
    let highest = 0, thrownFor = 0;
    for (let i = 0; i < 60 * 15; i++) {
      if (kd.thrown) thrownFor += 1 / 60;
      const p = kd.update(1 / 60, move);
      if (!p) break;
      poses.push(p);
      highest = Math.max(highest, pos.y - 1.62);
    }
    return { poses, pos, highest, thrownFor, done: !kd.active };
  }

  it('thrown back, tumbling and bouncing, then lying, then up; over in a few seconds', () => {
    const k = knockdownFor(1, 16, { x: 0, z: 2 }, 1)!;
    const { poses, pos, highest, thrownFor, done } = run(k);
    expect(done).toBe(true);
    // (Away from the blast, which was to +z: some way back, and up off the ground on the way.)
    expect(pos.z).toBeLessThan(-8);
    expect(Math.abs(pos.x)).toBeLessThan(1e-6);
    expect(highest).toBeGreaterThan(0.5);
    expect(thrownFor).toBeGreaterThan(1);
    expect(thrownFor).toBeLessThan(4.1);
    // Turned over at least once on the way, settled upright (whole turns) by the end, and the eye back up.
    expect(Math.max(...poses.map((p) => p.tumble))).toBeGreaterThan(2 * Math.PI);
    const last = poses.at(-1)!;
    expect(Math.abs(last.tumble / (2 * Math.PI) - Math.round(last.tumble / (2 * Math.PI)))).toBeLessThan(1e-6);
    expect(last.drop).toBeLessThan(0.01);
    expect(poses.length / 60).toBeLessThan(8);
  });

  it('a weaker blast throws you less far', () => {
    const weak = run(knockdownFor(4, 2.3, { x: 0, z: 2 })!), strong = run(knockdownFor(1, 16, { x: 0, z: 2 })!);
    expect(-weak.pos.z).toBeLessThan(-strong.pos.z / 2);
    expect(-weak.pos.z).toBeGreaterThan(1);
  });

  it('a wall stops you (and you bounce off it)', () => {
    const { pos } = run(knockdownFor(1, 16, { x: -2, z: 0 })!, 3);
    expect(pos.x).toBeLessThan(3);
  });

  it('a weaker blast does not cut short a harder one under way', () => {
    const kd = new Knockdown(), pos = { x: 0, y: 1.62, z: 0 }, move = ground(pos);
    kd.begin(knockdownFor(1, 16, { x: 1, z: 0 })!);
    kd.update(0.2, move);
    const before = pos.x;
    kd.begin(knockdownFor(3, 2.3, { x: -1, z: 0 })!);
    kd.update(0.1, move);
    // (Still flying the first way: west, away from the first blast.)
    expect(pos.x).toBeLessThan(before);
  });
});

describe('blast shake', () => {
  /** The biggest the view's shaken (m) by a blast of `radius` m, `distance` m off, over 4 s. */
  function biggestShake(radius: number, distance: number) {
    vi.useFakeTimers();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, distance);
    const view = new ExplosionView(new THREE.Scene(), camera);
    view.explode(0, 0, 0, radius * 16);
    let most = 0, late = 0;
    for (let ms = 0; ms < 4000; ms += 10) {
      vi.advanceTimersByTime(10);
      const s = view.shake().length();
      most = Math.max(most, s);
      if (ms > 2500) late = Math.max(late, s);
    }
    vi.useRealTimers();
    return { most, late };
  }

  it('shakes harder and longer the bigger the blast, less the farther off', () => {
    const small = biggestShake(2.3, 3), big = biggestShake(16, 3), bigFar = biggestShake(16, 100);
    expect(big.most).toBeGreaterThan(small.most * 3);
    expect(big.late).toBeGreaterThan(0.01);
    expect(small.late).toBeLessThan(0.005); // (Under 5 mm: gone, to the eye.)
    expect(bigFar.most).toBeLessThan(big.most / 3);
  });
});
