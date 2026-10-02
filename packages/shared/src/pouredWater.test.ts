import { describe, expect, it } from 'vitest';
import type { Block } from './chunk.js';
import { Material } from './materials.js';
import { PouredWater, blockFloor, setBlockWater, setPouredWater, waterAmount, waterCapacity, waterKind, type WaterWorld } from './water.js';

const STONE: Block = { kind: 'uniform', size: 16, material: Material.Stone };

/** A world of 1 m blocks: stone at y < 0 (ground), air above, with `blocks` set explicitly. */
function world(within = 20) {
  const blocks = new Map<string, Block>();
  const w: WaterWorld & { amount(x: number, y: number, z: number): number; total(): number } = {
    getBlock: (x, y, z) => {
      if (Math.abs(x) > within || Math.abs(z) > within) return undefined; // past the edge: solid
      const b = blocks.get(`${x},${y},${z}`);
      return b !== undefined ? b : y < 0 ? STONE : null;
    },
    setBlock: (x, y, z, b) => void blocks.set(`${x},${y},${z}`, b),
    amount: (x, y, z) => waterAmount(w.getBlock(x, y, z) ?? null),
    total: () => [...blocks.values()].reduce((s, b) => s + (waterKind(b) === 'poured' ? waterAmount(b) : 0), 0),
  };
  return w;
}

function pour(w: WaterWorld, sim: PouredWater, x: number, y: number, z: number, amount: number) {
  w.setBlock(x, y, z, setPouredWater(w.getBlock(x, y, z) ?? null, amount));
  sim.touch(x, y, z);
}

function settle(w: WaterWorld, sim: PouredWater, max = 500): number {
  for (let i = 0; i < max; i++) if (sim.step(w).length === 0) return i;
  throw new Error('never settled');
}

describe('poured water', () => {
  it('spreads out on flat ground and settles, never making or losing any', () => {
    const w = world(), sim = new PouredWater();
    pour(w, sim, 0, 0, 0, 16);
    settle(w, sim);
    expect(w.total()).toBe(16);
    const wet = [];
    for (let z = -5; z <= 5; z++) for (let x = -5; x <= 5; x++) if (w.amount(x, 0, z) > 0) wet.push(w.amount(x, 0, z));
    expect(wet.length).toBeGreaterThan(4); // it spread
    expect(Math.max(...wet) - Math.min(...wet)).toBeLessThanOrEqual(1); // flat to within a unit
  });

  it('falls into a pit and fills it from the bottom', () => {
    const w = world(), sim = new PouredWater();
    // A 1 x 1 shaft, 2 m deep, walled in.
    for (const y of [-1, -2]) w.setBlock(3, y, 3, null);
    pour(w, sim, 3, 0, 3, 16);
    settle(w, sim);
    expect(w.amount(3, -2, 3)).toBe(16);
    expect(w.amount(3, -1, 3)).toBe(0);
    expect(w.total()).toBe(16);
  });

  it('keeps a walled pool where it is', () => {
    const w = world(), sim = new PouredWater();
    w.setBlock(0, -1, 0, null); // a 1 m hole in the ground
    pour(w, sim, 0, -1, 0, 10);
    expect(settle(w, sim)).toBeLessThan(3);
    expect(w.amount(0, -1, 0)).toBe(10);
  });

  it('joins natural water, which itself never moves or runs dry', () => {
    const w = world(), sim = new PouredWater();
    const sea = setBlockWater(null, 0);
    for (let x = 5; x <= 8; x++) w.setBlock(x, 0, 0, sea);
    // Natural water beside an open hole doesn't pour into it.
    w.setBlock(4, -1, 0, null);
    sim.touch(5, 0, 0);
    expect(settle(w, sim)).toBe(0);
    expect(w.amount(4, -1, 0)).toBe(0);
    // Water poured onto the sea falls into it and is gone.
    pour(w, sim, 6, 1, 0, 16);
    settle(w, sim);
    expect(w.total()).toBe(0);
    // Beside it, at the same height, it stays a puddle (water doesn't run sideways into a level sea).
    pour(w, sim, 9, 0, 0, 8);
    settle(w, sim);
    expect(w.total()).toBe(8);
    for (let x = 5; x <= 8; x++) expect(waterKind(w.getBlock(x, 0, 0)!)).toBe('natural');
  });

  it('measures water from where it rests in part-filled blocks, and runs down steps, never up', () => {
    // Ground filling the bottom `h` units of a block (in 4-unit layers).
    const ground = (h: number): Block => {
      const materials = new Uint16Array(64);
      for (let i = 0; i < 64; i++) if (Math.floor(i / 16) * 4 < h) materials[i] = Material.Stone;
      return { kind: 'grid', size: 4, materials };
    };
    const w = world(), sim = new PouredWater();
    // A terrace: the ground's top at 12/16 m for x <= 0, at 4/16 m for x >= 1 (a step down).
    for (let z = -20; z <= 20; z++) for (let x = -20; x <= 20; x++) w.setBlock(x, 0, z, ground(x <= 0 ? 12 : 4));
    expect(blockFloor(ground(12))).toBe(12);
    expect(waterCapacity(ground(12))).toBe(4);
    pour(w, sim, 0, 0, 0, 4); // at the edge of the upper terrace, as deep as its block allows
    expect(w.amount(0, 0, 0)).toBe(4);
    settle(w, sim);
    expect(w.total()).toBe(4); // none made, none lost in the ground
    // It ran down the step: the lower terrace has it.
    let lower = 0;
    for (let z = -20; z <= 20; z++) for (let x = 1; x <= 20; x++) lower += w.amount(x, 0, z);
    expect(lower).toBe(4);
    // Poured on the lower terrace by the step, none climbs up it.
    const w2 = world(), sim2 = new PouredWater();
    for (let z = -20; z <= 20; z++) for (let x = -20; x <= 20; x++) w2.setBlock(x, 0, z, ground(x <= 0 ? 12 : 4));
    pour(w2, sim2, 1, 0, 0, 12);
    settle(w2, sim2);
    let upper = 0;
    for (let z = -20; z <= 20; z++) for (let x = -20; x <= 0; x++) upper += w2.amount(x, 0, z);
    expect(upper).toBe(0);
    expect(w2.total()).toBe(12);
  });
});

