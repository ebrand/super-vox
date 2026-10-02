import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MOBS, defaultFlatGen } from '@super-vox/shared';
import { MobManager } from './mobManager.js';
import { World } from './world.js';

const M = 16;
/** A flat grassy world (ground at y = 0) and a player standing in the middle of it. */
function setup() {
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  let r = 0.21;
  const mobs = new MobManager(world, () => (r = ((r * 9301 + 49297) % 233280) / 233280));
  const player = { id: 1, x: 8000 * M, y: 0, z: 8000 * M, vulnerable: true };
  return { world, mobs, player };
}
/** Steps for `seconds` at 10 steps a second from `t0`; returns the hits. */
function run(mobs: MobManager, players: { id: number; x: number; y: number; z: number; vulnerable: boolean }[], seconds: number, night: boolean, t0 = 0) {
  const hits = [];
  for (let i = 0; i < seconds * 10; i++) hits.push(...mobs.step(0.1, t0 + i * 100, players, night));
  return hits;
}

describe('MobManager', () => {
  it('fills the day around a player with pigs on the grass, and the night with zombies too', () => {
    const { mobs, player } = setup();
    run(mobs, [player], 12, false);
    const near = () => mobs.near(player.x, player.z, 96 * M, 0);
    expect(near().filter((e) => e.kind === 'pig').length).toBe(4);
    expect(near().some((e) => e.kind === 'zombie')).toBe(false);
    for (const e of near()) {
      const d = Math.hypot(e.x - player.x, e.z - player.z) / M;
      expect(d).toBeGreaterThan(15); // appeared out at 24..48 m (and may have wandered a little)
      expect(e.y).toBe(0); // on the ground
    }
    run(mobs, [player], 12, true, 20_000);
    expect(near().filter((e) => e.kind === 'zombie').length).toBeGreaterThan(0);
  });

  it('lets mobs go when nobody is near, and burns zombies away by day', () => {
    const { mobs, player } = setup();
    const z = mobs.add('zombie', player.x + 30 * M, 0, player.z, 0);
    run(mobs, [player], 25, false);
    expect(mobs.get(z.id)).toBeUndefined(); // 20 health, a point a second
    mobs.add('pig', player.x + 5 * M, 0, player.z, 0);
    const before = mobs.count;
    run(mobs, [{ ...player, x: player.x + 1000 * M }], 0.2, false, 30_000);
    expect(mobs.count).toBeLessThan(before);
  });

  it('chases and hits a vulnerable player at night', () => {
    const { mobs, player } = setup();
    mobs.add('zombie', player.x + 6 * M, 0, player.z, 0);
    const hits = run(mobs, [player], 6, true);
    expect(hits.filter((h) => h.player === 1).length).toBeGreaterThan(0);
    expect(hits[0]!.damage).toBe(MOBS.zombie.damage);
  });

  it('takes hits only within reach, and they knock back and kill', () => {
    const { mobs, player } = setup();
    const pig = mobs.add('pig', player.x + 2 * M, 0, player.z, 0);
    const eye = { x: player.x, y: 1.62 * M, z: player.z };
    expect(mobs.attack(pig.id, eye.x - 10 * M, eye.y, eye.z, 4, 4.5, 0)).toEqual({ hit: false, killed: false }); // 12 m away
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 4, 4.5, 0)).toEqual({ hit: true, killed: false });
    expect(pig.health).toBe(MOBS.pig.health - 4);
    expect(pig.pushX).toBeGreaterThan(0); // away from the player (east)
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 10, 4.5, 100)).toEqual({ hit: true, killed: true });
    expect(mobs.get(pig.id)).toBeUndefined();
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 10, 4.5, 200)).toEqual({ hit: false, killed: false });
  });
});
