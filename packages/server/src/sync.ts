import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Synchronizing environments (staging to production, say: see the Synchronize page): one server
 * sends another what an admin picked (objects, the meshes, the animations, worlds), and the other
 * takes it in, keeping what it had in a backup first. They trust each other by a secret they share
 * (SYNC_SECRET); each knows the others by name and address (SYNC_TARGETS).
 *
 * A world goes as its folder (see worldFile.ts), packed (see packFolder): all of it but what's made
 * again from it (its generated terrain, cache/, and its plate build, build/).
 */

/** Another environment this one may send to. */
export interface SyncTarget {
  name: string;
  url: string;
}

/**
 * SYNC_TARGETS: `name=url` pairs, comma-separated ("production=https://voxel.example.com,staging=https://..."),
 * this environment's own name left out (so every environment can be given the same list).
 */
export function parseSyncTargets(raw: string | undefined, self: string): SyncTarget[] {
  if (!raw) return [];
  const out: SyncTarget[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    if (at < 1) throw new RangeError(`SYNC_TARGETS: "${part}" isn't name=url`);
    const name = part.slice(0, at).trim(), url = part.slice(at + 1).trim().replace(/\/+$/, '');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new RangeError(`SYNC_TARGETS: "${name}" isn't a name (lowercase letters, digits, -)`);
    if (!/^https?:\/\/[^/\s]+$/.test(url)) throw new RangeError(`SYNC_TARGETS: "${url}" isn't an address (http(s)://host, no path)`);
    if (name !== self) out.push({ name, url });
  }
  return out;
}

/** What a world's folder holds that isn't sent: made again from the rest. */
const NOT_SENT = new Set(['cache', 'build']);
/** A packed file's path: folders and names of letters, digits, '.', '_' and '-', not starting with '.'. */
const PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAGIC = Buffer.from('SVW1');
/** The most a packed world may hold, unpacked (bytes), and in files. */
export const PACK_MAX_BYTES = 4 * 1024 ** 3;
export const PACK_MAX_FILES = 500_000;
const FILE_MAX_BYTES = 256 * 1024 ** 2;

/** The files of a folder to pack (relative paths), but those in NOT_SENT folders at its top. */
export function packedFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && NOT_SENT.has(e.name)) continue;
      if (!PATH.test(path)) continue; // (Temporary files, ".tmp" ones and the like.)
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/**
 * A folder packed, gzipped: "SVW1", then each file as its path's length (2 bytes), its path, its
 * size (4 bytes) and its bytes; then a path length of 0.
 */
export function packFolder(dir: string): Readable {
  const files = packedFiles(dir);
  async function* entries(): AsyncGenerator<Buffer> {
    yield MAGIC;
    for (const path of files) {
      const full = join(dir, path), size = statSync(full).size;
      if (size > FILE_MAX_BYTES) throw new RangeError(`${path} is too big to send (${size} bytes)`);
      const p = Buffer.from(path), head = Buffer.alloc(6 + p.length);
      head.writeUInt16BE(p.length, 0);
      p.copy(head, 2);
      head.writeUInt32BE(size, 2 + p.length);
      yield head;
      let sent = 0;
      for await (const chunk of createReadStream(full)) {
        sent += (chunk as Buffer).length;
        if (sent > size) throw new Error(`${path} grew while it was being sent`);
        yield chunk as Buffer;
      }
      if (sent !== size) throw new Error(`${path} shrank while it was being sent`);
    }
    yield Buffer.from([0, 0]);
  }
  return Readable.from(entries()).pipe(createGzip({ level: 6 }));
}

/**
 * Unpacks what packFolder made into folder `dest` (made; it should be new and empty). Throws, having
 * written what it had, if it's not a good pack (a bad path, too big, cut short): the caller then
 * throws `dest` away. How many files and bytes it held.
 */
export async function unpackFolder(gzipped: Readable, dest: string): Promise<{ files: number; bytes: number }> {
  mkdirSync(dest, { recursive: true });
  let buf: Buffer = Buffer.alloc(0), magic = false, done = false, files = 0, bytes = 0;
  /** The file being read: its path, size, and its bytes so far. */
  let file: { path: string; size: number; parts: Buffer[]; got: number } | null = null;
  const seen = new Set<string>();
  for await (const chunk of gzipped.pipe(createGunzip())) {
    if (done) throw new Error('more after the end of the pack');
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    for (;;) {
      if (!magic) {
        if (buf.length < MAGIC.length) break;
        if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("that isn't a packed world");
        buf = buf.subarray(MAGIC.length);
        magic = true;
        continue;
      }
      if (file) {
        const take = Math.min(file.size - file.got, buf.length);
        if (take > 0) {
          file.parts.push(Buffer.from(buf.subarray(0, take)));
          file.got += take;
          buf = buf.subarray(take);
        }
        if (file.got < file.size) break;
        const full = join(dest, file.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, Buffer.concat(file.parts));
        file = null;
        continue;
      }
      if (buf.length < 2) break;
      const n = buf.readUInt16BE(0);
      if (n === 0) {
        done = true;
        buf = buf.subarray(2);
        if (buf.length) throw new Error('more after the end of the pack');
        break;
      }
      if (buf.length < 2 + n + 4) break;
      const path = buf.subarray(2, 2 + n).toString('utf8'), size = buf.readUInt32BE(2 + n);
      if (!PATH.test(path) || path.split('/').some((s) => s === '.' || s === '..') || NOT_SENT.has(path.split('/')[0]!)) throw new Error(`a file in the pack has a bad path: ${JSON.stringify(path)}`);
      if (seen.has(path)) throw new Error(`${path} is in the pack twice`);
      if (size > FILE_MAX_BYTES) throw new Error(`${path} is too big (${size} bytes)`);
      seen.add(path);
      files++;
      bytes += size;
      if (files > PACK_MAX_FILES || bytes > PACK_MAX_BYTES) throw new Error('the pack is too big');
      buf = buf.subarray(2 + n + 4);
      file = { path, size, parts: [], got: 0 };
    }
  }
  if (!done) throw new Error('the pack was cut short');
  return { files, bytes };
}

/** How many backups (see Backups) are kept: the oldest go past this. */
export const BACKUPS_KEPT = 5;

/**
 * Where what a sync replaced goes (`root`/<when>-from-<source>/: the libraries as they were, as
 * designs.json, meshes.json and animations.json; worlds, as their folders in worlds/). The newest
 * BACKUPS_KEPT are kept.
 */
export class Backups {
  constructor(private readonly root: string) {}

  /** The folder for a sync's backup (`id`: the sync's, from its source; made if new). */
  folder(id: string, source: string): string {
    if (!/^[0-9]{8}T[0-9]{6}Z$/.test(id)) throw new RangeError(`a sync's id must be its time (YYYYMMDDTHHMMSSZ), not "${id}"`);
    const dir = join(this.root, `${id}-from-${source.replace(/[^a-z0-9-]/g, '') || 'unknown'}`);
    const made = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    if (made) this.prune();
    return dir;
  }

  /** A library as it was, kept: `name`.json in the sync's backup. */
  keep(dir: string, name: 'designs' | 'meshes' | 'animations', content: unknown): void {
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(content));
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }

  private prune(): void {
    const all = this.list();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmSync(join(this.root, old), { recursive: true, force: true });
  }
}

/** A sync's id: when it started (UTC, to the second). */
export function syncId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
