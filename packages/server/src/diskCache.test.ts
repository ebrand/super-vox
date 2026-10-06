import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, ROUND_WORLD_16x8KM, defaultPlateTerrain, defaultVoxelize, encodeChunk, type ChunkGenerator } from '@super-vox/shared';
import { DiskCache, parseRecords } from './diskCache.js';
import { World } from './world.js';
import { createWorld, generatorFor, type WorldSpec } from './worldFile.js';
import { FileWorldCatalog, terrainVersion } from './worlds.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'super-vox-cache-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = ROUND_WORLD_16x8KM;
const spec: WorldSpec = { generator: 'plates', plates: defaultPlateTerrain(9, config), voxelize: defaultVoxelize(), shape: 'round-16x8' };

describe('DiskCache', () => {
  it('keeps chunks, tiles and column ranges on disk, for another cache (a restart) to read', async () => {
    const dir = join(tmp(), 'v1');
    const a = new DiskCache(dir);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 251);
    expect(await a.chunk(3, -1, 4)).toBeNull();
    a.putChunk(3, -1, 4, bytes);
    a.putTile(2, 10, 11, bytes.subarray(0, 100));
    a.putColumn(3, 4, { minY: -5, maxY: 9 });
    a.putChunk(40, 0, 40, bytes.subarray(10, 20)); // another region
    await a.flush();
    expect(await a.chunk(3, -1, 4)).toEqual(bytes);
    // Compressed: these bytes repeat.
    const files = readdirSync(dir);
    expect(files.length).toBe(3);
    const b = new DiskCache(dir);
    expect(await b.chunk(3, -1, 4)).toEqual(bytes);
    expect(await b.tile(2, 10, 11)).toEqual(bytes.subarray(0, 100));
    expect(await b.column(3, 4)).toEqual({ minY: -5, maxY: 9 });
    expect(await b.chunk(40, 0, 40)).toEqual(bytes.subarray(10, 20));
    expect(await b.chunk(3, 0, 4)).toBeNull();
    expect(b.stats).toMatchObject({ hits: 4, misses: 1 });
  });

  it('makes its folder again if it is taken away between writes', async () => {
    const dir = join(tmp(), 'cache');
    const cache = new DiskCache(dir);
    cache.putChunk(1, 0, 1, new Uint8Array([1, 2, 3]));
    await cache.flush();
    rmSync(dir, { recursive: true, force: true });
    cache.putChunk(2, 0, 2, new Uint8Array([4, 5]));
    await cache.flush();
    cache.putChunk(3, 0, 3, new Uint8Array([6]));
    await cache.flush();
    // (The write right after it went missing fails; the next makes it again.)
    expect(existsSync(dir)).toBe(true);
    expect(await new DiskCache(dir).chunk(3, 0, 3)).toEqual(new Uint8Array([6]));
    expect(cache.stats.errors).toBe(1);
  });

  it('keeps at most so many bytes in memory, reading regions it let go of from disk again', async () => {
    const dir = join(tmp(), 'cache');
    // 20 regions' worth of chunks (a region is 16 x 16 columns), about 2 kB each, kept to 10 kB.
    const cache = new DiskCache(dir, 4096, 10_000);
    // (Random-looking, so they don't compress below the 2 kB.)
    const bytes = (i: number) => {
      let r = i * 2654435761 + 1;
      return Uint8Array.from({ length: 2000 }, () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) >>> 16) & 255);
    };
    for (let i = 0; i < 20; i++) {
      cache.putChunk(i * 16, 0, 0, bytes(i));
      await cache.flush();
      expect(cache.bytesHeld).toBeLessThanOrEqual(10_000 + 4000); // (the region in use, besides)
    }
    // All of it there still: from memory, or read again.
    for (let i = 0; i < 20; i++) expect(await cache.chunk(i * 16, 0, 0)).toEqual(bytes(i));
    expect(cache.bytesHeld).toBeLessThanOrEqual(10_000 + 4000);
    // Without the cap, the same holds them all.
    const all = new DiskCache(dir);
    for (let i = 0; i < 20; i++) await all.chunk(i * 16, 0, 0);
    expect(all.bytesHeld).toBeGreaterThan(20 * 1900);
  });

  it('ignores a record cut short (a crash while writing), keeping those before it', async () => {
    const dir = join(tmp(), 'v1');
    const a = new DiskCache(dir);
    a.putChunk(1, 0, 1, new Uint8Array([1, 2, 3]));
    a.putChunk(2, 0, 1, new Uint8Array([4, 5, 6]));
    await a.flush();
    const file = join(dir, readdirSync(dir)[0]!);
    const whole = readFileSync(file);
    writeFileSync(file, whole.subarray(0, whole.length - 2));
    expect(parseRecords(readFileSync(file)).length).toBe(1);
    const b = new DiskCache(dir);
    expect(await b.chunk(1, 0, 1)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await b.chunk(2, 0, 1)).toBeNull();
    // Garbage after a good record, too.
    appendFileSync(file, Buffer.from([9, 9, 9]));
    expect(await new DiskCache(dir).chunk(1, 0, 1)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads regions back after letting them go from memory', async () => {
    const dir = join(tmp(), 'v1');
    const a = new DiskCache(dir, 2);
    for (let r = 0; r < 5; r++) a.putChunk(r * 16, 0, 0, new Uint8Array([r]));
    await a.flush();
    for (let r = 0; r < 5; r++) expect(await a.chunk(r * 16, 0, 0)).toEqual(new Uint8Array([r]));
  });
});

describe('a world with a disk cache', () => {
  it('serves what it made before from disk, without making it again; edits still win', async () => {
    const dir = join(tmp(), 'v1');
    const gen = generatorFor(spec, config).generator;
    let made = 0, ranged = 0;
    const counting = (g: ChunkGenerator): ChunkGenerator =>
      Object.assign(Object.create(g) as ChunkGenerator, {
        generateChunk: (c: Parameters<ChunkGenerator['generateChunk']>[0]) => (made++, g.generateChunk(c)),
        columnRange: (cx: number, cz: number) => (ranged++, g.columnRange(cx, cz)),
      });
    const cx = 437, cz = 187;
    const first = new World(config, counting(gen), { tolerance: 4, disk: new DiskCache(dir) });
    made = ranged = 0;
    const range = await first.columnRangeOf(cx, cz);
    const cys: number[] = [];
    for (let cy = Math.floor(range!.minY / CHUNK_SIZE) - 1; cy <= Math.floor(range!.maxY / CHUNK_SIZE) + 1; cy++) cys.push(cy);
    const bytes = await Promise.all(cys.map((cy) => first.encodedChunk({ cx, cy, cz })));
    expect(made).toBe(cys.length);
    expect(ranged).toBe(1);
    await first.disk!.flush();
    // A restart: the same terrain from disk.
    const second = new World(config, counting(gen), { tolerance: 4, disk: new DiskCache(dir) });
    made = ranged = 0;
    expect(await second.columnRangeOf(cx, cz)).toEqual(range);
    for (const [i, cy] of cys.entries()) expect(await second.encodedChunk({ cx, cy, cz })).toEqual(bytes[i]);
    expect(made).toBe(0);
    expect(ranged).toBe(0);
    expect(bytes[1]).toEqual(encodeChunk(gen.generateChunk({ cx, cy: cys[1]!, cz })));
    // An edit there: the edited chunk, not the cached one.
    const third = new World(config, gen, { tolerance: 4, disk: new DiskCache(dir) });
    const y = range!.minY - 8, cy = Math.floor(y / CHUNK_SIZE);
    third.applyEdit({ op: 'remove', x: cx * CHUNK_SIZE + 128, y, z: cz * CHUNK_SIZE + 128 });
    expect(await third.encodedChunk({ cx, cy, cz })).not.toEqual(bytes[cys.indexOf(cy)]);
  });

  it('takes a new version of the terrain for new strokes or settings', () => {
    const gen = generatorFor(spec, config).generator;
    const v = terrainVersion(spec, [], gen, config);
    expect(terrainVersion(spec, [], gen, config)).toBe(v);
    const stroke = { kind: 'raise' as const, x: 7000, z: 3000, radius: 30, amount: 10, softness: 0.5 };
    expect(terrainVersion(spec, [stroke], generatorFor(spec, config, [stroke]).generator, config)).not.toBe(v);
    const other: WorldSpec = { ...spec, plates: { ...spec.plates, seed: 10 } };
    expect(terrainVersion(other, [], generatorFor(other, config).generator, config)).not.toBe(v);
  });

  it('starts a new cache when a world is terraformed, and drops the old one', async () => {
    const root = tmp();
    createWorld(root, 'isle', spec);
    const catalog = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    const w = catalog.get('isle')!;
    await w.columnRangeOf(437, 187);
    await w.disk!.flush();
    const before = readdirSync(join(root, 'isle', 'cache'));
    expect(before.length).toBe(1);
    catalog.terraform!('isle', 0, [{ kind: 'raise', x: 7000, z: 3000, radius: 30, amount: 10, softness: 0.5 }]);
    const after = catalog.get('isle')!;
    await after.columnRangeOf(437, 187);
    await after.disk!.flush();
    await new Promise((r) => setTimeout(r, 200)); // (the old one goes in the background)
    const now = readdirSync(join(root, 'isle', 'cache'));
    expect(now.length).toBe(1);
    expect(now[0]).not.toBe(before[0]);
    expect(existsSync(join(root, 'isle', 'cache', before[0]!))).toBe(false);
  });
});
