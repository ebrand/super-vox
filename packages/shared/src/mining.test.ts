import { describe, expect, it } from 'vitest';
import { Item } from './items.js';
import { Material } from './materials.js';
import { MINING_LATENCY_MS, boxMiningTime, hardnessOf, minedLongEnough, voxelMiningTime } from './mining.js';
import { decodeClientMessage } from './protocol.js';

describe('mining time', () => {
  it('takes a block of each material its hardness, smaller voxels by their edge', () => {
    // (Stone with the pickaxe it needs: its hardness, as a wooden one is twice as fast.)
    expect(voxelMiningTime(Material.Stone, 16, Item.WoodenPickaxe)).toBe(1.5);
    expect(voxelMiningTime(Material.Stone, 1, Item.WoodenPickaxe)).toBeCloseTo(1.5 / 16, 9);
    expect(voxelMiningTime(Material.Dirt, 8)).toBeCloseTo(0.375, 9);
    expect(hardnessOf(Material.Leaves)).toBeLessThan(hardnessOf(Material.Dirt));
    expect(hardnessOf(Material.Dirt)).toBeLessThan(hardnessOf(Material.Stone));
    expect(hardnessOf(Material.Water)).toBe(0);
  });

  it('takes a box as long as what is in it', () => {
    // A 1 m box full of stone: as one 1 m voxel of it.
    expect(boxMiningTime([{ material: Material.Stone, volumeInside: 16 ** 3 }], 16, Item.WoodenPickaxe)).toBeCloseTo(1.5, 9);
    // Half stone, half dirt (by hand: the stone three times as long, needing a pickaxe).
    expect(boxMiningTime([{ material: Material.Stone, volumeInside: 8 * 16 * 16 }, { material: Material.Dirt, volumeInside: 8 * 16 * 16 }], 16)).toBeCloseTo((9 + 0.75) / 2, 9);
    // Empty: at once.
    expect(boxMiningTime([], 16)).toBe(0);
  });

  it('lets a removal through once mined long enough, allowing for message delays', () => {
    expect(minedLongEnough(null, 5000, 1)).toBe(false);
    expect(minedLongEnough(null, 5000, 0)).toBe(true);
    expect(minedLongEnough(1000, 1000 + 2000, 2)).toBe(true);
    expect(minedLongEnough(1000, 1000 + 1600 - MINING_LATENCY_MS, 2)).toBe(true);
    expect(minedLongEnough(1000, 1000 + 1000, 2)).toBe(false);
  });

  it('reads mine messages', () => {
    expect(decodeClientMessage(JSON.stringify({ type: 'mine', x: 1, y: -2, z: 3 }))).toEqual({ type: 'mine', x: 1, y: -2, z: 3 });
    expect(decodeClientMessage(JSON.stringify({ type: 'mine', x: 1.5, y: 0, z: 0 }))).toBeNull();
  });
});
