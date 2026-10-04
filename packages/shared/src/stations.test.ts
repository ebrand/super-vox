import { describe, expect, it } from 'vitest';
import { BLOCK_VOLUME, Item } from './items.js';
import { Material } from './materials.js';
import { RECIPES } from './recipes.js';
import { STATION_OUTPUT_MAX, advance, emptyStation, isStationState, put, refusePut, stationWorking, take } from './stations.js';
import { FOODS } from './survival.js';
import { attackDamage } from './mobs.js';
import { SWORDS, TOOLS, canHarvest } from './tools.js';

const PIECE = BLOCK_VOLUME / 8;
const s = (seconds: number) => seconds * 1000;

describe('furnaces and stoves', () => {
  it('smelt raw iron into ingots (8 a block), 10 s each, burning fuel only while they work', () => {
    const f = emptyStation(0);
    put(f, 'input', Material.RawIron, BLOCK_VOLUME);
    expect(stationWorking('furnace', f)).toBe(false); // (no fuel)
    advance('furnace', f, s(100));
    expect(f.output).toBeNull();
    // A piece of planks: 5 s. Half an ingot, then it waits for fuel (and starts that one again).
    f.at = s(100);
    put(f, 'fuel', Material.Planks, PIECE);
    advance('furnace', f, s(103));
    expect(f.progress).toBeCloseTo(3, 9);
    advance('furnace', f, s(200));
    expect(f.output).toBeNull();
    expect(f.progress).toBe(0);
    expect(f.fuel).toBeNull();
    // Coal: 80 s a piece, 8 ingots. A block of raw iron in 80 s.
    put(f, 'fuel', Material.Coal, BLOCK_VOLUME);
    advance('furnace', f, s(280));
    expect(f.output).toEqual({ item: Item.IronIngot, amount: 8 });
    expect(f.input).toBeNull();
    expect(f.fuel!.amount).toBe(BLOCK_VOLUME - PIECE);
    // Nothing to smelt: the fuel left waits (it burns only while working).
    advance('furnace', f, s(10_000));
    expect(f.fuel!.amount).toBe(BLOCK_VOLUME - PIECE);
    expect(f.burn).toBe(0);
  });

  it('work it out the same however often they are looked at (no one need be near)', () => {
    const fill = () => {
      const f = emptyStation(0);
      put(f, 'input', Material.RawIron, 3 * BLOCK_VOLUME + PIECE / 2);
      put(f, 'fuel', Material.Wood, 2 * BLOCK_VOLUME);
      return f;
    };
    const once = fill(), often = fill();
    advance('furnace', once, s(500));
    for (let t = 0; t <= 500; t += 0.7) advance('furnace', often, s(t));
    advance('furnace', often, s(500));
    expect(often.output).toEqual(once.output);
    expect(often.fuel!.amount).toBe(once.fuel!.amount);
    expect(often.progress).toBeCloseTo(once.progress, 6);
    // Three blocks and half a piece of raw iron: 24 ingots (240 s, 12 pieces of wood), the half piece left over.
    expect(once.output).toEqual({ item: Item.IronIngot, amount: 24 });
    expect(once.input).toEqual({ item: Material.RawIron, amount: PIECE / 2 });
    expect(once.fuel!.amount).toBe(2 * BLOCK_VOLUME - 12 * PIECE);
    advance('furnace', once, s(5000));
    expect(once.output!.amount).toBe(24);
  });

  it('stop when the output is full, and start again when it is taken', () => {
    const f = emptyStation(0);
    put(f, 'input', Material.RawIron, 10 * BLOCK_VOLUME);
    put(f, 'fuel', Material.Coal, 2 * BLOCK_VOLUME);
    advance('furnace', f, s(10_000));
    expect(f.output!.amount).toBe(STATION_OUTPUT_MAX);
    expect(stationWorking('furnace', f)).toBe(false);
    expect(take(f, 'output')).toEqual({ item: Item.IronIngot, amount: STATION_OUTPUT_MAX });
    expect(stationWorking('furnace', f)).toBe(true);
    advance('furnace', f, s(10_010));
    expect(f.output).toEqual({ item: Item.IronIngot, amount: 1 });
  });

  it('take only what they use: a stove cooks pork, a furnace smelts raw iron; fuel burns', () => {
    const st = emptyStation(0);
    expect(refusePut('stove', st, 'input', Item.Pork)).toBeNull();
    expect(refusePut('stove', st, 'input', Material.RawIron)).toMatch(/cooks pork/);
    expect(refusePut('furnace', st, 'input', Item.Pork)).toMatch(/smelts raw iron/);
    expect(refusePut('furnace', st, 'fuel', Material.Stone)).toMatch(/doesn't burn/);
    expect(refusePut('furnace', st, 'output', Item.IronIngot)).toMatch(/come out/);
    put(st, 'fuel', Item.Stick, 2);
    expect(refusePut('stove', st, 'fuel', Material.Coal)).toMatch(/something else/);
    put(st, 'input', Item.Pork, 3);
    advance('stove', st, s(10));
    expect(st.output).toEqual({ item: Item.CookedPork, amount: 1 });
    expect(st.fuel).toBeNull(); // (two sticks: 10 s)
    expect(isStationState(JSON.parse(JSON.stringify(st)))).toBe(true);
    expect(isStationState({ fuel: 3 })).toBe(false);
  });
});

describe('iron', () => {
  it('makes the best tools and sword; cooked pork beats raw', () => {
    expect(TOOLS[Item.IronPickaxe]).toMatchObject({ kind: 'pickaxe', tier: 3 });
    expect(canHarvest(Material.IronOre, Item.IronPickaxe)).toBe(true);
    expect(attackDamage(Item.IronSword)).toBeGreaterThan(attackDamage(Item.StoneSword));
    expect(attackDamage(Item.StoneSword)).toBeGreaterThan(attackDamage(Item.WoodenSword));
    expect(attackDamage(null)).toBe(1);
    expect(attackDamage(Item.Pork)).toBe(1);
    expect(SWORDS[Item.IronSword]!.cut).toBeGreaterThanOrEqual(SWORDS[Item.StoneSword]!.cut);
    for (const t of [Item.IronPickaxe, Item.IronAxe, Item.IronShovel, Item.IronSword]) expect(RECIPES.some((r) => r.output[0] === t && r.inputs.some(([i]) => i === Item.IronIngot))).toBe(true);
    expect(FOODS[Item.CookedPork]).toBeGreaterThan(FOODS[Item.Pork]! * 2);
  });
});
