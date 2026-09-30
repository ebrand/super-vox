import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, ROUND_WORLD_16x8KM, decodeChunk, defaultFlatGen } from '@super-vox/shared';
import { World } from './world.js';

describe('World', () => {
  it('rejects invalid generation settings', () => {
    expect(() => new World(FLAT_WORLD_16KM, defaultFlatGen(3))).toThrow(RangeError);
  });

  it('rejects world sizes that are not whole chunks', () => {
    expect(() => new World({ ...FLAT_WORLD_16KM, widthUnits: 1000 }, defaultFlatGen(16))).toThrow(/multiples/);
  });

  it('returns null outside the world and does not cache it', () => {
    const world = new World(FLAT_WORLD_16KM, defaultFlatGen(16));
    expect(world.getEncodedChunk({ cx: -1, cy: 0, cz: 0 })).toBeNull();
    expect(world.cachedChunkCount).toBe(0);
  });

  it('serves cached bytes on repeat requests', () => {
    const world = new World(FLAT_WORLD_16KM, defaultFlatGen(16));
    const a = world.getEncodedChunk({ cx: 1, cy: -1, cz: 1 });
    expect(world.getEncodedChunk({ cx: 1, cy: -1, cz: 1 })).toBe(a);
    expect(world.cachedChunkCount).toBe(1);
  });

  it('evicts the least recently used chunk', () => {
    const world = new World(FLAT_WORLD_16KM, defaultFlatGen(16), 2);
    const a = world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 });
    world.getEncodedChunk({ cx: 1, cy: -1, cz: 0 });
    world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 }); // touch A
    world.getEncodedChunk({ cx: 2, cy: -1, cz: 0 }); // evicts B
    expect(world.cachedChunkCount).toBe(2);
    expect(world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 })).toBe(a);
  });

  it('normalizes wrapped X so both sides of the seam share a cache entry', () => {
    const world = new World(ROUND_WORLD_16x8KM, defaultFlatGen(16));
    const n = ROUND_WORLD_16x8KM.widthUnits / 256;
    const a = world.getEncodedChunk({ cx: -1, cy: -1, cz: 0 })!;
    expect(world.getEncodedChunk({ cx: n - 1, cy: -1, cz: 0 })).toBe(a);
    expect(decodeChunk(a).cx).toBe(n - 1);
  });
});
