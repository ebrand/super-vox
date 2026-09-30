/** Material ids. 0 is air; ids are stored as u16. */
export const Material = {
  Air: 0,
  Stone: 1,
  Dirt: 2,
  Grass: 3,
  Sand: 4,
  Snow: 5,
} as const;

export type MaterialId = number;

export const MAX_MATERIAL_ID = 0xffff;
