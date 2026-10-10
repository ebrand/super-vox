import { describe, expect, it } from 'vitest';
import { ARCHER_FAR, ARCHER_MS, ARCHER_NEAR, HOME_M, MOBS, hurtMob, newMob, stepMob, type MobTarget } from './mobs.js';
import type { SolidAt } from './physics.js';

const M = 16;
/** Flat ground: solid below y = 0, plus any extra solid cells. */
function ground(extra: (x: number, y: number, z: number) => boolean = () => false): SolidAt {
  return (x, y, z) => y < 0 || extra(x, y, z);
}
/** Runs a mob for `seconds` at 10 steps a second; returns the hits it made. */
function run(m: ReturnType<typeof newMob>, seconds: number, solid: SolidAt, players: MobTarget[] = [], t0 = 0) {
  const hits: { player: number; damage: number; at: number }[] = [];
  let r = 0.37;
  const random = () => (r = (r * 9301 + 49297) % 233280 / 233280);
  for (let i = 0; i < seconds * 10; i++) {
    const now = t0 + i * 100;
    const { hit } = stepMob(m, 0.1, now, solid, players, random);
    if (hit) hits.push({ ...hit, at: now });
  }
  return hits;
}

describe('mobs', () => {
  it('fall to the ground and wander about on it', () => {
    const pig = newMob(1, 'pig', 0, 5 * M, 0, 0);
    run(pig, 30, ground());
    expect(pig.y).toBeCloseTo(0, 5);
    expect(pig.walk.grounded).toBe(true);
    expect(Math.hypot(pig.x, pig.z)).toBeGreaterThan(M); // went somewhere
    expect(pig.health).toBe(MOBS.pig.health);
  });

  it("zombies chase a player they can hurt and hit about once a second, never one who can't be hurt", () => {
    const z = newMob(2, 'zombie', 10 * M, 0, 0, 0);
    const player: MobTarget = { id: 7, x: 0, y: 0, z: 0, vulnerable: true };
    const hits = run(z, 10, ground(), [player]);
    expect(Math.abs(z.x) / M).toBeLessThan(2); // caught up
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.every((h) => h.player === 7 && h.damage === MOBS.zombie.damage)).toBe(true);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.at - hits[i - 1]!.at).toBeGreaterThanOrEqual(MOBS.zombie.attackMs!);
    // Out of sight, or not vulnerable: left alone.
    const z2 = newMob(3, 'zombie', 40 * M, 0, 0, 0);
    expect(run(z2, 10, ground(), [player])).toEqual([]);
    const z3 = newMob(4, 'zombie', 3 * M, 0, 0, 0);
    expect(run(z3, 10, ground(), [{ ...player, vulnerable: false }])).toEqual([]);
  });

  it('hop over a low wall to get at you', () => {
    // A 1 m wall across the way at x = 5..6 m.
    const wall = ground((x, y) => x >= 5 * M && x < 6 * M && y >= 0 && y < M);
    const z = newMob(5, 'zombie', 10 * M, 0, 0, 0);
    const hits = run(z, 15, wall, [{ id: 1, x: 0, y: 0, z: 0, vulnerable: true }]);
    expect(z.x).toBeLessThan(5 * M);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('are knocked back when hurt, pigs run away, and die at no health', () => {
    const pig = newMob(6, 'pig', 0, 0, 0, 0);
    run(pig, 1, ground());
    const before = { x: pig.x, z: pig.z };
    expect(hurtMob(pig, 4, before.x - M, before.z, 1000)).toBe(false);
    expect(pig.health).toBe(MOBS.pig.health - 4);
    run(pig, 3, ground(), [], 1000);
    expect(pig.x - before.x).toBeGreaterThan(3 * M); // away from the hit (which came from -x)
    expect(hurtMob(pig, 10, 0, 0, 5000)).toBe(true);
  });

  it('climb out of the ground if they end up in it, instead of falling through', () => {
    const pig = newMob(9, 'pig', 0, -0.5 * M, 0, 0); // half a metre into the ground
    run(pig, 3, ground());
    expect(pig.y).toBeCloseTo(0, 5);
    expect(pig.walk.grounded).toBe(true);
  });

  it('outlaws go for villagers as well as players (zombies only players); swords close in and hit', () => {
    const villager: MobTarget = { id: 2_000_000_001, x: 6 * M, y: 0, z: 0, vulnerable: true, villager: true };
    const z = newMob(3, 'zombie', 0, 0, 0, 0);
    expect(run(z, 6, ground(), [villager])).toHaveLength(0);
    const o = Object.assign(newMob(4, 'outlaw', 0, 0, 0, 0), { home: null });
    const hits = run(o, 6, ground(), [villager]);
    expect(hits.length).toBeGreaterThan(2);
    expect(hits.every((h) => h.player === villager.id && h.damage === MOBS.outlaw.damage)).toBe(true);
    expect(o.swings).toBe(hits.length);
  });

  it("outlaws with bows keep their distance, shooting every ARCHER_MS; and outlaws keep about their home", () => {
    const player: MobTarget = { id: 9, x: 0, y: 0, z: 0, vulnerable: true };
    const a = Object.assign(newMob(5, 'outlaw', 3 * M, 0, 0, 0), { archer: true, home: null });
    const shots: number[] = [];
    let r = 0.5;
    const random = () => (r = (r * 9301 + 49297) % 233280 / 233280);
    for (let i = 0; i < 100; i++) {
      const res = stepMob(a, 0.1, i * 100, ground(), [player], random);
      if (res.shoot) shots.push(i * 100);
      expect(res.hit).toBeNull();
    }
    // Backed off from 3 m, to between near and far; shooting at the player.
    const d = Math.hypot(a.x, a.z) / M;
    expect(d).toBeGreaterThan(ARCHER_NEAR - 0.5);
    expect(d).toBeLessThan(ARCHER_FAR + 1);
    expect(shots.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < shots.length; i++) expect(shots[i]! - shots[i - 1]!).toBeGreaterThanOrEqual(ARCHER_MS);
    // With nobody about, wandering: never far from home.
    const w = Object.assign(newMob(6, 'outlaw', 0, 0, 0, 0), { home: { x: 0, z: 0 } });
    let far = 0;
    for (let i = 0; i < 1200; i++) {
      stepMob(w, 0.1, i * 100, ground(), [], random);
      far = Math.max(far, Math.hypot(w.x, w.z) / M);
    }
    expect(far).toBeLessThan(HOME_M * 1.6);
    expect(far).toBeGreaterThan(1);
  });
});
