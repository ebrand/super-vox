import { describe, expect, it } from 'vitest';
import { BLOCK_VOLUME, HOTBAR_SLOTS, Item, Material, waterMaterial } from '@super-vox/shared';
import { starterInventory, type Inventory } from './inventories.js';
import { PlayerInventory } from './playerInventory.js';

const B = BLOCK_VOLUME;
const place = (material: number, size = 16) => ({ op: 'place' as const, x: 0, y: 0, z: 0, size, material });

function survival(inv: Inventory = starterInventory()) {
  const saves: Inventory[] = [];
  const p = new PlayerInventory('survival', inv, async (i) => void saves.push(i), 20);
  return { p, saves };
}

describe('PlayerInventory', () => {
  it('throws away what you ask (up to what you have), in survival only', () => {
    const { p } = survival({ items: new Map([[Material.Dirt, 3 * BLOCK_VOLUME], [Item.Stick, 5]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    expect(p.discard(Item.Stick, 2)).toBeNull();
    expect(p.count(Item.Stick)).toBe(3);
    expect(p.discard(Material.Dirt, 99 * BLOCK_VOLUME)).toBeNull(); // (all there is)
    expect(p.message().items.find(([id]) => id === Material.Dirt)).toBeUndefined();
    expect(p.discard(Material.Sand, 1)).toMatch(/no sand/);
    const creative = new PlayerInventory('creative', { items: new Map(), hotbar: [] }, async () => {});
    expect(creative.discard(Material.Dirt, 1)).toMatch(/creative/);
  });

  it('turns crafting tables saved as a material (by volume) into crafting-table items', () => {
    const { p } = survival({ items: new Map([[Material.CraftingTable, 2 * BLOCK_VOLUME], [Material.Dirt, BLOCK_VOLUME]]), hotbar: [Material.CraftingTable, null, null, null, null, null, null, null, null, null] });
    expect(new Map(p.message().items)).toEqual(new Map([[Item.CraftingTable, 2], [Material.Dirt, BLOCK_VOLUME]]));
    expect(p.message().hotbar[0]).toBe(Item.CraftingTable);
  });

  it('gives a hotbar saved before there were ten slots the slots it lacks, empty', () => {
    const { p } = survival({ items: new Map(), hotbar: [Material.Dirt, null, null, null, null, null, null, null, Material.Stone] });
    expect(p.message().hotbar).toEqual([Material.Dirt, null, null, null, null, null, null, null, Material.Stone, null]);
  });

  it('in survival, lets you place only what you have enough of, and no water', () => {
    const { p } = survival();
    expect(p.refuse(place(Material.Stone))).toBeNull();
    expect(p.refuse(place(Material.Sand))).toBe('not enough sand (have 0, need 1 blocks)');
    expect(p.refuse(place(Material.Water))).toBe("water can't be placed in survival");
    expect(p.refuse({ op: 'remove', x: 0, y: 0, z: 0 })).toBeNull();
    const { p: poor } = survival({ items: new Map([[Material.Stone, 63]]), hotbar: [] });
    expect(poor.refuse(place(Material.Stone, 4))).toMatch(/^not enough stone/); // a 1/4 m voxel is 64
    expect(poor.refuse(place(Material.Stone, 2))).toBeNull();
  });

  it('takes what was placed and gives what was mined, grass as dirt, leaves and water as nothing', () => {
    const { p } = survival();
    expect(p.apply(new Map([[Material.Stone, B]]))).toBe(true);
    expect(p.apply(new Map([[Material.Grass, -B / 2], [Material.Leaves, -B], [Material.Water, -64], [Material.Wood, -100]]))).toBe(true);
    expect(new Map(p.message().items)).toEqual(new Map([[Material.Dirt, 16.5 * B], [Material.Stone, 15 * B], [Material.Wood, 16 * B + 100]]));
    // Water flowing into a dug hole isn't charged; nothing changed, nothing to say.
    expect(p.apply(new Map([[waterMaterial(2), 512]]))).toBe(false);
    expect(p.apply(new Map([[Material.Leaves, -B]]))).toBe(false);
  });

  it('drops materials used up, and never goes below nothing', () => {
    const { p } = survival({ items: new Map([[Material.Sand, 100]]), hotbar: [] });
    p.apply(new Map([[Material.Sand, 4096]]));
    expect(p.message().items).toEqual([]);
  });

  it('in creative, everything placeable is unlimited and nothing is counted', () => {
    const p = new PlayerInventory('creative', { items: new Map(), hotbar: Array(HOTBAR_SLOTS).fill(null) }, async () => {});
    expect(p.refuse(place(Material.Sand))).toBeNull();
    expect(p.refuse(place(Material.Water))).toBeNull();
    expect(p.refuse(place(waterMaterial(1)))).toMatch(/can't be placed$/);
    expect(p.apply(new Map([[Material.Stone, -B]]))).toBe(false);
    expect(p.message()).toEqual({ type: 'inventory', mode: 'creative', items: [], hotbar: Array(HOTBAR_SLOTS).fill(null) });
  });

  it('takes a new hotbar of placeable materials only', () => {
    const { p } = survival();
    const hotbar = [Material.Sand, null, null, null, null, null, null, null, null, Material.Stone];
    expect(p.setHotbar(hotbar)).toBeNull();
    expect(p.message().hotbar).toEqual(hotbar);
    expect(p.setHotbar([waterMaterial(3), ...hotbar.slice(1)])).toMatch(/can't go on the hotbar/);
    expect(p.setHotbar(hotbar.slice(1))).toMatch(/slots/);
    expect(p.message().hotbar).toEqual(hotbar);
  });

  it('saves a moment after changes, once for a burst, and at once on flush', async () => {
    const { p, saves } = survival();
    p.apply(new Map([[Material.Stone, 64]]));
    p.apply(new Map([[Material.Stone, 64]]));
    expect(saves).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(saves).toHaveLength(1);
    expect(saves[0]!.items.get(Material.Stone)).toBe(16 * B - 128);
    p.setHotbar(Array(HOTBAR_SLOTS).fill(null));
    await p.flush();
    expect(saves).toHaveLength(2);
    await p.flush(); // nothing new
    expect(saves).toHaveLength(2);
  });

  it("crafts in survival, saying why not when it can't", () => {
    const { p } = survival();
    expect(p.craft('planks', false)).toBeNull();
    expect(new Map(p.message().items).get(Material.Planks)).toBe(4 * B);
    expect(p.craft('wooden-sword', false)).toBe('need 1 more stick');
    expect(p.craft('sticks', false)).toBeNull();
    expect(p.craft('wooden-sword', false)).toBe('needs a crafting table placed nearby');
    expect(p.craft('wooden-sword', true)).toBeNull();
    expect(new Map(p.message().items).get(Item.WoodenSword)).toBe(1);
    expect(p.craft('nope', true)).toBe('no recipe "nope"');
    const creative = new PlayerInventory('creative', { items: new Map(), hotbar: [] }, async () => {});
    expect(creative.craft('planks', true)).toMatch(/creative/);
  });

  it("puts items on the hotbar, but doesn't place them", () => {
    const { p } = survival();
    expect(p.setHotbar([Item.WoodenSword, Item.Door, null, null, null, null, null, null, null, Material.Cobblestone])).toBeNull();
    expect(p.refuse(place(Item.Door))).toBe("a door can't be placed yet");
  });
});

