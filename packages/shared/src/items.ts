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
export const HOTBAR_SLOTS = 10;

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
  /** Food (see FOODS): from pigs. */
  Pork: 1007,
  /** Placed as a workbench (see objects.ts); recipes that need one want one placed nearby. */
  CraftingTable: 1008,
  /**
   * Stations, placed as the design that stands in for each (see STATIONS in designs.ts): only in
   * play once one does (see setDesigns).
   */
  Furnace: 1009,
  Stove: 1010,
  Anvil: 1011,
  SmithingTable: 1012,
  /** Placed as the design that's the bed: right-clicked, it's where its owner comes back to after dying. */
  Bed: 1013,
  /** Tools (see tools.ts): each mines its own materials faster; a pickaxe is needed for anything from stone. */
  WoodenPickaxe: 1014,
  StonePickaxe: 1015,
  WoodenAxe: 1016,
  StoneAxe: 1017,
  WoodenShovel: 1018,
  StoneShovel: 1019,
  /** Smelted in a furnace from raw iron (see stations.ts): what iron tools are made of. */
  IronIngot: 1020,
  /** Pork cooked on a stove: far more filling than raw (see FOODS). */
  CookedPork: 1021,
  IronPickaxe: 1022,
  IronAxe: 1023,
  IronShovel: 1024,
  IronSword: 1025,
  /** Placed on floors and walls (see objects.ts): it lights what's around it. */
  Torch: 1026,
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
  [Item.Pork]: 'pork',
  [Item.CraftingTable]: 'crafting table',
  [Item.Furnace]: 'furnace',
  [Item.Stove]: 'stove',
  [Item.Anvil]: 'anvil',
  [Item.SmithingTable]: 'smithing table',
  [Item.Bed]: 'bed',
  [Item.WoodenPickaxe]: 'wooden pickaxe',
  [Item.StonePickaxe]: 'stone pickaxe',
  [Item.WoodenAxe]: 'wooden axe',
  [Item.StoneAxe]: 'stone axe',
  [Item.WoodenShovel]: 'wooden shovel',
  [Item.StoneShovel]: 'stone shovel',
  [Item.IronIngot]: 'iron ingot',
  [Item.CookedPork]: 'cooked pork',
  [Item.IronPickaxe]: 'iron pickaxe',
  [Item.IronAxe]: 'iron axe',
  [Item.IronShovel]: 'iron shovel',
  [Item.IronSword]: 'iron sword',
  [Item.Torch]: 'torch',
};

/** Items in play only once a design stands in for them (see STATIONS): not among the built-in ones. */
const DESIGNED_ONLY = new Set<ItemId>([Item.Furnace, Item.Stove, Item.Anvil, Item.SmithingTable, Item.Bed]);

/** Whether an id is a block material (amounts are volumes) rather than an item (amounts are counts). */
export function isBlock(id: ItemId): boolean {
  return id < FIRST_ITEM;
}

/** Items added while running (objects designed with the designer, see designs.ts): their names. */
const EXTRA_NAMES = new Map<ItemId, string>();

export function itemName(id: ItemId): string {
  return isBlock(id) ? materialName(id) : (ITEM_NAMES[id] ?? EXTRA_NAMES.get(id) ?? `item ${id}`);
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
  Material.Gravel,
  Material.DarkStone,
  Material.PaleStone,
  Material.MossyStone,
  Material.Sandstone,
  Material.Shale,
  Material.Limestone,
  Material.Granite,
  Material.TNT,
  Material.C4,
  Material.Water,
];

/** What ores give (mined, not placed): had like blocks, by volume. */
const MINED: readonly MaterialId[] = [Material.Coal, Material.RawIron];

const BUILT_IN: readonly ItemId[] = [...PLACEABLE, ...MINED, ...(Object.values(Item) as ItemId[]).filter((id) => !DESIGNED_ONLY.has(id))];
const allItems: ItemId[] = [...BUILT_IN];

/**
 * Everything a player can have: what creative lists, and what can go on a hotbar (the built-in
 * ones, then those added while running: see setExtraItems).
 */
export const ALL_ITEMS: readonly ItemId[] = allItems;

/** Sets the items added while running (designed objects, see setDesigns), replacing those before. */
export function setExtraItems(items: readonly (readonly [ItemId, string])[]): void {
  EXTRA_NAMES.clear();
  for (const [id, name] of items) EXTRA_NAMES.set(id, name);
  allItems.length = BUILT_IN.length;
  allItems.push(...items.map(([id]) => id));
}

/** Placeable in this mode: water only in creative (survival will carry it in buckets). */
export function canPlace(material: MaterialId, mode: GameMode): boolean {
  return PLACEABLE.includes(material) && (mode === 'creative' || !isWater(material));
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

/** A creative player's first hotbar: a spread of materials, water, then TNT. */
export function creativeHotbar(): (MaterialId | null)[] {
  return [Material.Stone, Material.Dirt, Material.Grass, Material.Sand, Material.Wood, Material.Leaves, Material.Snow, Material.Ice, Material.Water, Material.TNT];
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
