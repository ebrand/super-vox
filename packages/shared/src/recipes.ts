import { BLOCK_VOLUME, Item, formatAmount, isBlock, itemName, type ItemId } from './items.js';
import { Material } from './materials.js';

/**
 * Something players can make: `inputs` used up, `output` made. Block amounts are given in blocks
 * here (and kept as volumes, see BLOCK_VOLUME); items are counted. `table`: only within reach of
 * a placed crafting table (TABLE_REACH).
 */
export interface Recipe {
  id: string;
  inputs: readonly (readonly [ItemId, number])[];
  output: readonly [ItemId, number];
  table: boolean;
}

/** How far (units, Chebyshev) a crafting table can be for recipes that need one: 5 m. */
export const TABLE_REACH = 5 * 16;

const r = (id: string, inputs: [ItemId, number][], output: [ItemId, number], table = false): Recipe => ({ id, inputs, output, table });

/** In the order the inventory lists them. */
export const RECIPES: readonly Recipe[] = [
  r('planks', [[Material.Wood, 1]], [Material.Planks, 4]),
  r('sticks', [[Material.Planks, 2]], [Item.Stick, 4]),
  r('crafting-table', [[Material.Planks, 4]], [Material.CraftingTable, 1]),
  r('wooden-sword', [[Material.Planks, 2], [Item.Stick, 1]], [Item.WoodenSword, 1], true),
  r('stone-sword', [[Material.Cobblestone, 2], [Item.Stick, 1]], [Item.StoneSword, 1], true),
  r('fences', [[Material.Planks, 4], [Item.Stick, 2]], [Item.Fence, 3], true),
  r('gate', [[Item.Stick, 4], [Material.Planks, 2]], [Item.Gate, 1], true),
  r('doors', [[Material.Planks, 6]], [Item.Door, 3], true),
  r('bucket', [[Material.Planks, 3]], [Item.Bucket, 1], true),
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((x) => x.id === id);
}

/** An amount as an inventory keeps it: blocks as volumes, items as counts. */
export function stored(id: ItemId, n: number): number {
  return isBlock(id) ? n * BLOCK_VOLUME : n;
}

/** Why `recipe` can't be made from `items` (null if it can). */
export function cannotCraft(recipe: Recipe, items: ReadonlyMap<ItemId, number>, nearTable: boolean): string | null {
  const missing = recipe.inputs
    .filter(([id, n]) => (items.get(id) ?? 0) < stored(id, n))
    .map(([id, n]) => `${formatAmount(id, stored(id, n) - (items.get(id) ?? 0))} more ${itemName(id)}`);
  if (missing.length) return `need ${missing.join(' and ')}`;
  if (recipe.table && !nearTable) return 'needs a crafting table nearby';
  return null;
}

/** Makes `recipe` from `items` (check cannotCraft first). */
export function craft(recipe: Recipe, items: Map<ItemId, number>): void {
  for (const [id, n] of recipe.inputs) {
    const left = (items.get(id) ?? 0) - stored(id, n);
    if (left > 0) items.set(id, left);
    else items.delete(id);
  }
  const [out, n] = recipe.output;
  items.set(out, (items.get(out) ?? 0) + stored(out, n));
}

/** "2 planks + 1 stick → 1 wooden sword" */
export function describeRecipe(recipe: Recipe): string {
  const part = ([id, n]: readonly [ItemId, number]) => `${n} ${itemName(id)}`;
  return `${recipe.inputs.map(part).join(' + ')} → ${part(recipe.output)}`;
}
