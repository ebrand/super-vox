/** Material ids. 0 is air; ids are stored as u16. */
export const Material = {
  Air: 0,
  Stone: 1,
  Dirt: 2,
  Grass: 3,
  Sand: 4,
  Snow: 5,
  /** Biome grounds (see biomes.ts). */
  JungleFloor: 6,
  DryGrass: 7,
  Meadow: 8,
  TaigaFloor: 9,
  Tundra: 10,
  DesertSand: 11,
  /** Trees (see trees.ts). */
  Wood: 12,
  Leaves: 13,
  Needles: 14,
  JungleLeaves: 15,
  AcaciaLeaves: 16,
  /** Water: a source (sea, lakes, placed water) at 17, flowing water 1..7 blocks from one at 18..24 (see water.ts). */
  Water: 17,
  /** Polar ice (round worlds' north and south edges). */
  Ice: 25,
  /** Made by players (see recipes.ts). */
  Planks: 26,
  Cobblestone: 27,
  CraftingTable: 28,
  /** Placed objects (see objects.ts): each its own material, so a click on one is recognised. */
  FenceWood: 29,
  GateWood: 30,
  DoorWood: 31,
  /**
   * Water players poured (from buckets): finite, it falls and levels out (see PouredWater), unlike
   * the sea, lakes and rivers (Water), which stay put and never run dry.
   */
  PouredWater: 32,
  /** Explosives: lit with a click, they blow a crater after a fuse (see explosives.ts). */
  TNT: 33,
  /** As TNT, far stronger: a 1/8 m voxel blows as a 1 m TNT block (see EXPLOSIVE_POWER). */
  C4: 34,
  /** Metal on things players make (a crafting table's hammer and square, see objects.ts): dark and light. */
  DarkMetal: 35,
  LightMetal: 36,
  /** Ores in the rock, deep down (see ores.ts): mined with a pickaxe, they give coal and raw iron (see dropOf). */
  CoalOre: 37,
  IronOre: 38,
  /** What ores give: kept by volume as blocks are, but never placed (see PLACEABLE). */
  Coal: 39,
  RawIron: 40,
  /** Bare rock's surface besides stone (see PlateHeights.rockSurface): scree, dark and pale stone, and stone gone mossy. */
  Gravel: 41,
  DarkStone: 42,
  PaleStone: 43,
  MossyStone: 44,
} as const;

/** Flowing water reaches this many blocks from its source. */
export const MAX_FLOW = 7;

/** Whether a material is water (natural, flowing from older worlds, or poured). */
export function isWater(m: number): boolean {
  return (m >= Material.Water && m <= Material.Water + MAX_FLOW) || m === Material.PouredWater;
}

/** Flow level of a water material: 0 for a source (and poured water), 1..MAX_FLOW for flowing water. */
export function waterLevelOf(m: number): number {
  return m === Material.PouredWater ? 0 : m - Material.Water;
}

/** Water material for a flow level (0 = source). */
export function waterMaterial(level: number): number {
  return Material.Water + level;
}

export type MaterialId = number;

export const MAX_MATERIAL_ID = 0xffff;

/** People's names for materials. */
const MATERIAL_NAMES: Record<number, string> = {
  [Material.Stone]: 'stone',
  [Material.Dirt]: 'dirt',
  [Material.Grass]: 'grass',
  [Material.Sand]: 'sand',
  [Material.Snow]: 'snow',
  [Material.JungleFloor]: 'jungle floor',
  [Material.DryGrass]: 'dry grass',
  [Material.Meadow]: 'meadow',
  [Material.TaigaFloor]: 'taiga floor',
  [Material.Tundra]: 'tundra',
  [Material.DesertSand]: 'desert sand',
  [Material.Wood]: 'wood',
  [Material.Leaves]: 'leaves',
  [Material.Needles]: 'needles',
  [Material.JungleLeaves]: 'jungle leaves',
  [Material.AcaciaLeaves]: 'acacia leaves',
  [Material.Ice]: 'ice',
  [Material.Planks]: 'planks',
  [Material.Cobblestone]: 'cobblestone',
  [Material.CraftingTable]: 'crafting table',
  [Material.FenceWood]: 'fence',
  [Material.GateWood]: 'gate',
  [Material.DoorWood]: 'door',
  [Material.TNT]: 'TNT',
  [Material.C4]: 'C4',
  [Material.DarkMetal]: 'dark metal',
  [Material.LightMetal]: 'light metal',
  [Material.CoalOre]: 'coal ore',
  [Material.IronOre]: 'iron ore',
  [Material.Coal]: 'coal',
  [Material.RawIron]: 'raw iron',
  [Material.Gravel]: 'gravel',
  [Material.DarkStone]: 'dark stone',
  [Material.PaleStone]: 'pale stone',
  [Material.MossyStone]: 'mossy stone',
};


export function materialName(m: MaterialId): string {
  return isWater(m) ? 'water' : (MATERIAL_NAMES[m] ?? `material ${m}`);
}
