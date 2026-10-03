import { describe, expect, it } from 'vitest';
import { blockIndex, emptyChunk } from './chunk.js';
import { ALL_ITEMS, BLOCK_VOLUME, Item, dropOf, formatAmount, isBlock, itemName } from './items.js';
import { Material } from './materials.js';
import { RECIPES, TABLE_REACH, cannotCraft, craft, describeRecipe, materialNearIn, recipeById } from './recipes.js';

const B = BLOCK_VOLUME;

describe('recipes', () => {
  it('turn wood into planks, planks into sticks and a crafting table', () => {
    const items = new Map([[Material.Wood, 1.5 * B]]);
    expect(cannotCraft(recipeById('planks')!, items, false)).toBeNull();
    craft(recipeById('planks')!, items);
    expect(items).toEqual(new Map([[Material.Wood, 0.5 * B], [Material.Planks, 4 * B]]));
    expect(cannotCraft(recipeById('planks')!, items, false)).toBe('need 0.5 more wood');
    craft(recipeById('sticks')!, items);
    expect(items).toEqual(new Map([[Material.Wood, 0.5 * B], [Material.Planks, 2 * B], [Item.Stick, 4]]));
    expect(cannotCraft(recipeById('crafting-table')!, items, false)).toBe('need 2 more planks');
  });

  it('need a crafting table nearby for tools and things to build', () => {
    const items = new Map<number, number>([[Material.Planks, 10 * B], [Item.Stick, 5], [Material.Cobblestone, 2 * B]]);
    expect(cannotCraft(recipeById('wooden-sword')!, items, false)).toBe('needs a crafting table placed nearby');
    expect(cannotCraft(recipeById('wooden-sword')!, items, true)).toBeNull();
    craft(recipeById('stone-sword')!, items);
    expect(items.has(Material.Cobblestone)).toBe(false); // used up exactly
    expect(items.get(Item.StoneSword)).toBe(1);
    expect(items.get(Item.Stick)).toBe(4);
    expect(cannotCraft(recipeById('stone-sword')!, items, true)).toBe('need 2 more cobblestone');
    expect(cannotCraft(recipeById('gate')!, new Map(), true)).toBe('need 4 more stick and 2 more planks');
  });

  it('are all well formed: unique ids, known things, something from something', () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const r of RECIPES) {
      for (const [id, n] of [...r.inputs, r.output]) {
        expect(ALL_ITEMS).toContain(id);
        expect(n).toBeGreaterThan(0);
      }
    }
    expect(describeRecipe(recipeById('wooden-sword')!)).toBe('2 planks + 1 stick → 1 wooden sword');
  });

  it('count blocks by volume and items whole', () => {
    expect(isBlock(Material.Planks)).toBe(true);
    expect(isBlock(Item.Door)).toBe(false);
    expect(formatAmount(Material.Planks, 2.5 * B)).toBe('2.5');
    expect(formatAmount(Item.Stick, 7)).toBe('7');
    expect(itemName(Item.Bucket)).toBe('bucket');
    expect(itemName(Material.CraftingTable)).toBe('crafting table');
  });

  it('make mined stone cobblestone', () => {
    expect(dropOf(Material.Stone)).toBe(Material.Cobblestone);
    expect(dropOf(Material.Cobblestone)).toBe(Material.Cobblestone);
  });
});

describe('materialNearIn', () => {
  it('finds a material within reach (by 1 m block), not beyond, and not in chunks it does not have', () => {
    const table = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    table.blocks[blockIndex(3, 0, 3)] = { kind: 'uniform', size: 16, material: Material.CraftingTable };
    const chunkAt = (cx: number, cy: number, cz: number) => (cx === 0 && cy === 0 && cz === 0 ? table : undefined);
    const at = (bx: number) => materialNearIn(chunkAt, bx * 16 + 8, 8, 3 * 16 + 8, TABLE_REACH, Material.CraftingTable);
    expect(at(3)).toBe(true);
    expect(at(8)).toBe(true); // 5 blocks off
    expect(at(9)).toBe(false); // 6
    expect(materialNearIn(() => undefined, 56, 8, 56, TABLE_REACH, Material.CraftingTable)).toBe(false);
  });
});
