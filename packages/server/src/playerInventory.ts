import {
  ALL_ITEMS,
  BLOCK_VOLUME,
  Item,
  ARMOR,
  ARMOR_SLOTS,
  DURABILITY,
  REPAIR_WITH,
  SAPLING_CHANCE,
  formatAmount,
  wears,
  SAPLING_OF_LEAVES,
  Material,
  HOTBAR_SLOTS,
  canPlace,
  cannotCraft,
  craft,
  dropOf,
  formatBlocks,
  isBlock,
  isWater,
  itemName,
  recipeById,
  voxelVolume,
  type Edit,
  type GameMode,
  type ItemId,
  type MaterialId,
  type ServerMessage,
} from '@super-vox/shared';
import type { Inventory } from './inventories.js';

/**
 * One signed-in player's inventory in one world, and the rules of the world's game mode. In
 * survival, placing uses material up and mining gives it (see dropOf), by volume; in creative,
 * everything placeable is unlimited and only the hotbar is kept. Changes are saved a moment after
 * the last one (and on flush).
 */
/** Grass dug gives a wheat (seed) this often. */
const SEED_CHANCE = 0.15;
const SEEDY = new Set<number>([Material.Grass, Material.Meadow, Material.DryGrass]);

export class PlayerInventory {
  /** Chance, for seed in dug grass (see apply): 0..1. */
  random: () => number = Math.random;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly mode: GameMode,
    private readonly inv: Inventory,
    private readonly persist: (inv: Inventory) => Promise<void>,
    private readonly saveDelayMs = 2000,
  ) {
    // (Saved before there was wear, or armor to wear: none worn, nothing on.)
    inv.wear ??= new Map();
    inv.worn = ARMOR_SLOTS.map((_, i) => inv.worn?.[i] ?? null);
    inv.wornWear = ARMOR_SLOTS.map((_, i) => inv.wornWear?.[i] ?? 0);
    // (Saved before the hotbar grew: the new slots are empty.)
    while (inv.hotbar.length < HOTBAR_SLOTS) inv.hotbar.push(null);
    inv.hotbar.length = HOTBAR_SLOTS;
    // (Saved when crafting tables were a material, counted by volume: now they're items, one a block's worth.)
    const tables = inv.items.get(Material.CraftingTable);
    if (tables !== undefined) {
      inv.items.delete(Material.CraftingTable);
      const n = Math.round(tables / BLOCK_VOLUME);
      if (n > 0) inv.items.set(Item.CraftingTable, (inv.items.get(Item.CraftingTable) ?? 0) + n);
      inv.hotbar = inv.hotbar.map((h) => (h === Material.CraftingTable ? Item.CraftingTable : h));
    }
  }

  /** Why `edit` isn't allowed (null if it is): placing what this mode doesn't allow, or more than you have. */
  refuse(edit: Edit): string | null {
    if (edit.op !== 'place' && edit.op !== 'fillBox') return null;
    if (!isBlock(edit.material)) return `a ${itemName(edit.material)} can't be placed yet`;
    if (!canPlace(edit.material, this.mode)) return `${itemName(edit.material)} can't be placed${this.mode === 'survival' ? ' in survival' : ''}`;
    if (this.mode === 'creative') return null;
    const have = this.inv.items.get(edit.material) ?? 0;
    const need = voxelVolume(edit.size);
    return have >= need ? null : `not enough ${itemName(edit.material)} (have ${formatBlocks(have)}, need ${formatBlocks(need)} blocks)`;
  }

  /** How many of an item there are (Infinity in creative). */
  /** Whether they have `item` with them: in survival, any of it; in creative (everything's to hand), on the hotbar. */
  carries(item: ItemId): boolean {
    return this.mode === 'creative' ? this.inv.hotbar.includes(item) : (this.inv.items.get(item) ?? 0) > 0;
  }

  count(item: ItemId): number {
    return this.mode === 'creative' ? Infinity : (this.inv.items.get(item) ?? 0);
  }

  /** Water in buckets (unit-voxel volume; Infinity in creative), and room for more: 1 m³ per bucket. */
  water(): number {
    return this.count(Material.Water);
  }

  waterRoom(): number {
    return this.mode === 'creative' ? Infinity : (this.inv.items.get(Item.Bucket) ?? 0) * BLOCK_VOLUME - this.water();
  }

  /** Why an item can't be used up here (null if it can): survival needs one. */
  refuseItem(item: ItemId): string | null {
    if (this.mode === 'creative') return null;
    return (this.inv.items.get(item) ?? 0) >= 1 ? null : `no ${itemName(item)} left`;
  }

  /** Survival: throws away up to `amount` of `item` (stored amounts); why not, or null. */
  discard(item: ItemId, amount: number): string | null {
    if (this.mode !== 'survival') return 'creative: nothing to throw away';
    const has = this.inv.items.get(item) ?? 0;
    if (has <= 0) return `no ${itemName(item)} to throw away`;
    const left = has - Math.min(has, amount);
    if (left > 0) this.inv.items.set(item, left);
    else this.inv.items.delete(item);
    this.changed();
    return null;
  }

  /** Survival: one of an item used up (placing an object) or given back (taking one down). */
  addItem(item: ItemId, n: number): void {
    if (this.mode !== 'survival') return;
    const left = (this.inv.items.get(item) ?? 0) + n;
    if (left > 0) this.inv.items.set(item, left);
    else this.inv.items.delete(item);
    this.changed();
  }

  /** Survival: takes what an edit placed and gives what it removed (see EditResult.change), as mined with `tool` (null: by hand; see dropOf). */
  apply(change: Map<MaterialId, number>, tool: ItemId | null = null): boolean {
    if (this.mode !== 'survival' || change.size === 0) return false;
    let changed = false;
    for (const [m, d] of change) {
      if (d > 0 && !isWater(m)) {
        this.inv.items.set(m, Math.max(0, (this.inv.items.get(m) ?? 0) - d));
        changed = true;
      } else if (d < 0) {
        // (Leaves dug: now and then, a sapling of their tree, by how much was dug.)
        const sapling = SAPLING_OF_LEAVES[m];
        if (sapling !== undefined && this.random() < Math.min(1, (SAPLING_CHANCE * -d) / BLOCK_VOLUME)) {
          this.inv.items.set(sapling, (this.inv.items.get(sapling) ?? 0) + 1);
          changed = true;
        }
        const drop = dropOf(m, tool);
        if (drop === null) continue;
        this.inv.items.set(drop, (this.inv.items.get(drop) ?? 0) - d);
        changed = true;
        // (Grass dug: now and then, some wheat in it: seed.)
        if (SEEDY.has(m) && -d >= BLOCK_VOLUME / 2 && this.random() < SEED_CHANCE) this.inv.items.set(Item.Wheat, (this.inv.items.get(Item.Wheat) ?? 0) + 1);
      }
    }
    for (const [m, v] of this.inv.items) if (v <= 0) this.inv.items.delete(m);
    if (changed) this.changed();
    return changed;
  }

  /**
   * Survival: makes a recipe (see RECIPES), `nearTable` saying whether a crafting table is within
   * reach. Why not, if it can't be made (null if it was).
   */
  craft(recipeId: string, nearTable: boolean): string | null {
    const recipe = recipeById(recipeId);
    if (!recipe) return `no recipe "${recipeId}"`;
    if (this.mode === 'creative') return 'nothing to make in creative: everything is already yours';
    const why = cannotCraft(recipe, this.inv.items, nearTable);
    if (why) return why;
    craft(recipe, this.inv.items);
    this.changed();
    return null;
  }

  /** Rearranges the hotbar; why not (null if fine): anything a player can have goes on it. */
  setHotbar(hotbar: (MaterialId | null)[]): string | null {
    if (hotbar.length !== HOTBAR_SLOTS) return 'wrong number of hotbar slots';
    const bad = hotbar.find((m) => m !== null && !ALL_ITEMS.includes(m));
    if (bad !== undefined) return `${itemName(bad!)} can't go on the hotbar`;
    this.inv.hotbar.splice(0, HOTBAR_SLOTS, ...hotbar);
    this.changed();
    return null;
  }

  /** The `inventory` message for the player. */
  message(): Extract<ServerMessage, { type: 'inventory' }> {
    const survival = this.mode === 'survival';
    return {
      type: 'inventory',
      mode: this.mode,
      items: survival ? [...this.inv.items].filter(([, v]) => v > 0) : [],
      hotbar: [...this.inv.hotbar],
      ...(survival ? { wear: [...this.inv.wear!].filter(([, w]) => w > 0), worn: [...this.inv.worn!], wornWear: [...this.inv.wornWear!] } : {}),
    };
  }

  /** The armor on, a piece a slot (ARMOR_SLOTS order; null: none), in survival (in creative, none: nothing hurts there). */
  get worn(): readonly (ItemId | null)[] {
    return this.mode === 'survival' ? this.inv.worn! : ARMOR_SLOTS.map(() => null);
  }

  /** How worn the worn one of `item` is (0: new), and how much more it can take. */
  wearOf(item: ItemId): number {
    return this.inv.wear!.get(item) ?? 0;
  }

  /**
   * Survival: the one of `item` in use worn by a use (see DURABILITY); at its durability it breaks
   * (one fewer; the next, if any, new). 'broke' if it did, 'worn' if worn, null if it doesn't wear
   * (or there's none, or it's creative).
   */
  wearOut(item: ItemId | null, uses = 1): 'worn' | 'broke' | null {
    if (this.mode !== 'survival' || item === null || !wears(item) || (this.inv.items.get(item) ?? 0) < 1) return null;
    const w = this.wearOf(item) + uses;
    this.changed();
    if (w < DURABILITY[item]!) {
      this.inv.wear!.set(item, w);
      return 'worn';
    }
    this.inv.wear!.delete(item);
    this.addItem(item, -1);
    return 'broke';
  }

  /** Survival: each piece of armor on worn by a hit taken; those that break, gone (what broke). */
  wearArmor(): ItemId[] {
    if (this.mode !== 'survival') return [];
    const broke: ItemId[] = [];
    this.inv.worn!.forEach((item, i) => {
      if (item === null) return;
      const w = this.inv.wornWear![i]! + 1;
      if (w < DURABILITY[item]!) this.inv.wornWear![i] = w;
      else {
        broke.push(item);
        this.inv.worn![i] = null;
        this.inv.wornWear![i] = 0;
      }
    });
    if (this.inv.worn!.some((w) => w !== null) || broke.length) this.changed();
    return broke;
  }

  /**
   * Survival: puts on a piece of armor from the inventory (the worn one of its kind, if there's one),
   * in its slot (what was there taken off, back into the inventory). Why not, or null.
   */
  putOn(item: ItemId): string | null {
    if (this.mode !== 'survival') return 'armor is for survival';
    const a = ARMOR[item];
    if (!a) return `a ${itemName(item)} isn't armor`;
    if ((this.inv.items.get(item) ?? 0) < 1) return `no ${itemName(item)} to put on`;
    const i = ARMOR_SLOTS.indexOf(a.slot);
    const w = this.wearOf(item);
    this.inv.wear!.delete(item);
    this.addItem(item, -1);
    this.takeOff(i);
    this.inv.worn![i] = item;
    this.inv.wornWear![i] = w;
    this.changed();
    return null;
  }

  /** Survival: takes off what's in armor slot `i` (into the inventory, as worn as it is: if one of its kind there's worn too, the more worn is kept). */
  takeOff(i: number): string | null {
    if (this.mode !== 'survival') return 'armor is for survival';
    const item = this.inv.worn![i];
    if (item === null || item === undefined) return 'nothing on there';
    const w = this.inv.wornWear![i]!;
    this.inv.worn![i] = null;
    this.inv.wornWear![i] = 0;
    this.addItem(item, 1);
    if (w > 0) this.inv.wear!.set(item, Math.max(w, this.wearOf(item)));
    this.changed();
    return null;
  }

  /** Survival: mends the worn one of `item` (in the inventory, or on) whole, with what REPAIR_WITH says. Why not, or null. */
  repair(item: ItemId): string | null {
    if (this.mode !== 'survival') return 'nothing wears in creative';
    const cost = REPAIR_WITH[item];
    if (!cost) return `a ${itemName(item)} can't be mended`;
    const on = this.inv.worn!.findIndex((w, i) => w === item && this.inv.wornWear![i]! > 0);
    if (this.wearOf(item) <= 0 && on < 0) return `no worn ${itemName(item)} to mend`;
    const [what, n] = cost;
    if ((this.inv.items.get(what) ?? 0) < n) return `mending the ${itemName(item)} takes ${formatAmount(what, n)} ${itemName(what)}`;
    this.addItem(what, -n);
    if (this.wearOf(item) > 0) this.inv.wear!.delete(item);
    else this.inv.wornWear![on] = 0;
    this.changed();
    return null;
  }

  /** Saves now if anything is waiting to be saved. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    await this.saving;
  }

  private changed(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDelayMs);
  }

  private save(): void {
    // (What's worn of what's no longer there: let go.)
    for (const item of this.inv.wear!.keys()) if ((this.inv.items.get(item) ?? 0) < 1) this.inv.wear!.delete(item);
    const snapshot: Inventory = { items: new Map(this.inv.items), hotbar: [...this.inv.hotbar], wear: new Map(this.inv.wear), worn: [...this.inv.worn!], wornWear: [...this.inv.wornWear!] };
    // One save at a time, in order.
    this.saving = this.saving.then(() => this.persist(snapshot)).catch(() => {});
  }
}
