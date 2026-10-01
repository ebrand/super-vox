import { Material, type MaterialId } from '@super-vox/shared';

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
};

export function materialName(id: MaterialId): string {
  return NAMES[id] ?? `material ${id}`;
}
