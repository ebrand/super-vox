import { Item, type ItemId } from './items.js';
import { Material, type MaterialId } from './materials.js';
import { TreeKind, type TreeKindId } from './trees.js';

/**
 * Saplings: leaves dug now and then give one of their tree's kind; planted on grass or dirt (a
 * sapling a block, the block over it open), it grows into a tree of that kind (see grownTree)
 * after SAPLING_GROW_MS, by the server's clock, so wood can be farmed. The tree goes only where
 * there's room (nothing built is lost to it); a sapling dug or built over is gone.
 */

/** How long a sapling takes to grow into a tree (ms). */
export const SAPLING_GROW_MS = 20 * 60_000;

/** A sapling for each block (by volume) of leaves dug, this often: a crown's worth gives a few. */
export const SAPLING_CHANCE = 0.1;

/** The sapling each kind of leaves gives. */
export const SAPLING_OF_LEAVES: Readonly<Partial<Record<MaterialId, ItemId>>> = {
  [Material.Leaves]: Item.OakSapling,
  [Material.Needles]: Item.PineSapling,
  [Material.JungleLeaves]: Item.JungleSapling,
  [Material.AcaciaLeaves]: Item.AcaciaSapling,
};

/** The tree each sapling grows into. */
export const TREE_OF_SAPLING: Readonly<Partial<Record<ItemId, TreeKindId>>> = {
  [Item.OakSapling]: TreeKind.Broadleaf,
  [Item.PineSapling]: TreeKind.Conifer,
  [Item.JungleSapling]: TreeKind.Jungle,
  [Item.AcaciaSapling]: TreeKind.Acacia,
};

export function isSapling(id: ItemId): boolean {
  return TREE_OF_SAPLING[id] !== undefined;
}

/** What saplings are planted on: grass of any kind, and dirt. */
export const PLANTABLE: ReadonlySet<MaterialId> = new Set<MaterialId>([Material.Grass, Material.Meadow, Material.JungleFloor, Material.DryGrass, Material.TaigaFloor, Material.Tundra, Material.Dirt]);

/** How far along a sapling planted at `planted` is at `now` (0..1: 1, grown). */
export function saplingGrowth(planted: number, now: number): number {
  return Math.max(0, Math.min(1, (now - planted) / SAPLING_GROW_MS));
}
