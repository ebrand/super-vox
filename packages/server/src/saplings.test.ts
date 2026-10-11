import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, FlatGenerator, Item, Material, SAPLING_GROW_MS, TreeKind, UNITS_PER_METER, defaultFlatGen, grownTree, treeVoxels } from '@super-vox/shared';
import { World } from './world.js';

const M = UNITS_PER_METER;

describe('saplings', () => {
  it("each kind's tree is made as the world's trees of its kind are: a trunk from its foot, its leaves over it", () => {
    for (const [kind, leaves] of [[TreeKind.Broadleaf, Material.Leaves], [TreeKind.Conifer, Material.Needles], [TreeKind.Jungle, Material.JungleLeaves], [TreeKind.Acacia, Material.AcaciaLeaves]] as const) {
      const t = grownTree(kind, 100 * M + 8, 0, 100 * M + 8, 0);
      expect(t.kind).toBe(kind);
      const v = treeVoxels(t);
      expect(v.some((p) => p.material === Material.Wood && p.y <= 0 && p.y + p.size > 0)).toBe(true);
      expect(v.some((p) => p.material === leaves && p.y > M)).toBe(true);
      // (The same tree each time it's made there.)
      expect(treeVoxels(grownTree(kind, 100 * M + 8, 0, 100 * M + 8, 0))).toEqual(v);
    }
  });

  it('are planted on grass or dirt, grow into a tree in time (only where there is room), and are lost when dug or built over', () => {
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    // (Flat ground's top at y 0: the block under it, grass or dirt; a sapling goes in the block over it.)
    const x = 1000 * M + 8, z = 1000 * M + 8, y = -8;
    expect(world.plant(x, y, z, Item.Wheat, 0)).toMatch(/isn't a sapling/);
    expect(world.plant(x, y - 3 * M, z, Item.OakSapling, 0)).toMatch(/grass or dirt/);
    expect(world.plant(x, y, z, Item.OakSapling, 1000)).toBe(true);
    expect(world.plant(x, y, z, Item.OakSapling, 1000)).toMatch(/planted there already/);
    expect(world.saplingList()).toEqual([[1000, 0, 1000, Item.OakSapling, 1000]]);
    // A block put right beside the sapling (a build in the tree's way): kept as it is.
    world.applyEdit({ op: 'place', x: x + M - 8, y: 2 * M, z: z - 8, size: 16, material: Material.Stone });
    // Not grown yet; then grown: a trunk where the sapling was, leaves above, the sapling gone.
    expect(world.growSaplings(1000 + SAPLING_GROW_MS - 1)).toBeNull();
    expect(world.saplingList()).toHaveLength(1);
    const grew = world.growSaplings(1000 + SAPLING_GROW_MS);
    expect(grew && grew.changes.length).toBeGreaterThan(0);
    expect(world.saplingList()).toEqual([]);
    expect(world.materialAtUnit(x, M + 8, z)).toBe(Material.Wood);
    expect(world.materialAtUnit(x + M, 2 * M + 8, z)).toBe(Material.Stone);
    let leaves = 0;
    for (let dy = 3; dy < 30; dy++) for (let dx = -4; dx <= 4; dx++) if (world.materialAtUnit(x + dx * M, dy * M + 8, z) === Material.Leaves) leaves++;
    expect(leaves).toBeGreaterThan(0);
    // Planted again elsewhere: dug from under, then one with a block put in it: gone.
    expect(world.plant(x + 20 * M, y, z, Item.PineSapling, 5000)).toBe(true);
    const dug = world.applyEdit({ op: 'removeBox', x: x + 20 * M - 8, y: -16, z: z - 8, size: 16 });
    expect(dug && world.saplingsLostTo(dug)).toBe(true);
    expect(world.saplingList()).toEqual([]);
    expect(world.plant(x + 30 * M, y, z, Item.PineSapling, 5000)).toBe(true);
    const far = world.applyEdit({ op: 'remove', x: x + 90 * M, y: -16, z: z - 8 });
    expect(far && world.saplingsLostTo(far)).toBe(false);
    const put = world.applyEdit({ op: 'place', x: x + 30 * M - 8, y: 0, z: z - 8, size: 16, material: Material.Stone });
    expect(put && world.saplingsLostTo(put)).toBe(true);
    expect(world.saplingList()).toEqual([]);
  });
});
