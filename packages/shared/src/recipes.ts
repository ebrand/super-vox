import { BLOCK_VOLUME, Item, formatAmount, isBlock, itemName, type ItemId } from './items.js';
import { BLOCK_SIZE, BLOCKS_PER_AXIS, blockIndex, type Chunk } from './chunk.js';
import { Material, type MaterialId } from './materials.js';

/** What a recipe makes, for grouping them (see RECIPE_GROUPS). */
export type RecipeGroup = 'materials' | 'building' | 'tools' | 'explosives';

/** The groups in the order recipes are shown, with their names. */
export const RECIPE_GROUPS: readonly { group: RecipeGroup; name: string }[] = [
  { group: 'materials', name: 'Materials' },
  { group: 'building', name: 'Building' },
  { group: 'tools', name: 'Tools and weapons' },
  { group: 'explosives', name: 'Explosives' },
];

/**
 * Something players can make: `inputs` used up, `output` made. Block amounts are given in blocks
 * here (and kept as volumes, see BLOCK_VOLUME); items are counted. `table`: only within reach of
 * a placed crafting table (TABLE_REACH).
 */
export interface Recipe {
  id: string;
  group: RecipeGroup;
  inputs: readonly (readonly [ItemId, number])[];
  output: readonly [ItemId, number];
  table: boolean;
}

/** How far (units, Chebyshev) a crafting table can be for recipes that need one: 5 m. */
export const TABLE_REACH = 5 * 16;

/**
 * Whether any voxel of `material` is in a 1 m block within `reach` (units, Chebyshev, by block) of
 * (x, y, z) (units), the world's chunks read through `chunkAt` (null: empty; undefined: not known,
 * so not counted). Used by the server and by clients (to show what's possible) alike.
 */
export function materialNearIn(chunkAt: (cx: number, cy: number, cz: number) => Chunk | null | undefined, x: number, y: number, z: number, reach: number, material: MaterialId): boolean {
  const n = BLOCKS_PER_AXIS;
  const b0 = (v: number) => Math.floor((v - reach) / BLOCK_SIZE), b1 = (v: number) => Math.floor((v + reach) / BLOCK_SIZE);
  for (let cy = Math.floor(b0(y) / n); cy <= Math.floor(b1(y) / n); cy++)
    for (let cz = Math.floor(b0(z) / n); cz <= Math.floor(b1(z) / n); cz++)
      for (let cx = Math.floor(b0(x) / n); cx <= Math.floor(b1(x) / n); cx++) {
        const chunk = chunkAt(cx, cy, cz);
        if (!chunk) continue;
        for (let by = Math.max(0, b0(y) - cy * n); by <= Math.min(n - 1, b1(y) - cy * n); by++)
          for (let bz = Math.max(0, b0(z) - cz * n); bz <= Math.min(n - 1, b1(z) - cz * n); bz++)
            for (let bx = Math.max(0, b0(x) - cx * n); bx <= Math.min(n - 1, b1(x) - cx * n); bx++) {
              const b = chunk.blocks[blockIndex(bx, by, bz)];
              if (!b) continue;
              if (b.kind === 'uniform' ? b.material === material : b.materials.includes(material)) return true;
            }
      }
  return false;
}

const r = (id: string, group: RecipeGroup, inputs: [ItemId, number][], output: [ItemId, number], table = false): Recipe => ({ id, group, inputs, output, table });

/** In the order the inventory lists them. */
export const RECIPES: readonly Recipe[] = [
  r('planks', 'materials', [[Material.Wood, 1]], [Material.Planks, 4]),
  r('sticks', 'materials', [[Material.Planks, 2]], [Item.Stick, 4]),
  r('crafting-table', 'building', [[Material.Planks, 4]], [Item.CraftingTable, 1]),
  r('wooden-sword', 'tools', [[Material.Planks, 2], [Item.Stick, 1]], [Item.WoodenSword, 1], true),
  r('stone-sword', 'tools', [[Material.Cobblestone, 2], [Item.Stick, 1]], [Item.StoneSword, 1], true),
  r('fences', 'building', [[Material.Planks, 4], [Item.Stick, 2]], [Item.Fence, 3], true),
  r('gate', 'building', [[Item.Stick, 4], [Material.Planks, 2]], [Item.Gate, 1], true),
  r('doors', 'building', [[Material.Planks, 6]], [Item.Door, 3], true),
  r('bucket', 'tools', [[Material.Planks, 3]], [Item.Bucket, 1], true),
  r('tnt', 'explosives', [[Material.Sand, 4], [Material.Planks, 1]], [Material.TNT, 1], true),
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
  if (recipe.table && !nearTable) return 'needs a crafting table placed nearby';
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
