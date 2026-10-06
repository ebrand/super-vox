import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';

// (Compressing and decompressing in zlib's background threads, not the main thread: a busy server
// writes a cache record for every chunk it makes.)
const deflateRawAsync = promisify(deflateRaw), inflateRawAsync = promisify(inflateRaw);

/**
 * Generated terrain kept on disk (a world's chunks, tiles and column ranges as it generates them;
 * never edits), so revisiting a place, or a server restart, costs a read instead of generating it
 * again. Everything in it belongs to one version of the terrain (see terrainVersion): a different
 * version is a different folder.
 *
 * Kept compressed in region files (chunk columns REGION x REGION; tiles likewise by tile), each
 * a log of records appended as things are made, read whole the first time the region is asked
 * about and then kept in memory (the `keep` regions used most recently). A torn last record (a
 * crash while writing) is ignored.
 */
export class DiskCache {
  private readonly regions = new Map<string, Region>();
  /** Bytes kept in memory, and how many reads and writes there have been. */
  readonly stats = { hits: 0, misses: 0, writes: 0, errors: 0 };

  constructor(
    readonly dir: string,
    private readonly keep = 4096,
  ) {}

  /** An encoded chunk, or null if it isn't here. */
  chunk(cx: number, cy: number, cz: number): Promise<Uint8Array | null> {
    return this.get(`c${rk(cx)},${rk(cz)}`, `${cx},${cy},${cz}`);
  }

  putChunk(cx: number, cy: number, cz: number, bytes: Uint8Array): void {
    this.put(`c${rk(cx)},${rk(cz)}`, `${cx},${cy},${cz}`, bytes);
  }

  tile(level: number, tx: number, tz: number): Promise<Uint8Array | null> {
    return this.get(`t${level},${rk(tx)},${rk(tz)}`, `${level},${tx},${tz}`);
  }

  putTile(level: number, tx: number, tz: number, bytes: Uint8Array): void {
    this.put(`t${level},${rk(tx)},${rk(tz)}`, `${level},${tx},${tz}`, bytes);
  }

  /** A column's range (as generated, before edits), or null if it isn't here. */
  async column<T>(cx: number, cz: number): Promise<T | null> {
    const bytes = await this.get(`c${rk(cx)},${rk(cz)}`, `k${cx},${cz}`);
    return bytes ? (JSON.parse(Buffer.from(bytes).toString('utf8')) as T) : null;
  }

  putColumn(cx: number, cz: number, range: unknown): void {
    this.put(`c${rk(cx)},${rk(cz)}`, `k${cx},${cz}`, Buffer.from(JSON.stringify(range), 'utf8'));
  }

  /** Its folder made (once; again after a failed write, in case it was taken away). */
  private made: Promise<unknown> | null = null;

  /** Writes not finished yet. */
  private readonly pending = new Set<Promise<void>>();

  /** Waits for every write so far (tests, and shutting down). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async get(region: string, key: string): Promise<Uint8Array | null> {
    const r = await this.region(region);
    const z = r.entries.get(key);
    if (!z) {
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return new Uint8Array(await inflateRawAsync(z));
  }

  private put(region: string, key: string, bytes: Uint8Array): void {
    const done: Promise<void> = Promise.all([deflateRawAsync(bytes, { level: 1 }), this.region(region)]).then(([z, r]) => {
      if (r.entries.has(key)) return; // (two askers made it at once: one copy)
      r.entries.set(key, z);
      const k = Buffer.from(key, 'utf8');
      const head = Buffer.alloc(6);
      head.writeUInt16LE(k.length, 0);
      head.writeUInt32LE(z.length, 2);
      const record = Buffer.concat([head, k, z]);
      // One write at a time per region, in order.
      r.writing = r.writing.then(async () => {
        try {
          await (this.made ??= mkdir(this.dir, { recursive: true }));
          await appendFile(join(this.dir, `${region}.cache`), record);
          this.stats.writes++;
        } catch {
          this.made = null;
          this.stats.errors++; // (a full or missing disk: the terrain is just made again next time)
        }
      });
      return r.writing;
    });
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
  }

  /** A region's entries, read the first time it's asked about. */
  private region(name: string): Promise<Region> {
    const hit = this.regions.get(name);
    if (hit) {
      this.regions.delete(name);
      this.regions.set(name, hit);
      return hit.loaded;
    }
    const r: Region = { entries: new Map(), writing: Promise.resolve(), loaded: null! };
    r.loaded = readFile(join(this.dir, `${name}.cache`)).then(
      (buf) => {
        for (const [key, z] of parseRecords(buf)) r.entries.set(key, z);
        return r;
      },
      () => r, // (none yet)
    );
    this.regions.set(name, r);
    while (this.regions.size > this.keep) this.regions.delete(this.regions.keys().next().value!);
    return r.loaded;
  }
}

interface Region {
  entries: Map<string, Buffer>;
  /** Appends to its file, one after another. */
  writing: Promise<void>;
  loaded: Promise<Region>;
}

/** Chunk columns (and tiles) per region side. */
export const REGION = 16;
const rk = (v: number) => Math.floor(v / REGION);

/** A region file's records: [key length u16][data length u32][key][data], until one is cut short. */
export function parseRecords(buf: Buffer): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  let at = 0;
  while (at + 6 <= buf.length) {
    const kl = buf.readUInt16LE(at), dl = buf.readUInt32LE(at + 2);
    if (at + 6 + kl + dl > buf.length) break; // torn
    out.push([buf.toString('utf8', at + 6, at + 6 + kl), buf.subarray(at + 6 + kl, at + 6 + kl + dl)]);
    at += 6 + kl + dl;
  }
  return out;
}
