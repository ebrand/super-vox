import type pg from 'pg';
import { HOTBAR_SLOTS, STARTER_KIT, starterHotbar, type MaterialId, type SavedVitals } from '@super-vox/shared';
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

/** Where a player was in a world (their eye, units; yaw, radians), to come back to. */
export interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * The rest of a player in a world: survival's health, food and breath (null: never kept, e.g.
 * only ever in creative), and their bed (its block, 1 m block coordinates; null: none).
 */
export interface PlayerState {
  vitals: SavedVitals | null;
  bed: { x: number; y: number; z: number } | null;
}

/** Inventories by account and world (see inventoryKeyOf), and where each player was in each world (and the rest of them: PlayerState). */
export interface InventoryStore {
  load(accountId: string, world: string): Promise<Inventory | null>;
  save(accountId: string, world: string, inventory: Inventory): Promise<void>;
  loadPlace(accountId: string, world: string): Promise<Place | null>;
  savePlace(accountId: string, world: string, place: Place): Promise<void>;
  loadState(accountId: string, world: string): Promise<PlayerState | null>;
  saveState(accountId: string, world: string, state: PlayerState): Promise<void>;
}

const copy = (inv: Inventory): Inventory => ({ items: new Map(inv.items), hotbar: [...inv.hotbar] });

export class MemoryInventoryStore implements InventoryStore {
  private readonly saved = new Map<string, Inventory>();
  private readonly places = new Map<string, Place>();
  private readonly states = new Map<string, string>();

  async load(accountId: string, world: string): Promise<Inventory | null> {
    const inv = this.saved.get(`${accountId} ${world}`);
    return inv ? copy(inv) : null;
  }

  async save(accountId: string, world: string, inventory: Inventory): Promise<void> {
    this.saved.set(`${accountId} ${world}`, copy(inventory));
  }

  async loadPlace(accountId: string, world: string): Promise<Place | null> {
    const p = this.places.get(`${accountId} ${world}`);
    return p ? { ...p } : null;
  }

  async savePlace(accountId: string, world: string, place: Place): Promise<void> {
    this.places.set(`${accountId} ${world}`, { ...place });
  }

  async loadState(accountId: string, world: string): Promise<PlayerState | null> {
    const s = this.states.get(`${accountId} ${world}`);
    return s ? (JSON.parse(s) as PlayerState) : null;
  }

  async saveState(accountId: string, world: string, state: PlayerState): Promise<void> {
    this.states.set(`${accountId} ${world}`, JSON.stringify(state));
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

  async loadPlace(accountId: string, world: string): Promise<Place | null> {
    const { rows } = await this.pool.query<Place>(`select x, y, z, yaw from ${SCHEMA}.places where account_id = $1 and world = $2`, [accountId, world]);
    return rows[0] ?? null;
  }

  async savePlace(accountId: string, world: string, place: Place): Promise<void> {
    await this.pool.query(
      `insert into ${SCHEMA}.places (account_id, world, x, y, z, yaw) values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id, world) do update set x = excluded.x, y = excluded.y, z = excluded.z, yaw = excluded.yaw, updated_at = now()`,
      [accountId, world, place.x, place.y, place.z, place.yaw],
    );
  }

  async loadState(accountId: string, world: string): Promise<PlayerState | null> {
    const { rows } = await this.pool.query<{ vitals: SavedVitals | null; bed_x: number | null; bed_y: number | null; bed_z: number | null }>(
      `select vitals, bed_x, bed_y, bed_z from ${SCHEMA}.player_states where account_id = $1 and world = $2`,
      [accountId, world],
    );
    const r = rows[0];
    if (!r) return null;
    return { vitals: r.vitals, bed: r.bed_x !== null && r.bed_y !== null && r.bed_z !== null ? { x: r.bed_x, y: r.bed_y, z: r.bed_z } : null };
  }

  async saveState(accountId: string, world: string, state: PlayerState): Promise<void> {
    await this.pool.query(
      `insert into ${SCHEMA}.player_states (account_id, world, vitals, bed_x, bed_y, bed_z) values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id, world) do update set vitals = excluded.vitals, bed_x = excluded.bed_x, bed_y = excluded.bed_y, bed_z = excluded.bed_z, updated_at = now()`,
      [accountId, world, state.vitals ? JSON.stringify(state.vitals) : null, state.bed?.x ?? null, state.bed?.y ?? null, state.bed?.z ?? null],
    );
  }
}
