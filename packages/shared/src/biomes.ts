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
/** Every temperature and moisture at which classifyBiome changes its answer. */
const T_EDGES = [-8, -1, 7, 14, 19];
const M_EDGES = [0.15, 0.2, 0.25, 0.4, 0.5];

/** Whether classifyBiome gives one answer for every climate in the box (closed ranges). */
export function sameBiome(tLo: number, tHi: number, mLo: number, mHi: number): boolean {
  return !T_EDGES.some((e) => e > tLo && e <= tHi) && !M_EDGES.some((e) => e > mLo && e <= mHi);
}

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

/**
 * How far a climate is spread when biomes blend (see biomeWeights): +-degrees C and +-moisture,
 * with a triangular falloff. Zero: sharp borders.
 */
export interface Ecotone {
  degrees: number;
  moisture: number;
}

export const SHARP: Ecotone = { degrees: 0, moisture: 0 };

/** Two uniform randoms in [0, 1) as a triangular one in (-1, 1), most often near 0. */
export function triangular(u: number, v: number): number {
  return u + v - 1;
}

/** The biome of a climate nudged by a triangular random offset within the ecotone (u1..v2 uniform in [0, 1)). */
export function blendedBiome(temperature: number, moisture: number, e: Ecotone, u1: number, v1: number, u2: number, v2: number): BiomeId {
  return classifyBiome(temperature + e.degrees * triangular(u1, v1), moisture + e.moisture * triangular(u2, v2));
}

const WEIGHT_STEPS = 12;
/** Points splitting the triangular distribution on (-1, 1) into equally likely parts. */
const TRIANGULAR_POINTS = Array.from({ length: WEIGHT_STEPS }, (_, i) => {
  const p = (i + 0.5) / WEIGHT_STEPS;
  return p < 0.5 ? -1 + Math.sqrt(2 * p) : 1 - Math.sqrt(2 * (1 - p));
});

/**
 * Share of each biome (indexed by BiomeId, summing to 1) among climates spread around
 * (temperature, moisture) by the ecotone: what blendedBiome picks, on average.
 */
export function biomeWeights(temperature: number, moisture: number, e: Ecotone): Float64Array {
  const out = new Float64Array(8);
  const share = 1 / (WEIGHT_STEPS * WEIGHT_STEPS);
  for (const a of TRIANGULAR_POINTS) {
    for (const b of TRIANGULAR_POINTS) out[classifyBiome(temperature + e.degrees * a, moisture + e.moisture * b)]! += share;
  }
  return out;
}
