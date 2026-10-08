import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LocalBirds } from './localBirds.js';

/** Steps them `seconds` on at 20 steps a second. */
function run(b: LocalBirds, eye: THREE.Vector3, seconds: number): void {
  for (let i = 0; i < seconds * 20; i++) b.update(0.05, eye);
}

describe('LocalBirds', () => {
  beforeEach(() => {
    let r = 0.37;
    vi.spyOn(Math, 'random').mockImplementation(() => (r = (r * 9301 + 49297) % 233280) / 233280);
  });
  afterEach(() => vi.restoreAllMocks());

  it('come in, land on the trees about you, sit a while, and fly on', () => {
    // Trees everywhere: their tops 6 m up.
    const birds = new LocalBirds({ topAt: () => ({ y: 6, leaves: true }), brightness: () => 1 });
    const eye = new THREE.Vector3(0, 1.6, 0);
    run(birds, eye, 40);
    const states = birds.birds.map((b) => b.state);
    expect(states.filter((s) => s !== 'gone').length).toBeGreaterThan(1);
    const perched = birds.birds.filter((b) => b.state === 'perched');
    expect(perched.length).toBeGreaterThan(0);
    for (const b of perched) {
      expect(b.pos.y).toBeCloseTo(6.05, 5);
      expect(Math.hypot(b.pos.x, b.pos.z)).toBeLessThanOrEqual(40);
    }
    // Over a few minutes each has been on the move more than once (none sits for good).
    const moved = new Set<number>();
    for (let t = 0; t < 120; t++) {
      run(birds, eye, 1);
      birds.birds.forEach((b, i) => b.state === 'flying' && moved.add(i));
    }
    expect(moved.size).toBe(birds.birds.length);
  });

  it('one perched too near you takes off', () => {
    const birds = new LocalBirds({ topAt: () => ({ y: 0, leaves: false }), brightness: () => 1 });
    const eye = new THREE.Vector3(0, 1.6, 0);
    let sat: (typeof birds.birds)[number] | undefined;
    for (let t = 0; t < 120 && !sat; t++) {
      run(birds, eye, 1);
      sat = birds.birds.find((b) => b.state === 'perched');
    }
    expect(sat).toBeDefined();
    // Walk right up to it.
    const near = sat!.pos.clone().setY(sat!.pos.y + 1.6);
    birds.update(0.05, near);
    expect(sat!.state).not.toBe('perched');
  });

  it('with nowhere to sit, they come and go', () => {
    const birds = new LocalBirds({ topAt: () => null, brightness: () => 1 });
    const eye = new THREE.Vector3(0, 1.6, 0);
    const seen = new Set<string>();
    for (let t = 0; t < 120; t++) {
      run(birds, eye, 1);
      for (const b of birds.birds) seen.add(b.state);
    }
    expect(seen.has('perched')).toBe(false);
    expect(seen.has('leaving')).toBe(true);
    expect(seen.has('gone')).toBe(true);
  });
});
