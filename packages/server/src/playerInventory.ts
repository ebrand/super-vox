import {
  HOTBAR_SLOTS,
  PLACEABLE,
  canPlace,
  dropOf,
  formatBlocks,
  isWater,
  materialName,
  voxelVolume,
  type Edit,
  type GameMode,
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
  ) {}

  /** Why `edit` isn't allowed (null if it is): placing what this mode doesn't allow, or more than you have. */
  refuse(edit: Edit): string | null {
    if (edit.op !== 'place') return null;
    if (!canPlace(edit.material, this.mode)) return `${materialName(edit.material)} can't be placed${this.mode === 'survival' ? ' in survival' : ''}`;
    if (this.mode === 'creative') return null;
    const have = this.inv.items.get(edit.material) ?? 0;
    const need = voxelVolume(edit.size);
    return have >= need ? null : `not enough ${materialName(edit.material)} (have ${formatBlocks(have)}, need ${formatBlocks(need)} blocks)`;
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

  /** Rearranges the hotbar; why not (null if fine): only placeable materials go on it. */
  setHotbar(hotbar: (MaterialId | null)[]): string | null {
    if (hotbar.length !== HOTBAR_SLOTS) return 'wrong number of hotbar slots';
    const bad = hotbar.find((m) => m !== null && !PLACEABLE.includes(m));
    if (bad !== undefined) return `${materialName(bad!)} can't go on the hotbar`;
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
