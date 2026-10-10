import { describe, expect, it } from 'vitest';
import { CROP_STAGE_MS, FLAT_WORLD_16KM, FlatGenerator, Material, RIPE, UNITS_PER_METER, defaultFlatGen } from '@super-vox/shared';
import { World } from './world.js';

const M = UNITS_PER_METER;

describe('farming wheat', () => {
  it('tills ground into farmland, sows wheat on it, harvests it ripe; the crop gone with its farmland', () => {
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    // (Flat ground's top at y 0: the block under it, ground: grass or dirt, either tilled.)
    const x = 1000 * M + 8, z = 1000 * M + 8, y = -8;
    expect([Material.Grass, Material.Dirt]).toContain(world.materialAtUnit(x, y, z));
    expect(world.sow(x, y, z, 0)).toMatch(/farmland/);
    expect(world.till(x, y + 2 * M, z)).toMatch(/only grass or dirt/);
    const tilled = world.till(x, y, z);
    expect(Array.isArray(tilled) && tilled.length).toBeGreaterThan(0);
    expect(world.materialAtUnit(x, y, z)).toBe(Material.Farmland);
    expect(world.sow(x, y, z, 1000)).toBe(true);
    expect(world.sow(x, y, z, 1000)).toMatch(/sown already/);
    expect(world.cropList()).toEqual([[1000, -1, 1000, 1000]]);
    expect(world.harvest(x, y, z, 1000 + CROP_STAGE_MS)).toMatch(/not ripe yet/);
    expect(world.harvest(x, y, z, 1000 + CROP_STAGE_MS * RIPE)).toBe(true);
    expect(world.harvest(x, y, z, 1000 + CROP_STAGE_MS * RIPE)).toMatch(/nothing sown/);
    // Sown again, then its farmland dug away: the crop's gone too.
    expect(world.sow(x, y, z, 5000)).toBe(true);
    const far = world.applyEdit({ op: 'remove', x: x + 64 * M, y: -16, z: z - 8 });
    expect(far && world.cropsLostTo(far)).toBe(false);
    expect(world.cropList()).toHaveLength(1);
    const dug = world.applyEdit({ op: 'remove', x: x - 8, y: -16, z: z - 8 });
    expect(dug && world.cropsLostTo(dug)).toBe(true);
    expect(world.cropList()).toEqual([]);
    // Sown again, then a block put on it: gone.
    world.till(x + M, y, z);
    expect(world.sow(x + M, y, z, 6000)).toBe(true);
    const put = world.applyEdit({ op: 'place', x: x + M - 8, y: 0, z: z - 8, size: 16, material: Material.Stone });
    expect(put && world.cropsLostTo(put)).toBe(true);
    expect(world.cropList()).toEqual([]);
  });
});
