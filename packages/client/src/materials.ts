import { BIOME_GROUND, MAX_FLOW, Material, type MaterialId } from '@super-vox/shared';

/** Number of material colors the shader can look up; ids beyond render magenta. */
export const PALETTE_SIZE = 64;

/** Linear-space RGB per material. Unknown ids render magenta so they stand out. */
const COLORS: Record<number, readonly [number, number, number]> = {
  [Material.Stone]: [0.32, 0.32, 0.34],
  [Material.Dirt]: [0.33, 0.2, 0.1],
  [Material.Grass]: [0.18, 0.4, 0.1],
  [Material.Sand]: [0.62, 0.55, 0.36],
  [Material.Snow]: [0.86, 0.88, 0.9],
  [Material.JungleFloor]: [0.07, 0.27, 0.05],
  [Material.DryGrass]: [0.42, 0.38, 0.13],
  [Material.Meadow]: [0.3, 0.44, 0.12],
  [Material.TaigaFloor]: [0.11, 0.24, 0.13],
  [Material.Tundra]: [0.3, 0.29, 0.2],
  [Material.DesertSand]: [0.7, 0.47, 0.25],
  [Material.Wood]: [0.2, 0.12, 0.06],
  [Material.Leaves]: [0.1, 0.3, 0.06],
  [Material.Needles]: [0.05, 0.17, 0.08],
  [Material.JungleLeaves]: [0.04, 0.22, 0.03],
  [Material.AcaciaLeaves]: [0.22, 0.3, 0.07],
  [Material.Ice]: [0.62, 0.74, 0.84],
  [Material.Planks]: [0.45, 0.29, 0.13],
  [Material.Cobblestone]: [0.22, 0.22, 0.23],
  [Material.CraftingTable]: [0.33, 0.17, 0.07],
  [Material.TNT]: [0.78, 0.12, 0.09],
  [Material.C4]: [0.62, 0.6, 0.48],
  [Material.DarkMetal]: [0.05, 0.05, 0.06],
  [Material.LightMetal]: [0.42, 0.44, 0.47],
  [Material.FenceWood]: [0.4, 0.26, 0.12],
  [Material.GateWood]: [0.36, 0.22, 0.1],
  [Material.DoorWood]: [0.3, 0.17, 0.07],
  [Material.CoalOre]: [0.11, 0.11, 0.12],
  [Material.IronOre]: [0.42, 0.3, 0.22],
  [Material.Coal]: [0.03, 0.03, 0.035],
  [Material.RawIron]: [0.52, 0.36, 0.26],
  [Material.Gravel]: [0.44, 0.39, 0.32],
  [Material.DarkStone]: [0.17, 0.17, 0.19],
  [Material.PaleStone]: [0.55, 0.53, 0.5],
  [Material.MossyStone]: [0.24, 0.3, 0.2],
  // (Layered rock: close to stone and to each other, a tint each, so layers show as faint striations,
  // not stripes: telling them apart is a geologist's job. Coal stays black: a seam shows.)
  [Material.Sandstone]: [0.4, 0.37, 0.32],
  [Material.Shale]: [0.3, 0.3, 0.32],
  [Material.Limestone]: [0.42, 0.41, 0.39],
  [Material.Granite]: [0.38, 0.35, 0.35],
  // (Dikes darker than the layers; ores tinted to be spotted: copper greenish, gold yellow.)
  [Material.Basalt]: [0.2, 0.2, 0.22],
  [Material.CopperOre]: [0.27, 0.4, 0.34],
  [Material.GoldOre]: [0.58, 0.47, 0.18],
  [Material.RawCopper]: [0.6, 0.36, 0.22],
  [Material.RawGold]: [0.8, 0.64, 0.22],
  [Material.Farmland]: [0.26, 0.17, 0.1],
  [Material.Thatch]: [0.72, 0.6, 0.3],
  [Material.TorchWood]: [0.3, 0.18, 0.08],
  // (Drawn at full brightness, whatever the light: see voxelMaterial.)
  [Material.TorchFlame]: [1.0, 0.62, 0.18],
  // Water (drawn by its own shader; this is for places that show a flat colour).
  ...Object.fromEntries(Array.from({ length: MAX_FLOW + 1 }, (_, l) => [Material.Water + l, [0.05, 0.2, 0.3] as const])),
  [Material.PouredWater]: [0.05, 0.2, 0.3],
};

const UNKNOWN = [1, 0, 1] as const;

export function materialColor(id: MaterialId): readonly [number, number, number] {
  return COLORS[id] ?? UNKNOWN;
}

/** PALETTE_SIZE colors indexed by material id, for the shader. */
export function paletteColors(): (readonly [number, number, number])[] {
  return Array.from({ length: PALETTE_SIZE }, (_, id) => materialColor(id));
}

const NAMES: Record<number, string> = {
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
  [Material.Water]: 'water',
  [Material.PouredWater]: 'water',
  [Material.Ice]: 'ice',
  [Material.CoalOre]: 'coal ore',
  [Material.IronOre]: 'iron ore',
  [Material.Coal]: 'coal',
  [Material.RawIron]: 'raw iron',
  [Material.Gravel]: 'gravel',
  [Material.DarkStone]: 'dark stone',
  [Material.PaleStone]: 'pale stone',
  [Material.MossyStone]: 'mossy stone',
  [Material.Sandstone]: 'sandstone',
  [Material.Shale]: 'shale',
  [Material.Limestone]: 'limestone',
  [Material.Granite]: 'granite',
  [Material.Basalt]: 'basalt',
  [Material.CopperOre]: 'copper ore',
  [Material.GoldOre]: 'gold ore',
  [Material.RawCopper]: 'raw copper',
  [Material.RawGold]: 'raw gold',
  [Material.Farmland]: 'farmland',
  [Material.Thatch]: 'thatch',
  [Material.TorchWood]: 'torch',
  [Material.TorchFlame]: 'torch',
  ...Object.fromEntries(Array.from({ length: MAX_FLOW }, (_, l) => [Material.Water + 1 + l, `flowing water (${l + 1})`])),
};

export function materialName(id: MaterialId): string {
  return NAMES[id] ?? `material ${id}`;
}

/**
 * Biome grounds: in worlds whose biomes blend, these take the colour of their local climate
 * (see tint.ts), so one biome's ground shades into the next.
 */
export const TINTED: ReadonlySet<MaterialId> = new Set(Object.values(BIOME_GROUND).filter((m) => m !== Material.Snow));
