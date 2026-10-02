import { describe, expect, it } from 'vitest';
import { MOBS, hurtMob, newMob, stepMob, type MobTarget } from './mobs.js';
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
});

