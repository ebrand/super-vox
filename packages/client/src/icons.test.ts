import { ALL_ITEMS, Item, Material } from '@super-vox/shared';
import { describe, expect, it } from 'vitest';
import { iconSvg } from './icons.js';

describe('iconSvg', () => {
  it('has a picture for every item and block there is', () => {
    const ids = [...ALL_ITEMS, ...Object.values(Material).filter((m) => m !== 0), Item.Furnace, Item.Stove, Item.Anvil, Item.SmithingTable, Item.Bed, Item.Boat];
    for (const id of ids) {
      const svg = iconSvg(id);
      expect(svg, `item ${id}`).toMatch(/^<svg [^>]*viewBox="0 0 32 32"[^>]*>.*<\/svg>$/s);
      expect(svg, `item ${id}`).not.toMatch(/NaN|undefined/);
    }
  });

  it('draws tools of a kind alike and each tier in its own colours', () => {
    const picks = [Item.WoodenPickaxe, Item.StonePickaxe, Item.IronPickaxe].map(iconSvg);
    expect(new Set(picks).size).toBe(3);
    const shape = (s: string | null) => s!.replace(/rgb\([^)]*\)/g, '');
    expect(new Set(picks.map(shape)).size).toBe(1);
    const kinds = [Item.IronPickaxe, Item.IronAxe, Item.IronShovel, Item.IronSword].map((i) => shape(iconSvg(i)));
    expect(new Set(kinds).size).toBe(4);
  });

  it('tells ores, grass and plain stone apart', () => {
    const ids = [Material.Stone, Material.CoalOre, Material.IronOre, Material.CopperOre, Material.GoldOre, Material.Grass, Material.Dirt, Material.TNT, Material.Water];
    expect(new Set(ids.map(iconSvg)).size).toBe(ids.length);
  });

  it('draws what ores give as lumps, not blocks', () => {
    const cubeTop = '16,3 29,10 16,17 3,10';
    for (const m of [Material.Coal, Material.RawIron, Material.RawCopper, Material.RawGold]) expect(iconSvg(m)).not.toContain(cubeTop);
    expect(iconSvg(Material.Stone)).toContain(cubeTop);
  });

  it("leaves players' designs to their colour and initial", () => {
    expect(iconSvg(5000)).toBeNull();
  });
});
