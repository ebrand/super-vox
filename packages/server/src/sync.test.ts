import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUPS_KEPT, Backups, packFolder, packedFiles, parseSyncTargets, syncId, unpackFolder } from './sync.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sync-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pack made by hand: entries of [path, bytes], ended (or not). */
function pack(entries: [string, Buffer][], ended = true): Readable {
  const parts: Buffer[] = [Buffer.from('SVW1')];
  for (const [path, bytes] of entries) {
    const p = Buffer.from(path), head = Buffer.alloc(6 + p.length);
    head.writeUInt16BE(p.length, 0);
    p.copy(head, 2);
    head.writeUInt32BE(bytes.length, 2 + p.length);
    parts.push(head, bytes);
  }
  if (ended) parts.push(Buffer.from([0, 0]));
  return Readable.from([gzipSync(Buffer.concat(parts))]);
}

describe('packing a world folder', () => {
  it('packs every file but generated terrain and builds, and unpacks it as it was', async () => {
    const src = temp();
    mkdirSync(join(src, 'chunks'), { recursive: true });
    mkdirSync(join(src, 'cache', 'v1'), { recursive: true });
    mkdirSync(join(src, 'build'), { recursive: true });
    writeFileSync(join(src, 'world.json'), '{"version":1}');
    writeFileSync(join(src, 'chunks', '1_2_3.chunk'), Buffer.alloc(300_000, 7));
    writeFileSync(join(src, 'chunks', 'villages.json'), '{}');
    writeFileSync(join(src, 'picture.png'), Buffer.from([1, 2, 3]));
    writeFileSync(join(src, 'cache', 'v1', 'x.bin'), 'cached');
    writeFileSync(join(src, 'build', 'k.v8.gz'), 'built');
    writeFileSync(join(src, 'chunks', '.half.tmp'), 'half-written');
    expect(packedFiles(src)).toEqual(['chunks/1_2_3.chunk', 'chunks/villages.json', 'picture.png', 'world.json']);
    const dest = join(temp(), 'w');
    expect(await unpackFolder(packFolder(src), dest)).toEqual({ files: 4, bytes: 300_000 + 2 + 3 + 13 });
    expect(readFileSync(join(dest, 'chunks', '1_2_3.chunk'))).toEqual(Buffer.alloc(300_000, 7));
    expect(readFileSync(join(dest, 'world.json'), 'utf8')).toBe('{"version":1}');
    expect(existsSync(join(dest, 'cache'))).toBe(false);
    expect(existsSync(join(dest, 'build'))).toBe(false);
  });

  it('refuses a pack with a path out of its folder, twice the same file, or cut short', async () => {
    const one = Buffer.from('x');
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'cache/x', '.hidden', 'a//b', 'a\\b']) {
      await expect(unpackFolder(pack([[bad, one]]), join(temp(), 'w')), bad).rejects.toThrow(/bad path/);
    }
    await expect(unpackFolder(pack([['a', one], ['a', one]]), join(temp(), 'w'))).rejects.toThrow(/twice/);
    await expect(unpackFolder(pack([['a', one]], false), join(temp(), 'w'))).rejects.toThrow(/cut short/);
    await expect(unpackFolder(Readable.from([gzipSync(Buffer.from('nope'))]), join(temp(), 'w'))).rejects.toThrow(/isn't a packed world/);
    await expect(unpackFolder(Readable.from([Buffer.from('not gzip')]), join(temp(), 'w'))).rejects.toThrow();
  });
});

describe('sync settings and backups', () => {
  it('reads SYNC_TARGETS, leaving out this environment', () => {
    const raw = 'production=https://voxel.example.com, staging=https://staging.example.com/';
    expect(parseSyncTargets(raw, 'staging')).toEqual([{ name: 'production', url: 'https://voxel.example.com' }]);
    expect(parseSyncTargets(raw, 'development')).toHaveLength(2);
    expect(parseSyncTargets(undefined, 'x')).toEqual([]);
    expect(() => parseSyncTargets('prod', 'x')).toThrow(/name=url/);
    expect(() => parseSyncTargets('prod=ftp://x', 'x')).toThrow(/address/);
    expect(() => parseSyncTargets('prod=https://x/path', 'x')).toThrow(/address/);
  });

  it(`keeps a sync's backup in its own folder, the newest ${BACKUPS_KEPT}`, () => {
    const root = temp(), b = new Backups(root);
    expect(syncId(new Date('2026-10-11T12:34:56.789Z'))).toBe('20261011T123456Z');
    const first = b.folder('20261011T120000Z', 'staging');
    b.keep(first, 'designs', [{ id: 'a' }]);
    // (Kept once: what was there before the sync, not what a second part of it left.)
    b.keep(first, 'designs', [{ id: 'b' }]);
    expect(JSON.parse(readFileSync(join(first, 'designs.json'), 'utf8'))).toEqual([{ id: 'a' }]);
    for (let i = 1; i <= BACKUPS_KEPT + 2; i++) b.folder(`20261011T12000${i}Z`, 'staging');
    expect(readdirSync(root)).toHaveLength(BACKUPS_KEPT);
    expect(b.list().at(-1)).toBe(`20261011T12000${BACKUPS_KEPT + 2}Z-from-staging`);
    expect(() => b.folder('../x', 'staging')).toThrow(/id/);
  });
});
