import { Item, type ItemId } from './items.js';
import { Material, isWater, type MaterialId } from './materials.js';

/**
 * Tools (Minecraft's, more or less): a pickaxe for anything from stone, an axe for wood, a shovel
 * for earth and sand. The right one mines its materials faster (stone tools faster than wooden
 * ones, iron faster still); stone and ores need a pickaxe (iron ore a stone one at least) to give anything, and
 * without one take far longer. They don't wear out (yet).
 */
export type ToolKind = 'pickaxe' | 'axe' | 'shovel';

/** Each tool: its kind, its tier (1 wood, 2 stone, 3 iron) and how many times faster it mines its materials. */
export const TOOLS: Readonly<Record<ItemId, { kind: ToolKind; tier: number; speed: number }>> = {
  [Item.WoodenPickaxe]: { kind: 'pickaxe', tier: 1, speed: 2 },
  [Item.StonePickaxe]: { kind: 'pickaxe', tier: 2, speed: 4 },
  [Item.WoodenAxe]: { kind: 'axe', tier: 1, speed: 2 },
  [Item.StoneAxe]: { kind: 'axe', tier: 2, speed: 4 },
  [Item.WoodenShovel]: { kind: 'shovel', tier: 1, speed: 2 },
  [Item.StoneShovel]: { kind: 'shovel', tier: 2, speed: 4 },
  [Item.IronPickaxe]: { kind: 'pickaxe', tier: 3, speed: 6 },
  [Item.IronAxe]: { kind: 'axe', tier: 3, speed: 6 },
  [Item.IronShovel]: { kind: 'shovel', tier: 3, speed: 6 },
};

/** Swords: damage per hit (a bare hand does 1), and how far a swing cuts through leaves (blocks around: 0 just the one). */
export const SWORDS: Readonly<Record<ItemId, { damage: number; cut: number }>> = {
  [Item.WoodenSword]: { damage: 4, cut: 0 },
  [Item.StoneSword]: { damage: 5, cut: 1 },
  [Item.IronSword]: { damage: 6, cut: 1 },
};

export function isSword(item: ItemId | null | undefined): boolean {
  return item !== null && item !== undefined && SWORDS[item] !== undefined;
}

export function isTool(item: ItemId | null | undefined): boolean {
  return item !== null && item !== undefined && TOOLS[item] !== undefined;
}

const GROUNDS = [Material.Grass, Material.Meadow, Material.JungleFloor, Material.DryGrass, Material.TaigaFloor, Material.Tundra];

/** Which tool mines each material faster (anything not listed: none does). */
const TOOL_FOR: Readonly<Partial<Record<MaterialId, ToolKind>>> = {
  ...Object.fromEntries([Material.Stone, Material.Cobblestone, Material.CoalOre, Material.IronOre, Material.Ice, Material.DarkStone, Material.PaleStone, Material.MossyStone, Material.Sandstone, Material.Shale, Material.Limestone, Material.Granite, Material.Basalt, Material.CopperOre, Material.GoldOre].map((m) => [m, 'pickaxe'])),
  ...Object.fromEntries([Material.Wood, Material.Planks, Material.CraftingTable, Material.FenceWood, Material.GateWood, Material.DoorWood].map((m) => [m, 'axe'])),
  ...Object.fromEntries([Material.Dirt, ...GROUNDS, Material.Sand, Material.DesertSand, Material.Snow, Material.Gravel].map((m) => [m, 'shovel'])),
};

/** Materials that need a pickaxe of at least this tier to give anything (and to mine at a fair pace). */
const PICKAXE_TIER: Readonly<Partial<Record<MaterialId, number>>> = {
  [Material.Stone]: 1,
  [Material.Cobblestone]: 1,
  [Material.CoalOre]: 1,
  [Material.IronOre]: 2,
  [Material.DarkStone]: 1,
  [Material.PaleStone]: 1,
  [Material.MossyStone]: 1,
  [Material.Sandstone]: 1,
  [Material.Shale]: 1,
  [Material.Limestone]: 1,
  [Material.Granite]: 1,
  [Material.Basalt]: 1,
  // (Copper wants a stone pickaxe at least, gold an iron one.)
  [Material.CopperOre]: 2,
  [Material.GoldOre]: 3,
};

/** How much longer than its hardness a material takes without the pickaxe it needs. */
export const WRONG_TOOL_PENALTY = 3;

/** The tool kind that mines `m` faster, if any. */
export function toolFor(m: MaterialId): ToolKind | null {
  return TOOL_FOR[m] ?? null;
}

/** Whether `tool` (held; null: a bare hand, or anything that isn't a tool) is good enough for `m` to give anything. */
export function canHarvest(m: MaterialId, tool: ItemId | null): boolean {
  const need = PICKAXE_TIER[m];
  if (need === undefined) return true;
  const t = tool === null ? undefined : TOOLS[tool];
  return t !== undefined && t.kind === 'pickaxe' && t.tier >= need;
}

/** The pickaxe tier `m` needs (0: none). */
export function pickaxeTierFor(m: MaterialId): number {
  return PICKAXE_TIER[m] ?? 0;
}

/** What mining `m` with `tool` takes, as a multiple of its hardness (see HARDNESS): faster with the right tool, far slower without a pickaxe it needs. */
export function toolFactor(m: MaterialId, tool: ItemId | null): number {
  if (!canHarvest(m, tool)) return WRONG_TOOL_PENALTY;
  const t = tool === null ? undefined : TOOLS[tool];
  return t && t.kind === TOOL_FOR[m] ? 1 / t.speed : 1;
}

/** Leaves give nothing (for now); nor do objects' voxels (taking an object down gives the object). */
const GIVES_NOTHING = new Set<MaterialId>([Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves, Material.FenceWood, Material.GateWood, Material.DoorWood, Material.TorchWood, Material.TorchFlame]);
const GIVES: Readonly<Partial<Record<MaterialId, MaterialId>>> = {
  ...Object.fromEntries(GROUNDS.map((m) => [m, Material.Dirt])),
  [Material.Stone]: Material.Cobblestone,
  [Material.CoalOre]: Material.Coal,
  [Material.IronOre]: Material.RawIron,
  [Material.CopperOre]: Material.RawCopper,
  [Material.GoldOre]: Material.RawGold,
};

/** What mining a material with `tool` (null: by hand) gives in survival (null: nothing). */
export function dropOf(material: MaterialId, tool: ItemId | null = null): MaterialId | null {
  if (isWater(material) || GIVES_NOTHING.has(material) || !canHarvest(material, tool)) return null;
  return GIVES[material] ?? material;
}
