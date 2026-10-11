import { Item, type ItemId } from './items.js';
import { Material } from './materials.js';
import type { DeathCause } from './survival.js';

/**
 * Tools, weapons and armor wear out (see the server's PlayerInventory): each use (a block mined, a
 * hit, a shot, a block tilled; for armor, a hit taken) wears the one in use by one, and at its
 * DURABILITY it breaks (one of them gone; the next, if any, fresh). One of a kind in the inventory
 * is the worn one (its wear kept); the rest are new. At an anvil, a worn thing is mended whole with
 * one of what it's made of (REPAIR_WITH).
 *
 * Armor: a piece for each slot (ARMOR_SLOTS), worn; each takes a share of what an attack (a
 * creature's, an arrow, a blast) does (not a fall, drowning or starving), more for iron than leather.
 */

/** Uses each lasts before it breaks. */
export const DURABILITY: Readonly<Record<ItemId, number>> = {
  [Item.WoodenPickaxe]: 60, [Item.WoodenAxe]: 60, [Item.WoodenShovel]: 60, [Item.WoodenSword]: 60,
  [Item.StonePickaxe]: 130, [Item.StoneAxe]: 130, [Item.StoneShovel]: 130, [Item.StoneSword]: 130,
  [Item.IronPickaxe]: 250, [Item.IronAxe]: 250, [Item.IronShovel]: 250, [Item.IronSword]: 250,
  [Item.Bow]: 200,
  [Item.LeatherHelmet]: 80, [Item.LeatherTunic]: 80, [Item.LeatherLeggings]: 80, [Item.LeatherBoots]: 80,
  [Item.IronHelmet]: 240, [Item.IronChestplate]: 240, [Item.IronLeggings]: 240, [Item.IronBoots]: 240,
};

export function wears(item: ItemId): boolean {
  return DURABILITY[item] !== undefined;
}

const PLANKS = [Material.Planks, 4096] as const, COBBLE = [Material.Cobblestone, 4096] as const, INGOT = [Item.IronIngot, 1] as const, LEATHER = [Item.Leather, 1] as const;

/** What mends each (at an anvil): what it's made of, and how much (stored: blocks by volume, items by count). */
export const REPAIR_WITH: Readonly<Record<ItemId, readonly [ItemId, number]>> = {
  [Item.WoodenPickaxe]: PLANKS, [Item.WoodenAxe]: PLANKS, [Item.WoodenShovel]: PLANKS, [Item.WoodenSword]: PLANKS, [Item.Bow]: PLANKS,
  [Item.StonePickaxe]: COBBLE, [Item.StoneAxe]: COBBLE, [Item.StoneShovel]: COBBLE, [Item.StoneSword]: COBBLE,
  [Item.IronPickaxe]: INGOT, [Item.IronAxe]: INGOT, [Item.IronShovel]: INGOT, [Item.IronSword]: INGOT,
  [Item.IronHelmet]: INGOT, [Item.IronChestplate]: INGOT, [Item.IronLeggings]: INGOT, [Item.IronBoots]: INGOT,
  [Item.LeatherHelmet]: LEATHER, [Item.LeatherTunic]: LEATHER, [Item.LeatherLeggings]: LEATHER, [Item.LeatherBoots]: LEATHER,
};

/** Where armor's worn, in order (the inventory's worn slots). */
export const ARMOR_SLOTS = ['head', 'chest', 'legs', 'feet'] as const;
export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

/** Each piece: its slot, what it's made of, and how much it protects (points: see armorShare). */
export const ARMOR: Readonly<Record<ItemId, { slot: ArmorSlot; tier: 'leather' | 'iron'; points: number }>> = {
  [Item.LeatherHelmet]: { slot: 'head', tier: 'leather', points: 1 },
  [Item.LeatherTunic]: { slot: 'chest', tier: 'leather', points: 3 },
  [Item.LeatherLeggings]: { slot: 'legs', tier: 'leather', points: 2 },
  [Item.LeatherBoots]: { slot: 'feet', tier: 'leather', points: 1 },
  [Item.IronHelmet]: { slot: 'head', tier: 'iron', points: 2 },
  [Item.IronChestplate]: { slot: 'chest', tier: 'iron', points: 6 },
  [Item.IronLeggings]: { slot: 'legs', tier: 'iron', points: 5 },
  [Item.IronBoots]: { slot: 'feet', tier: 'iron', points: 2 },
};

export function isArmor(item: ItemId): boolean {
  return ARMOR[item] !== undefined;
}

/** A share of an attack's harm each armor point takes (a whole leather suit: 28%; iron: 60%), and the most all together take. */
export const ARMOR_POINT_SHARE = 0.04;
export const ARMOR_MAX_SHARE = 0.8;

/** The share (0..ARMOR_MAX_SHARE) of an attack's harm what's worn (a piece a slot, or null) takes. */
export function armorShare(worn: readonly (ItemId | null)[]): number {
  const points = worn.reduce((n: number, item) => n + (item !== null ? (ARMOR[item]?.points ?? 0) : 0), 0);
  return Math.min(ARMOR_MAX_SHARE, points * ARMOR_POINT_SHARE);
}

/** What armor protects from: attacks (creatures, arrows, outlaws, villagers) and blasts; not falls, drowning or starving. */
export const ARMORED: ReadonlySet<DeathCause> = new Set<DeathCause>(['mob', 'blast', 'shot', 'outlaw', 'villager']);
