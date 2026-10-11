import { describe, expect, it } from 'vitest';
import { UNITS_PER_METER, type Outlaw } from '@super-vox/shared';
import { OutlawSim, type OutlawMobs, type OutlawWorld } from './outlawSim.js';
import { SiteSearch } from './siteSearch.js';
import { VillageSim, type VillageWorld } from './villageSim.js';

const M = UNITS_PER_METER;
const T0 = 1_800_000_000_000;

/** Places 1..n, none of them any good (null), or the one numbered `good`. */
function* places(n: number, good = -1): Generator<number | null, null> {
  for (let i = 1; i <= n; i++) yield i === good ? i : null;
  return null;
}

describe('looking for somewhere to settle', () => {
  it('a few places a step, one group at a time; a group that found nowhere rests, then looks again', () => {
    const s = new SiteSearch<number>(3, 60_000);
    let started = 0;
    const start = (ids: number[], n: number, good?: number) => () => (started++, { ids, places: places(n, good) });
    // Found on the second step (the fifth place).
    expect(s.step(0, start([1, 2], 10, 5))).toBeNull();
    expect(s.free(1, 0)).toBe(false);
    expect(s.step(1, start([3, 4], 10))).toEqual({ ids: [1, 2], site: 5 });
    expect(started).toBe(1);
    // Nowhere in seven places: three steps, then they rest a minute.
    expect([s.step(2, start([3, 4], 7)), s.step(3, start([5], 1)), s.step(4, start([5], 1))]).toEqual([null, null, null]);
    expect(started).toBe(2);
    expect(s.free(3, 5)).toBe(false);
    expect(s.free(3, 4 + 60_000)).toBe(true);
    expect(s.free(1, 5)).toBe(true);
  });

  /** Ground everywhere too steep to settle (rising a metre a metre east): every place looked at samples all of its ground. */
  const steep = (x: number) => ({ h: x, water: false, tree: false, land: true });

  it("outlaws: loners who've met but can find nowhere to camp look at the ground only so much a second (it was thousands of times each, every second)", () => {
    let looked = 0;
    const w: OutlawWorld = {
      config: { widthUnits: 16000 * M, depthUnits: 16000 * M },
      terrainAt: (x) => (looked++, steep(x)),
      buildWorks: async () => [],
      editedNear: () => false,
      settlements: () => [],
    };
    // Twenty loners, in pairs 1 km apart.
    const outlaws: Outlaw[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `o${i}`, look: '', x: (2000 + Math.floor(i / 2) * 1000 + (i % 2) * 10) * M, y: 10 * M, z: 3000 * M, health: 20, camp: null, archer: false }));
    const sim = new OutlawSim(w, { outlaws, camps: [], cells: [], next: 100 }, () => 0.5);
    const mobs: OutlawMobs = { addOutlaw: () => ({ id: 0 }), remove: () => {}, get: () => undefined };
    const far = [{ x: 15000 * M, z: 15000 * M }];
    const perSecond: number[] = [];
    let now = T0;
    for (let s = 0; s < 300; s++) {
      looked = 0;
      for (let i = 0; i < 10; i++) sim.step(0.1, (now += 100), far, mobs);
      perSecond.push(looked);
    }
    expect(sim.list()).toHaveLength(0);
    // (A place a second, 25 samples; and a few for the tenth of them wandering.)
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(25 + 2 * 10);
    // Still looking, a group at a time, after they've rested: not given up.
    expect(perSecond.slice(150).some((n) => n >= 25)).toBe(true);
  });

  it("villages: wanderers who've met but can find nowhere to settle look at the ground only so much a second", () => {
    let looked = 0;
    const w: VillageWorld = {
      config: { widthUnits: 16000 * M, depthUnits: 16000 * M },
      terrainAt: (x) => (looked++, steep(x)),
      buildWorks: async () => [],
      editedNear: () => false,
    };
    // Thirty wanderers, in threes 1 km apart.
    const villagers = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `v${i}`, look: '', x: (2000 + Math.floor(i / 3) * 1000 + (i % 3) * 5) * M, y: 10 * M, z: 3000 * M, yaw: 0, home: null }));
    const sim = new VillageSim(w, { villagers, villages: [], cells: [], next: 100 });
    const far = [{ x: 15000 * M, z: 15000 * M }];
    const perSecond: number[] = [];
    let now = T0;
    for (let s = 0; s < 300; s++) {
      looked = 0;
      for (let i = 0; i < 10; i++) sim.step(0.1, (now += 100), far, false);
      perSecond.push(looked);
    }
    expect(sim.list()).toHaveLength(0);
    // (A place a second, 81 samples, some of them looked up before; and a few for their wandering.)
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(81 + 30 * 10);
    expect(perSecond.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
