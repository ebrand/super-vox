import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, PlateStageCache, ROUND_WORLD_16x8KM, defaultPlateTerrain, defaultVoxelize, encodeChunk, type ChunkCoord, type ColumnRange, type TerrainStroke } from '@super-vox/shared';
import { GenPool } from './genPool.js';
import { World, tileBytes, type RemoteGenerator } from './world.js';
import { generatorFor, type WorldSpec } from './worldFile.js';

const config = ROUND_WORLD_16x8KM;
const spec: WorldSpec = { generator: 'plates', plates: defaultPlateTerrain(9, config), voxelize: defaultVoxelize(), shape: 'round-16x8' };
const M = 16;

describe('GenPool', () => {
  const pools: GenPool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.close();
  });

  it('makes the same chunks, tiles and column ranges on its workers as the main thread does', async () => {
    // With some terraforming, which the workers must apply too.
    const strokes: TerrainStroke[] = [{ kind: 'raise', x: 7020, z: 3000, radius: 40, amount: 30, softness: 0.5 }, { kind: 'plant', x: 6990, z: 3010, radius: 30, amount: 1, softness: 0 }];
    const main = generatorFor(spec, config, strokes).generator;
    const pool = new GenPool(2);
    pools.push(pool);
    const remote = pool.remote('test', spec, config, strokes);
    let chunks = 0;
    for (let cz = 186; cz < 190; cz++) {
      for (let cx = 436; cx < 440; cx++) {
        const range = await remote.column(cx, cz);
        expect(range).toEqual(main.columnRange(cx, cz));
        for (let cy = Math.floor(range.minY / CHUNK_SIZE) - 1; cy <= Math.floor(range.maxY / CHUNK_SIZE) + 1; cy++, chunks++) {
          expect((await remote.chunk({ cx, cy, cz })).bytes).toEqual(encodeChunk(main.generateChunk({ cx, cy, cz })));
        }
      }
    }
    expect(chunks).toBeGreaterThan(30);
    for (const t of [{ level: 2, tx: 109, tz: 46 }, { level: 5, tx: 13, tz: 5 }]) {
      expect((await remote.tile(t)).bytes).toEqual(tileBytes(main, config, t));
    }
  });

  it("builds a plate world once: workers given the build's stages make the same terrain without building it again", async () => {
    const strokes: TerrainStroke[] = [{ kind: 'raise', x: 7020, z: 3000, radius: 40, amount: 30, softness: 0.5 }];
    const main = generatorFor(spec, config, strokes).generator;
    const cache = new PlateStageCache();
    generatorFor(spec, config, strokes, cache);
    const stages = cache.share();
    const pool = new GenPool(2), plain = new GenPool(2);
    pools.push(pool, plain);
    const shared = pool.remote('test', spec, config, strokes, stages), own = plain.remote('test', spec, config, strokes);
    // (Two columns: one on each worker.)
    const first = [{ cx: 436, cy: 0, cz: 186 }, { cx: 437, cy: 0, cz: 188 }];
    const sharedBuild = await Promise.all(first.map((c) => shared.chunk(c)));
    const ownBuild = await Promise.all(first.map((c) => own.chunk(c)));
    for (let k = 0; k < first.length; k++) {
      expect(sharedBuild[k]!.bytes).toEqual(encodeChunk(main.generateChunk(first[k]!)));
      expect(ownBuild[k]!.bytes).toEqual(sharedBuild[k]!.bytes);
      expect(sharedBuild[k]!.buildMs!).toBeLessThan(ownBuild[k]!.buildMs! / 4);
    }
    for (let cz = 186; cz < 189; cz++) {
      for (let cx = 436; cx < 439; cx++) {
        const range = await shared.column(cx, cz);
        expect(range).toEqual(main.columnRange(cx, cz));
        for (let cy = Math.floor(range.minY / CHUNK_SIZE) - 1; cy <= Math.floor(range.maxY / CHUNK_SIZE) + 1; cy++) {
          expect((await shared.chunk({ cx, cy, cz })).bytes).toEqual(encodeChunk(main.generateChunk({ cx, cy, cz })));
        }
      }
    }
    for (const t of [{ level: 2, tx: 109, tz: 46 }, { level: 5, tx: 13, tz: 5 }]) expect((await shared.tile(t)).bytes).toEqual(tileBytes(main, config, t));
  });

  it('works on many requests at once, across its workers', async () => {
    const main = generatorFor(spec, config).generator;
    const pool = new GenPool(4);
    pools.push(pool);
    const remote = pool.remote('test', spec, config, []);
    const coords: ChunkCoord[] = [];
    for (let i = 0; i < 24; i++) coords.push({ cx: 300 + i * 7, cy: 0, cz: 120 + (i % 5) * 3 });
    const made = await Promise.all(coords.map((c) => remote.chunk(c)));
    made.forEach((m, i) => expect(m.bytes).toEqual(encodeChunk(main.generateChunk(coords[i]!))));
  });

  it('stops its threads when its last world is forgotten, and starts them again for the next', async () => {
    const pool = new GenPool(2);
    pools.push(pool);
    const main = generatorFor(spec, config).generator, c: ChunkCoord = { cx: 437, cy: 0, cz: 187 };
    const a = pool.remote('a', spec, config, []), b = pool.remote('b', spec, config, []);
    expect(pool.running).toBe(true);
    // One of two forgotten: still running, the other still served.
    a.forget();
    expect(pool.running).toBe(true);
    expect(Buffer.from((await b.chunk(c)).bytes)).toEqual(Buffer.from(encodeChunk(main.generateChunk(c))));
    // The last: stopped.
    b.forget();
    expect(pool.running).toBe(false);
    await expect(b.chunk(c)).rejects.toThrow(/no world/);
    // A world again: running again, and serving.
    const again = pool.remote('a', spec, config, []);
    expect(pool.running).toBe(true);
    expect(Buffer.from((await again.chunk(c)).bytes)).toEqual(Buffer.from(encodeChunk(main.generateChunk(c))));
  });

  it("fails the requests for a world it's forgotten, rather than hanging", async () => {
    const pool = new GenPool(1);
    pools.push(pool);
    const remote = pool.remote('test', spec, config, []);
    remote.forget();
    await expect(remote.chunk({ cx: 1, cy: 0, cz: 1 })).rejects.toThrow(/no world/);
  });
});

describe('World with a remote generator', () => {
  it("lets an edit that lands while a chunk is being made win", async () => {
    const main = generatorFor(spec, config).generator;
    // A remote that answers only when told.
    let finish: (() => void) | null = null;
    const remote: RemoteGenerator = {
      chunk: (c) => new Promise((resolve) => (finish = () => resolve({ bytes: encodeChunk(main.generateChunk(c)), ms: 1 }))),
      tile: () => Promise.reject(new Error('no tiles here')),
      column: (cx, cz) => Promise.resolve(main.columnRange(cx, cz) as ColumnRange),
    };
    const world = new World(config, main, { tolerance: 4, remote });
    // A column with ground in it, and the chunk holding its surface.
    const cx = 437, cz = 187, range = main.columnRange(cx, cz);
    const y = range.minY - 8, cy = Math.floor(y / CHUNK_SIZE);
    const coming = world.encodedChunk({ cx, cy, cz });
    expect(coming).toBeInstanceOf(Promise);
    // Meanwhile: a voxel dug out of it, just under the lowest ground.
    world.applyEdit({ op: 'remove', x: cx * CHUNK_SIZE + 8 * M, y, z: cz * CHUNK_SIZE + 8 * M });
    const edited = world.getEncodedChunk({ cx, cy, cz });
    finish!();
    expect(await coming).toEqual(edited);
    expect(edited).not.toEqual(encodeChunk(main.generateChunk({ cx, cy, cz })));
    // And what's cached is still the edited chunk.
    expect(world.encodedChunk({ cx, cy, cz })).toEqual(edited);
  });
});
