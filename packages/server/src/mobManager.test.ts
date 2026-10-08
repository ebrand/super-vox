import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, MOBS, Material, darkEnoughForZombies, defaultFlatGen, lightAt } from '@super-vox/shared';
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
    expect(mobs.attack(pig.id, eye.x - 10 * M, eye.y, eye.z, 4, 4.5, 0)).toEqual({ hit: false, killed: false, kind: 'pig' }); // 12 m away
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 4, 4.5, 0)).toMatchObject({ hit: true, killed: false, kind: 'pig' });
    expect(pig.health).toBe(MOBS.pig.health - 4);
    expect(pig.pushX).toBeGreaterThan(0); // away from the player (east)
    // (Killed: where it was, for what it drops.)
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 10, 4.5, 100)).toMatchObject({ hit: true, killed: true, kind: 'pig', at: { y: 0 } });
    expect(mobs.get(pig.id)).toBeUndefined();
    expect(mobs.attack(pig.id, eye.x, eye.y, eye.z, 10, 4.5, 200)).toEqual({ hit: false, killed: false });
  });
});

describe('zombies in the dark', () => {
  /**
   * A stand-in world: grassy ground at y = 0, and (`roof`) rock over everything at 4..5 m, so it's
   * dark under it by day; `lit`: torchlight everywhere.
   */
  function fake(opts: { roof: boolean; lit?: boolean }) {
    const solidBlock = (by: number) => by < 0 || (opts.roof && by === 4);
    const lightWorld = { opaque: (_x: number, y: number) => solidBlock(y), glow: () => (opts.lit ? 14 : 0), skyOpen: (_x: number, y: number) => (opts.roof ? y > 4 : y >= 0) };
    const world = {
      config: FLAT_WORLD_16KM,
      solidAt: (_x: number, y: number) => solidBlock(Math.floor(y / M)),
      materialAtUnit: (_x: number, y: number) => (y < 0 ? Material.Grass : solidBlock(Math.floor(y / M)) ? Material.Stone : 0),
      lightAt: (bx: number, by: number, bz: number, want: { sky?: boolean; block?: boolean; reach?: number }) => lightAt(lightWorld, bx, by, bz, want),
      skyOpenAt: (bx: number, by: number) => lightWorld.skyOpen(bx, by),
    } as unknown as World;
    let r = 0.37;
    const mobs = new MobManager(world, () => (r = ((r * 9301 + 49297) % 233280) / 233280));
    return { mobs, player: { id: 1, x: 8000 * M, y: 0, z: 8000 * M, vulnerable: true } };
  }
  const zombies = (mobs: MobManager, p: { x: number; z: number }) => mobs.near(p.x, p.z, 96 * M, 0).filter((e) => e.kind === 'zombie');

  it('come by day where it is dark (under a roof, as in a cave), and do not burn there', () => {
    const { mobs, player } = fake({ roof: true });
    run(mobs, [player], 30, false);
    expect(zombies(mobs, player).length).toBeGreaterThan(0);
    const z = zombies(mobs, player)[0]!;
    expect(z.health).toBe(MOBS.zombie.health);
  });

  it('come by day nowhere in daylight, and pigs still do', () => {
    const { mobs, player } = fake({ roof: false });
    run(mobs, [player], 15, false);
    expect(zombies(mobs, player)).toHaveLength(0);
    expect(mobs.near(player.x, player.z, 96 * M, 0).some((e) => e.kind === 'pig')).toBe(true);
  });

  it('never come where torchlight reaches, even at night', () => {
    const { mobs, player } = fake({ roof: false, lit: true });
    run(mobs, [player], 20, true);
    expect(zombies(mobs, player)).toHaveLength(0);
  });

  it('say what dark enough is', () => {
    expect(darkEnoughForZombies({ sky: 15, block: 0 }, true)).toBe(true);
    expect(darkEnoughForZombies({ sky: 15, block: 1 }, true)).toBe(false);
    expect(darkEnoughForZombies({ sky: 7, block: 0 }, false)).toBe(true);
    expect(darkEnoughForZombies({ sky: 8, block: 0 }, false)).toBe(false);
  });
});
