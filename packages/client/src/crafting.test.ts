import { describe, expect, it } from 'vitest';
import { BLOCK_VOLUME, Item, Material, recipeById } from '@super-vox/shared';
import { TABLE_SLOTS, addToTable, available, couldMake, fillFor, matchRecipe, matchRecipes, timesAvailable, type Table } from './crafting.js';

const B = BLOCK_VOLUME;

describe('crafting table', () => {
  it('matches the recipe it holds exactly, in any order, in whole batches', () => {
    const sword = recipeById('wooden-sword')!; // 2 planks + 1 stick
    expect(matchRecipe([[Material.Planks, 2], [Item.Stick, 1]])).toEqual({ recipe: sword, times: 1 });
    expect(matchRecipe([[Item.Stick, 1], [Material.Planks, 2]])).toEqual({ recipe: sword, times: 1 });
    expect(matchRecipe([[Material.Planks, 6], [Item.Stick, 3]])).toEqual({ recipe: sword, times: 3 });
    // Not whole batches, too little, something extra: nothing.
    expect(matchRecipe([[Material.Planks, 3], [Item.Stick, 1]])).toBeNull();
    expect(matchRecipe([[Item.Stick, 1]])).toBeNull();
    expect(matchRecipe([[Material.Planks, 2]])?.recipe.id).toBe('sticks'); // (2 planks alone: that's sticks)
    expect(matchRecipe([[Material.Planks, 2], [Item.Stick, 1], [Material.Dirt, 1]])).toBeNull();
    expect(matchRecipe([])).toBeNull();
    // Two that fit: 4 planks are a crafting table, or two lots of sticks.
    expect(matchRecipes([[Material.Planks, 4]]).map((m) => [m.recipe.id, m.times])).toEqual([['sticks', 2], ['crafting-table', 1]]);
    // One ingredient: planks from wood, as many as there's wood for.
    expect(matchRecipe([[Material.Wood, 3]])).toEqual({ recipe: recipeById('planks'), times: 3 });
  });

  it('says what what is on it could become', () => {
    const ids = (t: Table) => couldMake(t).map((r) => r.id);
    expect(ids([[Item.Stick, 1]])).toEqual(expect.arrayContaining(['wooden-sword', 'stone-sword', 'fences', 'gate']));
    expect(ids([[Item.Stick, 1], [Material.Cobblestone, 1]])).toEqual(['stone-sword', 'stone-pickaxe', 'stone-axe', 'stone-shovel', 'geologists-hammer']);
    expect(ids([[Material.Dirt, 1]])).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  it('fills itself for a recipe from the inventory, or says what is missing', () => {
    const fences = recipeById('fences')!; // 4 planks + 2 sticks
    const inv = new Map([[Material.Planks, 5 * B], [Item.Stick, 1]]);
    expect(fillFor(fences, inv)).toBe('need 1 more stick');
    inv.set(Item.Stick, 2);
    expect(fillFor(fences, inv)).toEqual([[Material.Planks, 4], [Item.Stick, 2]]);
    expect(fillFor(fences, null)).toEqual([[Material.Planks, 4], [Item.Stick, 2]]); // creative
  });

  it('says how many times a recipe can be made from what there is', () => {
    const fences = recipeById('fences')!; // 4 planks + 2 sticks
    expect(timesAvailable(fences, new Map([[Material.Planks, 9 * B], [Item.Stick, 7]]))).toBe(2);
    expect(timesAvailable(fences, new Map([[Material.Planks, 9 * B]]))).toBe(0);
    expect(timesAvailable(recipeById('planks')!, new Map([[Material.Wood, 3.5 * B]]))).toBe(3);
  });

  it('adds and takes away, within what there is and the slots there are', () => {
    // 2.5 blocks of planks: 2 whole ones to craft with.
    const inv = new Map([[Material.Planks, 2.5 * B], [Item.Stick, 4]]);
    expect(available(Material.Planks, inv)).toBe(2);
    let t: Table = [];
    t = addToTable(t, Material.Planks, 1, inv);
    t = addToTable(t, Material.Planks, 5, inv); // only 2 in all
    expect(t).toEqual([[Material.Planks, 2]]);
    t = addToTable(t, Item.Stick, 1, inv);
    t = addToTable(t, Material.Planks, -1, inv);
    expect(t).toEqual([[Material.Planks, 1], [Item.Stick, 1]]);
    t = addToTable(t, Material.Planks, -1, inv); // emptied: the slot goes
    expect(t).toEqual([[Item.Stick, 1]]);
    expect(addToTable(t, Material.Dirt, 1, inv)).toEqual(t); // none of it
    expect(addToTable([], Material.Dirt, 3, null)).toEqual([[Material.Dirt, 3]]); // creative
    // No more kinds than slots.
    let full: Table = [];
    for (let i = 0; i < TABLE_SLOTS + 2; i++) full = addToTable(full, 1 + i, 1, null);
    expect(full.length).toBe(TABLE_SLOTS);
  });
});
