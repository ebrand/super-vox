import { Material, type MaterialId } from './materials.js';

/** Biomes, decided per column from temperature and moisture. */
export const Biome = {
  Ice: 0,
  Tundra: 1,
  Boreal: 2,
  Temperate: 3,
  Grassland: 4,
  Jungle: 5,
  Savanna: 6,
  Desert: 7,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

export const BIOME_NAMES: Record<BiomeId, string> = {
  [Biome.Ice]: 'ice',
  [Biome.Tundra]: 'tundra',
  [Biome.Boreal]: 'boreal forest',
  [Biome.Temperate]: 'temperate forest',
  [Biome.Grassland]: 'grassland',
  [Biome.Jungle]: 'jungle',
  [Biome.Savanna]: 'savanna',
  [Biome.Desert]: 'desert',
};

/** The ground each biome has where nothing else (beach, rock, snow) takes over. */
export const BIOME_GROUND: Record<BiomeId, MaterialId> = {
  [Biome.Ice]: Material.Snow,
  [Biome.Tundra]: Material.Tundra,
  [Biome.Boreal]: Material.TaigaFloor,
  [Biome.Temperate]: Material.Grass,
  [Biome.Grassland]: Material.Meadow,
  [Biome.Jungle]: Material.JungleFloor,
  [Biome.Savanna]: Material.DryGrass,
  [Biome.Desert]: Material.DesertSand,
};

/**
 * Biome for a temperature (degrees C, at the ground) and moisture (0 dry .. 1 wet), after
 * Whittaker's diagram: cold gives ice, tundra and boreal forest; mild gives temperate forest or
 * grassland; hot gives jungle, savanna or desert as it dries out.
 */
export function classifyBiome(temperature: number, moisture: number): BiomeId {
  const t = temperature, m = moisture;
  if (t < -8) return Biome.Ice;
  if (t < -1) return Biome.Tundra;
  if (t < 7) return m < 0.25 ? Biome.Tundra : Biome.Boreal;
  if (t < 19) {
    if (m >= 0.4) return Biome.Temperate;
    return t > 14 && m < 0.15 ? Biome.Desert : Biome.Grassland;
  }
  if (m < 0.2) return Biome.Desert;
  return m < 0.5 ? Biome.Savanna : Biome.Jungle;
}
