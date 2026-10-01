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
} as const;

/** Flowing water reaches this many blocks from its source. */
export const MAX_FLOW = 7;

/** Whether a material is water (a source or flowing). */
export function isWater(m: number): boolean {
  return m >= Material.Water && m <= Material.Water + MAX_FLOW;
}

/** Flow level of a water material: 0 for a source, 1..MAX_FLOW for flowing water. */
export function waterLevelOf(m: number): number {
  return m - Material.Water;
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
};

export function materialName(m: MaterialId): string {
  return isWater(m) ? 'water' : (MATERIAL_NAMES[m] ?? `material ${m}`);
}
