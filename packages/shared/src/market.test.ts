import { describe, expect, it } from 'vitest';
import { GOLD_COPPER, POST_CELL_M, coins, pay, tradingPosts, worth } from './market.js';
import { Item } from './items.js';
import { Material } from './materials.js';
import { UNITS_PER_METER } from './units.js';

const M = UNITS_PER_METER;

describe('trading posts', () => {
  it('are placed from the seed (the same each time): one near spawn, one a square where there is somewhere', () => {
    // Land everywhere but a sea west of x 4 km.
    const site = (x: number) => (x < 4000 * M ? null : 10 * M);
    const a = tradingPosts('w', 16000, 9000, { x: 8000, z: 4000 }, site);
    expect(tradingPosts('w', 16000, 9000, { x: 8000, z: 4000 }, site)).toEqual(a);
    expect(Math.hypot(a[0]!.x / M - 8000, a[0]!.z / M - 4000)).toBeLessThan(400);
    // (A square each where there's land: x from 4 km, but those near the first left out.)
    expect(a.length).toBeGreaterThan(8);
    expect(a.every((p) => p.x / M >= 4000)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(1 + Math.ceil(16000 / POST_CELL_M) * Math.ceil(9000 / POST_CELL_M));
    // Names their own; another world, other places.
    expect(new Set(a.map((p) => p.name)).size).toBe(a.length);
    expect(new Set(a.map((p) => p.trader.name)).size).toBe(a.length);
    expect(tradingPosts('other', 16000, 9000, { x: 8000, z: 4000 }, site)[1]!.x).not.toBe(a[1]!.x);
    // Each buys ore, timber and food (one kind dearer), and sells tools and more.
    const p = a[0]!;
    expect(p.buys.map((o) => o.item)).toEqual(expect.arrayContaining([Material.Coal, Item.IronIngot, Material.Wood, Item.Pork]));
    expect(p.sells.map((o) => o.item)).toEqual(expect.arrayContaining([Item.IronPickaxe, Item.Torch]));
    expect(a.some((t) => t.buys.find((o) => o.item === Item.IronIngot)!.price > 3)).toBe(true);
  });

  it('paid for in coins: copper first, then gold, change given back; paid out in gold and copper', () => {
    expect(worth(3, 2)).toBe(3 + 2 * GOLD_COPPER);
    expect(pay(7, 10, 0)).toEqual({ copper: 7, gold: 0, change: 0 });
    expect(pay(17, 4, 3)).toEqual({ copper: 4, gold: 2, change: 7 });
    expect(pay(50, 4, 3)).toBeNull();
    expect(coins(23)).toEqual({ gold: 2, copper: 3 });
  });
});
