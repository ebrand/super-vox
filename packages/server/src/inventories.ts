import type pg from 'pg';
import { HOTBAR_SLOTS, STARTER_KIT, starterHotbar, type MaterialId } from '@super-vox/shared';
import { SCHEMA } from './db.js';

/** A player's things in one world: how much of each material (unit-voxel volumes) and their hotbar. */
export interface Inventory {
  items: Map<MaterialId, number>;
  hotbar: (MaterialId | null)[];
}

/** A new survival player's inventory. */
export function starterInventory(): Inventory {
  return { items: new Map(STARTER_KIT), hotbar: starterHotbar() };
}

/** Inventories by account and world (see inventoryKeyOf). */
export interface InventoryStore {
  load(accountId: string, world: string): Promise<Inventory | null>;
  save(accountId: string, world: string, inventory: Inventory): Promise<void>;
}

const copy = (inv: Inventory): Inventory => ({ items: new Map(inv.items), hotbar: [...inv.hotbar] });

export class MemoryInventoryStore implements InventoryStore {
  private readonly saved = new Map<string, Inventory>();

  async load(accountId: string, world: string): Promise<Inventory | null> {
    const inv = this.saved.get(`${accountId} ${world}`);
    return inv ? copy(inv) : null;
  }

  async save(accountId: string, world: string, inventory: Inventory): Promise<void> {
    this.saved.set(`${accountId} ${world}`, copy(inventory));
  }
}

/** Inventories in Postgres (table "super-vox".inventories; see db.ts). */
export class PgInventoryStore implements InventoryStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(accountId: string, world: string): Promise<Inventory | null> {
    const { rows } = await this.pool.query<{ items: [number, number][]; hotbar: (number | null)[] }>(
      `select items, hotbar from ${SCHEMA}.inventories where account_id = $1 and world = $2`,
      [accountId, world],
    );
    const r = rows[0];
    if (!r) return null;
    const hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => r.hotbar[i] ?? null);
    return { items: new Map(r.items.filter(([, v]) => v > 0)), hotbar };
  }

  async save(accountId: string, world: string, inventory: Inventory): Promise<void> {
    await this.pool.query(
      `insert into ${SCHEMA}.inventories (account_id, world, items, hotbar) values ($1, $2, $3, $4)
       on conflict (account_id, world) do update set items = excluded.items, hotbar = excluded.hotbar, updated_at = now()`,
      [accountId, world, JSON.stringify([...inventory.items].filter(([, v]) => v > 0)), JSON.stringify(inventory.hotbar)],
    );
  }
}
