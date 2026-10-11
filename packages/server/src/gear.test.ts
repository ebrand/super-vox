import { describe, expect, it } from 'vitest';
import { ARMOR_MAX_SHARE, BLOCK_VOLUME, DURABILITY, HOTBAR_SLOTS, Item, Material, RECIPES, armorShare, cannotCraft } from '@super-vox/shared';
import { MemoryInventoryStore, type Inventory } from './inventories.js';
import { PlayerInventory } from './playerInventory.js';

const B = BLOCK_VOLUME;
const inventory = (items: [number, number][]): Inventory => ({ items: new Map(items), hotbar: Array(HOTBAR_SLOTS).fill(null) });
function survival(inv: Inventory) {
  const saves: Inventory[] = [];
  const p = new PlayerInventory('survival', inv, async (i) => void saves.push(i), 1);
  return { p, saves };
}
const has = (p: PlayerInventory, item: number) => new Map(p.message().items).get(item) ?? 0;

describe('tools and weapons wear out', () => {
  it('a use at a time, the one in use; worn out, it breaks (one fewer, the next new)', () => {
    const { p } = survival(inventory([[Item.WoodenPickaxe, 2]]));
    const n = DURABILITY[Item.WoodenPickaxe]!;
    for (let i = 1; i < n; i++) expect(p.wearOut(Item.WoodenPickaxe)).toBe('worn');
    expect(p.wearOf(Item.WoodenPickaxe)).toBe(n - 1);
    expect(p.message().wear).toEqual([[Item.WoodenPickaxe, n - 1]]);
    expect(p.wearOut(Item.WoodenPickaxe)).toBe('broke');
    expect(has(p, Item.WoodenPickaxe)).toBe(1);
    expect(p.wearOf(Item.WoodenPickaxe)).toBe(0);
    // What doesn't wear, what isn't there, and creative: nothing.
    expect(p.wearOut(Item.Stick)).toBeNull();
    expect(p.wearOut(Item.IronSword)).toBeNull();
    const creative = new PlayerInventory('creative', inventory([[Item.WoodenPickaxe, 1]]), async () => {});
    expect(creative.wearOut(Item.WoodenPickaxe)).toBeNull();
    expect(creative.message().wear).toBeUndefined();
  });

  it('are mended whole with one of what they are made of (blocks by the block, ingots and leather by one)', () => {
    const { p } = survival(inventory([[Item.StoneAxe, 1], [Item.IronSword, 1], [Material.Cobblestone, 2 * B]]));
    expect(p.repair(Item.StoneAxe)).toMatch(/no worn stone axe/);
    p.wearOut(Item.StoneAxe, 50);
    p.wearOut(Item.IronSword, 10);
    expect(p.repair(Item.IronSword)).toMatch(/takes 1 iron ingot/);
    expect(p.repair(Item.StoneAxe)).toBeNull();
    expect(p.wearOf(Item.StoneAxe)).toBe(0);
    expect(has(p, Material.Cobblestone)).toBe(B);
    expect(p.repair(Item.Stick)).toMatch(/can't be mended/);
  });
});

describe('armor', () => {
  it('is put on a piece a slot (what was there back in the inventory), and taken off as worn as it is', () => {
    const { p } = survival(inventory([[Item.LeatherHelmet, 1], [Item.IronHelmet, 1], [Item.IronChestplate, 1], [Item.Stick, 1]]));
    expect(p.putOn(Item.Stick)).toMatch(/isn't armor/);
    expect(p.putOn(Item.LeatherHelmet)).toBeNull();
    expect(p.worn).toEqual([Item.LeatherHelmet, null, null, null]);
    expect(has(p, Item.LeatherHelmet)).toBe(0);
    expect(p.putOn(Item.LeatherHelmet)).toMatch(/no leather cap/);
    // The iron helmet in its place: the cap back.
    expect(p.putOn(Item.IronHelmet)).toBeNull();
    expect(p.putOn(Item.IronChestplate)).toBeNull();
    expect(p.worn).toEqual([Item.IronHelmet, Item.IronChestplate, null, null]);
    expect(has(p, Item.LeatherHelmet)).toBe(1);
    // Hits taken: each piece on worn; taken off, still worn; put on again, as worn.
    for (let i = 0; i < 5; i++) expect(p.wearArmor()).toEqual([]);
    expect(p.message().wornWear).toEqual([5, 5, 0, 0]);
    expect(p.takeOff(1)).toBeNull();
    expect(p.wearOf(Item.IronChestplate)).toBe(5);
    expect(p.takeOff(1)).toMatch(/nothing on there/);
    expect(p.putOn(Item.IronChestplate)).toBeNull();
    expect(p.message().wornWear).toEqual([5, 5, 0, 0]);
  });

  it('wears out with the hits taken and breaks; mended at an anvil while on', () => {
    const { p } = survival(inventory([[Item.LeatherBoots, 1], [Item.Leather, 1]]));
    p.putOn(Item.LeatherBoots);
    const n = DURABILITY[Item.LeatherBoots]!;
    for (let i = 1; i < n - 10; i++) p.wearArmor();
    expect(p.repair(Item.LeatherBoots)).toBeNull();
    expect(p.message().wornWear).toEqual([0, 0, 0, 0]);
    expect(has(p, Item.Leather)).toBe(0);
    for (let i = 1; i < n; i++) expect(p.wearArmor()).toEqual([]);
    expect(p.wearArmor()).toEqual([Item.LeatherBoots]);
    expect(p.worn).toEqual([null, null, null, null]);
  });

  it('takes a share of harm by its pieces: a leather suit 28%, iron 60%, at most 80%', () => {
    expect(armorShare([null, null, null, null])).toBe(0);
    expect(armorShare([Item.LeatherHelmet, Item.LeatherTunic, Item.LeatherLeggings, Item.LeatherBoots])).toBeCloseTo(0.28, 9);
    expect(armorShare([Item.IronHelmet, Item.IronChestplate, Item.IronLeggings, Item.IronBoots])).toBeCloseTo(0.6, 9);
    expect(armorShare([Item.IronChestplate, Item.IronChestplate, Item.IronChestplate, Item.IronChestplate])).toBe(ARMOR_MAX_SHARE);
  });

  it('is made of leather at a crafting table, of iron at a smithing table', () => {
    const tunic = RECIPES.find((r) => r.id === 'leather-tunic')!, plate = RECIPES.find((r) => r.id === 'iron-chestplate')!;
    expect(tunic).toMatchObject({ inputs: [[Item.Leather, 8]], output: [Item.LeatherTunic, 1], table: true });
    expect(tunic.station).toBeUndefined();
    expect(plate).toMatchObject({ inputs: [[Item.IronIngot, 8]], output: [Item.IronChestplate, 1], station: 'smithing-table' });
    expect(cannotCraft(plate, new Map([[Item.IronIngot, 8]]), false)).toBe('needs a smithing table placed nearby');
    expect(cannotCraft(tunic, new Map([[Item.Leather, 8]]), false)).toBe('needs a crafting table placed nearby');
  });

  it('is kept with the inventory: wear and what is on, saved and loaded', async () => {
    const store = new MemoryInventoryStore();
    const { p, saves } = survival(inventory([[Item.IronHelmet, 1], [Item.WoodenSword, 1]]));
    p.putOn(Item.IronHelmet);
    p.wearArmor();
    p.wearOut(Item.WoodenSword, 7);
    await p.flush();
    const kept = saves.at(-1)!;
    await store.save('a', 'w', kept);
    const back = new PlayerInventory('survival', (await store.load('a', 'w'))!, async () => {});
    expect(back.worn).toEqual([Item.IronHelmet, null, null, null]);
    expect(back.message().wornWear).toEqual([1, 0, 0, 0]);
    expect(back.wearOf(Item.WoodenSword)).toBe(7);
    // (An inventory kept before there was wear: nothing worn, nothing on.)
    const old = new PlayerInventory('survival', inventory([[Item.WoodenSword, 1]]), async () => {});
    expect(old.worn).toEqual([null, null, null, null]);
    expect(old.message().wear).toEqual([]);
  });
});
