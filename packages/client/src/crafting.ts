import { RECIPES, isBlock, itemName, stored, type ItemId, type Recipe } from '@super-vox/shared';

/**
 * A crafting table's slots, as the inventory window keeps them (see InventoryUi): what's on it and
 * how much, in a recipe's terms (blocks whole, items counted). Nothing leaves the inventory until
 * Make: then the server makes the recipe the table matches, as many times as it holds it.
 */
export type Table = readonly (readonly [ItemId, number])[];

/** Slots on a station's table. */
export const TABLE_SLOTS = 7;

/** The table as a map (the same thing in two slots counts once, added up). */
function totals(table: Table): Map<ItemId, number> {
  const m = new Map<ItemId, number>();
  for (const [id, n] of table) if (n > 0) m.set(id, (m.get(id) ?? 0) + n);
  return m;
}

/** The first recipe the table holds exactly (see matchRecipes), or null. */
export function matchRecipe(table: Table, recipes: readonly Recipe[] = RECIPES): { recipe: Recipe; times: number } | null {
  return matchRecipes(table, recipes)[0] ?? null;
}

/**
 * The recipes the table holds exactly (their ingredients and nothing else, in a whole number of
 * batches: order doesn't matter), each with how many times. More than one can: 4 planks are a
 * crafting table, or two lots of sticks; the player chooses.
 */
export function matchRecipes(table: Table, recipes: readonly Recipe[] = RECIPES): { recipe: Recipe; times: number }[] {
  const have = totals(table);
  const out: { recipe: Recipe; times: number }[] = [];
  if (!have.size) return out;
  for (const recipe of recipes) {
    if (recipe.inputs.length !== have.size) continue;
    let times = 0;
    const fits = recipe.inputs.every(([id, n]) => {
      const got = have.get(id);
      if (got === undefined || got % n !== 0) return false;
      const k = got / n;
      if (times && k !== times) return false;
      times = k;
      return true;
    });
    if (fits && times > 0) out.push({ recipe, times });
  }
  return out;
}

/** Recipes that use everything on the table so far (more may be needed): what it could become. */
export function couldMake(table: Table, recipes: readonly Recipe[] = RECIPES): Recipe[] {
  const have = totals(table);
  if (!have.size) return [];
  return recipes.filter((r) => [...have.keys()].every((id) => r.inputs.some(([i]) => i === id)));
}

/** How much of `id` the inventory has, in a recipe's terms (whole blocks; items counted). */
export function available(id: ItemId, items: ReadonlyMap<ItemId, number>): number {
  return Math.floor((items.get(id) ?? 0) / stored(id, 1));
}

/** How many times `recipe` can be made from the inventory (`items`), straight off. */
export function timesAvailable(recipe: Recipe, items: ReadonlyMap<ItemId, number>): number {
  return Math.min(...recipe.inputs.map(([id, n]) => Math.floor(available(id, items) / n)));
}

/** How much of `id` is on the table. */
export function onTable(table: Table, id: ItemId): number {
  return totals(table).get(id) ?? 0;
}

/**
 * The table filled for one batch of `recipe` from the inventory (`items`; null: unlimited, as in
 * creative), or why it can't be.
 */
export function fillFor(recipe: Recipe, items: ReadonlyMap<ItemId, number> | null): Table | string {
  const short = items === null ? [] : recipe.inputs.filter(([id, n]) => available(id, items) < n);
  if (short.length) return `need ${short.map(([id, n]) => `${n - available(id, items!)} more ${itemName(id)}`).join(' and ')}`;
  return recipe.inputs.map(([id, n]) => [id, n] as const);
}

/**
 * The table with `n` more of `id` (in the slot already holding it, else the first free one), no
 * more than the inventory has (`items`; null: unlimited) and no more than TABLE_SLOTS kinds; `n`
 * can be negative (to take some off; a slot at 0 is emptied).
 */
export function addToTable(table: Table, id: ItemId, n: number, items: ReadonlyMap<ItemId, number> | null): Table {
  const out = table.map(([i, k]) => [i, k] as [ItemId, number]);
  let slot = out.findIndex(([i]) => i === id);
  if (slot < 0) {
    if (n <= 0 || out.length >= TABLE_SLOTS) return table;
    out.push([id, 0]);
    slot = out.length - 1;
  }
  const most = items === null ? Infinity : available(id, items);
  const next = Math.max(0, Math.min(most, out[slot]![1] + n));
  if (next === 0) out.splice(slot, 1);
  else out[slot]![1] = next;
  return out;
}

/** What a table entry is called: "4 planks", "2 sticks" (blocks are m³). */
export function describeEntry(id: ItemId, n: number): string {
  return `${n}${isBlock(id) ? ' m³' : ''} ${itemName(id)}`;
}
