import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Cover } from './terraformArea.js';
import { SPECIES_SPEC, WildlifeSim, type Species } from './wildlife.js';

/** Forest north of z 0, grass from there to z 100, water beyond; flat ground. The view looks at (0, 0, 50). */
function land(camera = new THREE.Vector3(0, 300, 350)) {
  const coverAt = (_x: number, z: number) => (z < 0 ? Cover.Forest : z < 100 ? Cover.Open : Cover.None);
  const view = { groundAt: () => 0, coverAt, target: () => new THREE.Vector3(0, 0, 50), camera: () => camera.clone() };
  let r = 0.42;
  const random = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  return { sim: new WildlifeSim(view, random), coverAt, camera };
}
const run = (sim: WildlifeSim, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.05) sim.update(0.05);
};

describe('wildlife', () => {
  it('comes about the view, each kind on open ground by the forest (as near as it likes), none in the water', () => {
    const { sim, coverAt } = land();
    // (Just as they appear: grazing where they came, before wandering.)
    for (let t = 0; t < 3; t += 0.05) sim.update(0.05);
    const kinds = new Set(sim.groups.map((g) => g.species));
    expect(kinds).toEqual(new Set<Species>(['deer', 'boar', 'rabbit']));
    for (const g of sim.groups)
      for (const a of g.animals) {
        expect(coverAt(a.x, a.z)).toBe(Cover.Open);
        expect(a.z).toBeLessThanOrEqual(SPECIES_SPEC[g.species].edge + 0.01);
      }
  });

  it('keeps out of the water while wandering about for a long while', () => {
    const { sim, coverAt } = land();
    run(sim, 120);
    expect(sim.count).toBeGreaterThan(0);
    for (const g of sim.groups) for (const a of g.animals) expect(coverAt(a.x, a.z)).not.toBe(Cover.None);
    // Some of them moved.
    expect(sim.groups.some((g) => g.animals.some((a) => a.state !== 'graze'))).toBe(true);
  });

  it('runs from the camera when it comes close', () => {
    const { sim, camera } = land();
    run(sim, 10);
    const deer = sim.groups.find((g) => g.species === 'deer')!;
    const a = deer.animals[0]!;
    // The camera comes down beside it.
    camera.set(a.x + 5, a.y + 3, a.z);
    const before = a.x;
    run(sim, 0.5);
    expect(a.state).toBe('run');
    expect(a.x).toBeLessThan(before); // away from the camera (to its east)
    expect(SPECIES_SPEC.deer.run).toBeGreaterThan(SPECIES_SPEC.deer.walk);
  });

  it('are none when the view is far off, or when turned off', () => {
    const far = land(new THREE.Vector3(0, 3000, 2000));
    run(far.sim, 5);
    expect(far.sim.count).toBe(0);
    const { sim } = land();
    run(sim, 5);
    expect(sim.count).toBeGreaterThan(0);
    sim.enabled = false;
    run(sim, 0.1);
    expect(sim.count).toBe(0);
  });
});
