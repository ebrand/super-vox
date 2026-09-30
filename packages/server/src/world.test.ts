import { describe, expect, it } from 'vitest';
import {
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  ROUND_WORLD_16x8KM,
  TerrainGenerator,
  decodeChunk,
  defaultFlatGen,
  defaultNoiseTerrain,
} from '@super-vox/shared';
import { World, findSpawn } from './world.js';

describe('World', () => {
  const flat = (world = FLAT_WORLD_16KM) => new FlatGenerator(world, defaultFlatGen(16));

  it('spawns at the centre of a flat world (ties go to the centre)', () => {
    expect(new World(FLAT_WORLD_16KM, flat()).spawn).toEqual({ x: 128_000, y: 0, z: 128_000 });
  });

  it('rejects world sizes that are not whole chunks', () => {
    expect(() => new World({ ...FLAT_WORLD_16KM, widthUnits: 1000 }, flat())).toThrow(/multiples/);
  });

  it('returns null outside the world and does not cache it', () => {
    const world = new World(FLAT_WORLD_16KM, flat());
    expect(world.getEncodedChunk({ cx: -1, cy: 0, cz: 0 })).toBeNull();
    expect(world.cachedChunkCount).toBe(0);
  });

  it('serves cached bytes on repeat requests', () => {
    const world = new World(FLAT_WORLD_16KM, flat());
    const a = world.getEncodedChunk({ cx: 1, cy: -1, cz: 1 });
    expect(world.getEncodedChunk({ cx: 1, cy: -1, cz: 1 })).toBe(a);
    expect(world.cachedChunkCount).toBe(1);
  });

  it('evicts the least recently used chunk', () => {
    const world = new World(FLAT_WORLD_16KM, flat(), { cacheSize: 2 });
    const a = world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 });
    world.getEncodedChunk({ cx: 1, cy: -1, cz: 0 });
    world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 }); // touch A
    world.getEncodedChunk({ cx: 2, cy: -1, cz: 0 }); // evicts B
    expect(world.cachedChunkCount).toBe(2);
    expect(world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 })).toBe(a);
  });

  it('normalizes wrapped X so both sides of the seam share a cache entry', () => {
    const world = new World(ROUND_WORLD_16x8KM, flat(ROUND_WORLD_16x8KM));
    const n = ROUND_WORLD_16x8KM.widthUnits / 256;
    const a = world.getEncodedChunk({ cx: -1, cy: -1, cz: 0 })!;
    expect(world.getEncodedChunk({ cx: n - 1, cy: -1, cz: 0 })).toBe(a);
    expect(decodeChunk(a).cx).toBe(n - 1);
  });

  it('serves adaptive terrain chunks exactly as generated, and spawns on its surface', () => {
    const make = () =>
      new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 2 }, new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(5)));
    const world = new World(FLAT_WORLD_16KM, make());
    const reference = make();
    expect(world.spawn).toEqual(findSpawn(FLAT_WORLD_16KM, reference));
    expect(world.spawn.y).toBe(reference.surfaceHeightAt(world.spawn.x, world.spawn.z));
    for (let cx = 495; cx < 505; cx++) {
      for (const cy of [-1, 0, 1]) {
        const coord = { cx, cy, cz: 500 };
        expect(decodeChunk(world.getEncodedChunk(coord)!)).toEqual(reference.generateChunk(coord));
      }
    }
  });

  it('spawns on the highest ground near the centre of hilly terrain', () => {
    const source = new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(1));
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, source);
    const spawn = findSpawn(FLAT_WORLD_16KM, gen);
    // On the surface, in the hills, within the 2 km search radius.
    expect(spawn.y).toBe(gen.surfaceHeightAt(spawn.x, spawn.z));
    expect(spawn.y).toBeGreaterThan(10 * 16);
    expect(Math.hypot(spawn.x - 128_000, spawn.z - 128_000)).toBeLessThanOrEqual(2000 * 16);
    // Nothing on the search grid (every 32 m from the centre) is higher.
    for (let j = -62; j <= 62; j++) {
      for (let i = -62; i <= 62; i++) {
        if (i * i + j * j > 62 * 62) continue;
        expect(gen.surfaceHeightAt(128_000 + i * 512, 128_000 + j * 512)).toBeLessThanOrEqual(spawn.y);
      }
    }
    // Deterministic.
    expect(findSpawn(FLAT_WORLD_16KM, gen)).toEqual(spawn);
  });
});
