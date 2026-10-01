import { BLOCK_SIZE, unpackVoxel, type Chunk } from './chunk.js';
import { Material, isWater, materialName, type MaterialId } from './materials.js';

/**
 * Game modes: in creative, every placeable material is unlimited; in survival, players build
 * with what they've mined (and a starting kit).
 */
export const GAME_MODES = ['survival', 'creative'] as const;
export type GameMode = (typeof GAME_MODES)[number];
/** Worlds without a mode (and new ones, unless told otherwise) are survival. */
export const DEFAULT_GAME_MODE: GameMode = 'survival';

export function isGameMode(v: unknown): v is GameMode {
  return typeof v === 'string' && (GAME_MODES as readonly string[]).includes(v);
}

/**
 * Amounts of material are volumes in unit voxels (1/16 m cubes), so every voxel size counts
 * exactly: a 1 m block is BLOCK_VOLUME, a 1/4 m voxel 64.
 */
export const BLOCK_VOLUME = BLOCK_SIZE ** 3;

/** Volume (unit voxels) of a voxel `size` units across. */
export const voxelVolume = (size: number) => size ** 3;

/** Hotbar slots. */
export const HOTBAR_SLOTS = 9;

/**
 * Things that aren't blocks, counted whole (ids from FIRST_ITEM; below it, an id is a material,
 * counted by volume). Fences, gates, doors and buckets are placed and used in later steps.
 */
export const Item = {
  Stick: 1000,
  WoodenSword: 1001,
  StoneSword: 1002,
  Fence: 1003,
  Gate: 1004,
  Door: 1005,
  Bucket: 1006,
} as const;
export type ItemId = number;
export const FIRST_ITEM = 1000;

const ITEM_NAMES: Record<number, string> = {
  [Item.Stick]: 'stick',
  [Item.WoodenSword]: 'wooden sword',
  [Item.StoneSword]: 'stone sword',
  [Item.Fence]: 'fence',
  [Item.Gate]: 'gate',
  [Item.Door]: 'door',
  [Item.Bucket]: 'bucket',
};

/** Whether an id is a block material (amounts are volumes) rather than an item (amounts are counts). */
export function isBlock(id: ItemId): boolean {
  return id < FIRST_ITEM;
}

export function itemName(id: ItemId): string {
  return isBlock(id) ? materialName(id) : (ITEM_NAMES[id] ?? `item ${id}`);
}

/** What players can place: in creative all of these, in survival those they have. */
export const PLACEABLE: readonly MaterialId[] = [
  Material.Stone,
  Material.Dirt,
  Material.Grass,
  Material.Sand,
  Material.DesertSand,
  Material.Snow,
  Material.Ice,
  Material.Wood,
  Material.Leaves,
  Material.Needles,
  Material.JungleLeaves,
  Material.AcaciaLeaves,
  Material.Meadow,
  Material.JungleFloor,
  Material.DryGrass,
  Material.TaigaFloor,
  Material.Tundra,
  Material.Planks,
  Material.Cobblestone,
  Material.CraftingTable,
  Material.Water,
];

/** Everything a player can have: what creative lists, and what can go on a hotbar. */
export const ALL_ITEMS: readonly ItemId[] = [...PLACEABLE, ...(Object.values(Item) as ItemId[])];

/** Placeable in this mode: water only in creative (survival will carry it in buckets). */
export function canPlace(material: MaterialId, mode: GameMode): boolean {
  return PLACEABLE.includes(material) && (mode === 'creative' || !isWater(material));
}

/** Grassy grounds give dirt when mined. */
const GIVES_DIRT = new Set<MaterialId>([Material.Grass, Material.Meadow, Material.JungleFloor, Material.DryGrass, Material.TaigaFloor, Material.Tundra]);
/** Leaves give nothing (for now). */
const GIVES_NOTHING = new Set<MaterialId>([Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves]);

/** What mining a material gives in survival (null: nothing). */
export function dropOf(material: MaterialId): MaterialId | null {
  if (isWater(material) || GIVES_NOTHING.has(material)) return null;
  if (GIVES_DIRT.has(material)) return Material.Dirt;
  if (material === Material.Stone) return Material.Cobblestone;
  return material;
}

/** A new survival player's materials: 16 blocks each of dirt, stone and wood. */
export const STARTER_KIT: readonly [MaterialId, number][] = [
  [Material.Dirt, 16 * BLOCK_VOLUME],
  [Material.Stone, 16 * BLOCK_VOLUME],
  [Material.Wood, 16 * BLOCK_VOLUME],
];

/** A new player's hotbar: the starter kit, then empty slots. */
export function starterHotbar(): (MaterialId | null)[] {
  return Array.from({ length: HOTBAR_SLOTS }, (_, i) => STARTER_KIT[i]?.[0] ?? null);
}

/** A creative player's first hotbar: a spread of materials, water last. */
export function creativeHotbar(): (MaterialId | null)[] {
  return [Material.Stone, Material.Dirt, Material.Grass, Material.Sand, Material.Wood, Material.Leaves, Material.Snow, Material.Ice, Material.Water];
}

/** Volume (unit voxels) of each material in a chunk. */
export function chunkVolumes(chunk: Chunk, into = new Map<MaterialId, number>()): Map<MaterialId, number> {
  const add = (m: MaterialId, v: number) => {
    if (m !== Material.Air) into.set(m, (into.get(m) ?? 0) + v);
  };
  for (const b of chunk.blocks) {
    if (!b) continue;
    if (b.kind === 'uniform') add(b.material, BLOCK_VOLUME);
    else if (b.kind === 'grid') for (const m of b.materials) add(m, voxelVolume(b.size));
    else for (let i = 0; i < b.packed.length; i++) add(b.materials[i]!, voxelVolume(unpackVoxel(b.packed[i]!).size));
  }
  return into;
}

/** How much of each material changed (after minus before; zeros left out). */
export function volumeChange(before: readonly Chunk[], after: readonly Chunk[]): Map<MaterialId, number> {
  const a = new Map<MaterialId, number>(), b = new Map<MaterialId, number>();
  for (const c of after) chunkVolumes(c, a);
  for (const c of before) chunkVolumes(c, b);
  const out = new Map<MaterialId, number>();
  for (const m of new Set([...a.keys(), ...b.keys()])) {
    const d = (a.get(m) ?? 0) - (b.get(m) ?? 0);
    if (d !== 0) out.set(m, d);
  }
  return out;
}

/** An amount of `id` for people: blocks for materials (see formatBlocks), a count for items. */
export function formatAmount(id: ItemId, amount: number): string {
  return isBlock(id) ? formatBlocks(amount) : String(amount);
}

/** "3", "2.5", "0.02" blocks: an amount for people. */
export function formatBlocks(volume: number): string {
  const blocks = volume / BLOCK_VOLUME;
  if (Number.isInteger(blocks)) return String(blocks);
  if (blocks >= 10) return blocks.toFixed(1).replace(/\.0$/, '');
  if (blocks >= 0.1) return blocks.toFixed(2).replace(/0$/, '');
  return blocks.toPrecision(2);
}
