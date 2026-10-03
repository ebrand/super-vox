import {
  ALL_ITEMS,
  BLOCK_VOLUME,
  Item,
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
export class PlayerInventory {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly mode: GameMode,
    private readonly inv: Inventory,
    private readonly persist: (inv: Inventory) => Promise<void>,
    private readonly saveDelayMs = 2000,
  ) {
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

  /** Survival: takes what an edit placed and gives what it removed (see EditResult.change). */
  apply(change: Map<MaterialId, number>): boolean {
    if (this.mode !== 'survival' || change.size === 0) return false;
    let changed = false;
    for (const [m, d] of change) {
      if (d > 0 && !isWater(m)) {
        this.inv.items.set(m, Math.max(0, (this.inv.items.get(m) ?? 0) - d));
        changed = true;
      } else if (d < 0) {
        const drop = dropOf(m);
        if (drop === null) continue;
        this.inv.items.set(drop, (this.inv.items.get(drop) ?? 0) - d);
        changed = true;
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
    return {
      type: 'inventory',
      mode: this.mode,
      items: this.mode === 'survival' ? [...this.inv.items].filter(([, v]) => v > 0) : [],
      hotbar: [...this.inv.hotbar],
    };
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
    const snapshot: Inventory = { items: new Map(this.inv.items), hotbar: [...this.inv.hotbar] };
    // One save at a time, in order.
    this.saving = this.saving.then(() => this.persist(snapshot)).catch(() => {});
  }
}
