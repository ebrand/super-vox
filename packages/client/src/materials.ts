import { Material, type MaterialId } from '@super-vox/shared';

/** Linear-space RGB per material. Unknown ids render magenta so they stand out. */
const COLORS: Record<number, readonly [number, number, number]> = {
  [Material.Stone]: [0.32, 0.32, 0.34],
  [Material.Dirt]: [0.33, 0.2, 0.1],
  [Material.Grass]: [0.18, 0.4, 0.1],
};

const UNKNOWN = [1, 0, 1] as const;

export function materialColor(id: MaterialId): readonly [number, number, number] {
  return COLORS[id] ?? UNKNOWN;
}
