import { describe, expect, it } from 'vitest';
import {
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  ROUND_WORLD_16x8KM,
  TerrainGenerator,
  NO_GROUND,
  TILE_SAMPLES,
  decodeChunk,
  decodeTile,
  defaultFlatGen,
  tileSizeUnits,
  tileStep,
  defaultNoiseTerrain,
} from '@super-vox/shared';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { EditError, voxelAt } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
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

  describe('tiles and column ranges', () => {
    const source = new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(1));
    const world = new World(FLAT_WORLD_16KM, new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, source));

    it('samples each tile cell at its centre column', () => {
      for (const level of [1, 3, 6]) {
        const t = { level, tx: Math.floor(128_000 / tileSizeUnits(level)), tz: Math.floor(128_000 / tileSizeUnits(level)) };
        const tile = decodeTile(world.getEncodedTile(t)!);
        const step = tileStep(level);
        for (const [i, j] of [[0, 0], [31, 31], [5, 20]] as const) {
          const x = t.tx * tileSizeUnits(level) + i * step + Math.floor(step / 2);
          const z = t.tz * tileSizeUnits(level) + j * step + Math.floor(step / 2);
          expect(tile.heights[i + TILE_SAMPLES * j]).toBe(source.heights(x, z, 1, 1)[0]);
        }
      }
    });

    it('marks samples beyond the world edge as having no ground', () => {
      const level = 4;
      const tx = Math.floor(FLAT_WORLD_16KM.widthUnits / tileSizeUnits(level)); // overhangs the east edge
      const tile = decodeTile(world.getEncodedTile({ level, tx, tz: 0 })!);
      const step = tileStep(level);
      for (let i = 0; i < TILE_SAMPLES; i++) {
        const x = tx * tileSizeUnits(level) + i * step + Math.floor(step / 2);
        expect(tile.heights[i] === NO_GROUND).toBe(x >= FLAT_WORLD_16KM.widthUnits);
      }
      expect(world.getEncodedTile({ level, tx: tx + 1, tz: 0 })).toBeNull();
    });

    it('reports exact column ranges and null outside the world', () => {
      const H = source.heights(590 * 256, 498 * 256, 256, 256);
      expect(world.columnRange(590, 498)).toEqual({ minY: Math.min(...H), maxY: Math.max(...H) });
      expect(world.columnRange(-1, 0)).toBeNull();
    });
  });

  describe('edits', () => {
    const dirs: string[] = [];
    const tmp = () => {
      const d = mkdtempSync(join(tmpdir(), 'super-vox-test-'));
      dirs.push(d);
      return d;
    };
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const flatWorld = (dir?: string) =>
      new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16)), dir ? { store: new FileChunkStore(dir) } : {});

    it('serves edited chunks instead of generated ones', () => {
      const world = flatWorld();
      // Ground top is y = 0, so the grass block at y -16..0 is in chunk cy = -1.
      const r = world.applyEdit({ op: 'remove', x: 100, y: -1, z: 200 });
      expect(r.coord).toEqual({ cx: 0, cy: -1, cz: 0 });
      const chunk = decodeChunk(world.getEncodedChunk({ cx: 0, cy: -1, cz: 0 })!);
      expect(voxelAt(chunk, 100, 255, 200)).toBeNull();
      expect(voxelAt(chunk, 100, 239, 200)).not.toBeNull();
      expect(decodeChunk(r.bytes)).toEqual(chunk);
    });

    it('rejects invalid edits and edits outside the world without changing anything', () => {
      const world = flatWorld();
      expect(() => world.applyEdit({ op: 'remove', x: 100, y: 50, z: 200 })).toThrow(EditError);
      expect(() => world.applyEdit({ op: 'remove', x: -5, y: -1, z: 200 })).toThrow(/outside/);
      expect(() => world.applyEdit({ op: 'place', x: 100, y: -1, z: 200, size: 1, material: 1 })).toThrow(/occupied/);
      expect(world.editedChunkCount).toBe(0);
    });

    it('saves edits and loads them back after a restart', () => {
      const dir = tmp();
      const a = flatWorld(dir);
      a.applyEdit({ op: 'place', x: 16, y: 0, z: 16, size: 5, material: 2 });
      a.applyEdit({ op: 'break', x: 32, y: -1, z: 32, pieceSize: 4 });
      expect(readdirSync(dir).sort()).toEqual(['0_-1_0.chunk', '0_0_0.chunk']);
      const b = flatWorld(dir);
      expect(b.editedChunkCount).toBe(2);
      for (const coord of [{ cx: 0, cy: 0, cz: 0 }, { cx: 0, cy: -1, cz: 0 }]) {
        expect(b.getEncodedChunk(coord)).toEqual(a.getEncodedChunk(coord));
      }
      expect(voxelAt(decodeChunk(b.getEncodedChunk({ cx: 0, cy: 0, cz: 0 })!), 16, 0, 16)).toEqual({ material: 2, size: 5 });
    });

    it('widens the column range when building above the ground, and reports it once', () => {
      const world = flatWorld();
      expect(world.columnRange(0, 0)).toEqual({ minY: 0, maxY: 0 });
      const r = world.applyEdit({ op: 'place', x: 0, y: 300, z: 0, size: 4, material: 1 });
      expect(r.coord.cy).toBe(1);
      expect(r.columnRange).toEqual({ minY: 0, maxY: 512 });
      expect(world.columnRange(0, 0)).toEqual({ minY: 0, maxY: 512 });
      expect(world.applyEdit({ op: 'place', x: 4, y: 300, z: 0, size: 4, material: 1 }).columnRange).toBeNull();
    });

    it('does not let edits leak between worlds sharing a generator', () => {
      const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16));
      const a = new World(FLAT_WORLD_16KM, gen), b = new World(FLAT_WORLD_16KM, gen);
      a.applyEdit({ op: 'remove', x: 100, y: -1, z: 200 });
      expect(voxelAt(decodeChunk(b.getEncodedChunk({ cx: 0, cy: -1, cz: 0 })!), 100, 255, 200)).not.toBeNull();
    });
  });
});
