import { describe, expect, it } from 'vitest';
import { Item } from './items.js';
import { Material } from './materials.js';
import { voxelMiningTime } from './mining.js';
import { RECIPES } from './recipes.js';
import { WRONG_TOOL_PENALTY, canHarvest, dropOf, isTool, toolFactor } from './tools.js';

describe('tools', () => {
  it('mine their own materials faster, stone tools faster than wooden ones; others as by hand', () => {
    expect(voxelMiningTime(Material.Dirt, 16)).toBe(0.75);
    expect(voxelMiningTime(Material.Dirt, 16, Item.WoodenShovel)).toBe(0.375);
    expect(voxelMiningTime(Material.Dirt, 16, Item.StoneShovel)).toBeCloseTo(0.1875, 9);
    expect(voxelMiningTime(Material.Wood, 16, Item.StoneAxe)).toBe(0.5);
    expect(voxelMiningTime(Material.Sand, 16, Item.WoodenShovel)).toBe(0.3);
    expect(toolFactor(Material.Dirt, Item.StoneAxe)).toBe(1); // (the wrong tool: as by hand)
    expect(toolFactor(Material.Wood, Item.StoneSword)).toBe(1); // (not a tool)
    expect(toolFactor(Material.Leaves, Item.StonePickaxe)).toBe(1);
  });

  it('are needed for stone and ores: without the pickaxe (tier) needed, far slower and nothing given', () => {
    // Stone: by hand, three times its hardness, and nothing; any pickaxe: cobblestone.
    expect(voxelMiningTime(Material.Stone, 16)).toBe(3 * WRONG_TOOL_PENALTY);
    expect(voxelMiningTime(Material.Stone, 16, Item.StoneAxe)).toBe(3 * WRONG_TOOL_PENALTY);
    expect(voxelMiningTime(Material.Stone, 16, Item.StonePickaxe)).toBe(0.75);
    expect(dropOf(Material.Stone)).toBeNull();
    expect(dropOf(Material.Stone, Item.WoodenAxe)).toBeNull();
    expect(dropOf(Material.Stone, Item.WoodenPickaxe)).toBe(Material.Cobblestone);
    expect(dropOf(Material.Cobblestone)).toBeNull();
    // Coal ore: coal with any pickaxe.
    expect(dropOf(Material.CoalOre, Item.WoodenPickaxe)).toBe(Material.Coal);
    expect(dropOf(Material.CoalOre)).toBeNull();
    // Iron ore: a stone pickaxe at least (a wooden one is as slow as a hand, and gets nothing).
    expect(canHarvest(Material.IronOre, Item.WoodenPickaxe)).toBe(false);
    expect(dropOf(Material.IronOre, Item.WoodenPickaxe)).toBeNull();
    expect(voxelMiningTime(Material.IronOre, 16, Item.WoodenPickaxe)).toBe(3.5 * WRONG_TOOL_PENALTY);
    expect(dropOf(Material.IronOre, Item.StonePickaxe)).toBe(Material.RawIron);
    expect(voxelMiningTime(Material.IronOre, 16, Item.StonePickaxe)).toBe(0.875);
    // What needs nothing still gives the same by hand.
    expect(dropOf(Material.Grass)).toBe(Material.Dirt);
    expect(dropOf(Material.Wood)).toBe(Material.Wood);
    expect(dropOf(Material.Leaves, Item.StoneAxe)).toBeNull();
  });

  it('are made at a crafting table: planks or cobblestone, and sticks', () => {
    const made = (item: number) => RECIPES.find((r) => r.output[0] === item);
    expect(made(Item.WoodenPickaxe)).toMatchObject({ inputs: [[Material.Planks, 3], [Item.Stick, 2]], table: true });
    expect(made(Item.StonePickaxe)).toMatchObject({ inputs: [[Material.Cobblestone, 3], [Item.Stick, 2]], table: true });
    expect(made(Item.StoneShovel)).toMatchObject({ inputs: [[Material.Cobblestone, 1], [Item.Stick, 2]], table: true });
    for (const t of [Item.WoodenPickaxe, Item.StonePickaxe, Item.WoodenAxe, Item.StoneAxe, Item.WoodenShovel, Item.StoneShovel]) {
      expect(isTool(t)).toBe(true);
      expect(made(t)).toBeDefined();
    }
    expect(isTool(Item.StoneSword)).toBe(false);
    expect(isTool(null)).toBe(false);
  });
});
