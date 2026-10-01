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
} as const;

export type MaterialId = number;

export const MAX_MATERIAL_ID = 0xffff;
