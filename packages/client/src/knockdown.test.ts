import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { KNOCKDOWN_REACH, Knockdown, knockdownFor } from './knockdown.js';
import { ExplosionView } from './explosions.js';

describe('knockdownFor', () => {
  it('only within reach; harder and longer the bigger and nearer', () => {
    expect(knockdownFor(16 * KNOCKDOWN_REACH, 16, { x: 1, z: 0 })).toBeNull();
    expect(knockdownFor(5, 2.3, { x: 1, z: 0 })).toBeNull();
    // (Anywhere its crater can reach: its lobes go about 1.5 radii.)
    expect(knockdownFor(2.3 * 1.55, 2.3, { x: 1, z: 0 })).not.toBeNull();
    const smallNear = knockdownFor(1, 2.3, { x: 1, z: 0 })!, bigNear = knockdownFor(1, 16, { x: 1, z: 0 })!, bigFar = knockdownFor(20, 16, { x: 1, z: 0 })!;
    expect(bigNear.strength).toBeGreaterThan(smallNear.strength);
    expect(bigNear.strength).toBeGreaterThan(bigFar.strength);
    expect(bigNear.duration).toBeGreaterThan(smallNear.duration);
    expect(bigNear.strength).toBeLessThanOrEqual(1);
  });

  it('throws you away from the blast', () => {
    // (Blast to the east: thrown west.)
    expect(knockdownFor(2, 8, { x: 3, z: 0 })!.away).toEqual({ x: -1, z: -0 });
  });
});

describe('Knockdown', () => {
  /** Runs one through at 60 fps: the poses, and how far it threw you. */
  function run(k: ReturnType<typeof knockdownFor>) {
    const kd = new Knockdown();
    kd.begin(k!);
    const poses = [];
    let x = 0, z = 0;
    for (let i = 0; i < 60 * 10; i++) {
      const p = kd.update(1 / 60);
      if (!p) break;
      poses.push(p);
      x += p.shove.x;
      z += p.shove.z;
    }
    return { poses, x, z, done: !kd.active };
  }

  it('falls, lies, gets up, and is over after its duration (moving locked till then)', () => {
    const k = knockdownFor(1, 16, { x: 0, z: 2 }, 1)!;
    const { poses, done } = run(k);
    expect(done).toBe(true);
    expect(poses.length).toBeCloseTo(k.duration * 60, -1);
    const lowest = Math.max(...poses.map((p) => p.drop));
    expect(lowest).toBeCloseTo(1.25, 2);
    expect(poses.at(-1)!.drop).toBeLessThan(0.01);
    // (Rolled to its side while down.)
    expect(Math.max(...poses.map((p) => p.roll))).toBeGreaterThan(0.5);
  });

  it('throws you up to 3 m (the hardest), away from the blast', () => {
    const k = knockdownFor(0.5, 16, { x: 0, z: 2 })!;
    const { x, z } = run(k);
    expect(x).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(-3 * k.strength, 2);
  });

  it('a weaker blast does not cut short a harder one', () => {
    const kd = new Knockdown();
    const hard = knockdownFor(1, 16, { x: 1, z: 0 })!;
    kd.begin(hard);
    kd.update(0.5);
    kd.begin(knockdownFor(3, 2.3, { x: 1, z: 0 })!);
    let t = 0.5;
    while (kd.update(1 / 60)) t += 1 / 60;
    expect(t).toBeCloseTo(hard.duration, 1);
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
