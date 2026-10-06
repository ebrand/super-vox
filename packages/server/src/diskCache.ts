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
 * about and then kept in memory: the regions used most recently, at most `keep` of them and
 * `maxBytes` of their records (one let go of is read again if it's wanted: a file read, in the
 * background). A torn last record (a crash while writing) is ignored.
 */
export class DiskCache {
  private readonly regions = new Map<string, Region>();
  /** How many reads and writes there have been. */
  readonly stats = { hits: 0, misses: 0, writes: 0, errors: 0 };
  /** Bytes of records the regions in memory hold. */
  private held = 0;

  constructor(
    readonly dir: string,
    private readonly keep = 4096,
    private readonly maxBytes = DISK_CACHE_MEMORY,
  ) {}

  /** Bytes of records kept in memory now. */
  get bytesHeld(): number {
    return this.held;
  }

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
    const done: Promise<void> = Promise.all([deflateRawAsync(bytes, { level: 1 }), this.region(region)]).then(([out, r]) => {
      // (A copy of its own: zlib's answer is a little of a far bigger buffer, all of it kept while
      // the record is: twenty times the memory.)
      const z = Buffer.from(out);
      if (r.entries.has(key)) return; // (two askers made it at once: one copy)
      r.entries.set(key, z);
      this.hold(r, z.length);
      const k = Buffer.from(key, 'utf8');
      const head = Buffer.alloc(6);
      head.writeUInt16LE(k.length, 0);
      head.writeUInt32LE(z.length, 2);
      const record = Buffer.concat([head, k, z]);
      // One write at a time per region, in order.
      r.pending++;
      r.writing = r.writing.then(async () => {
        try {
          await (this.made ??= mkdir(this.dir, { recursive: true }));
          await appendFile(join(this.dir, `${region}.cache`), record);
          this.stats.writes++;
        } catch {
          this.made = null;
          this.stats.errors++; // (a full or missing disk: the terrain is just made again next time)
        } finally {
          r.pending--;
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
    const r: Region = { name, entries: new Map(), writing: Promise.resolve(), loaded: null!, bytes: 0, pending: 0 };
    r.loaded = readFile(join(this.dir, `${name}.cache`)).then(
      (buf) => {
        for (const [key, z] of parseRecords(buf)) r.entries.set(key, z);
        this.hold(r, buf.length);
        return r;
      },
      () => r, // (none yet)
    );
    this.regions.set(name, r);
    this.trim(r);
    return r.loaded;
  }

  /** Counts `bytes` more held by region `r` (if it's still kept), and lets go of others if that's too many. */
  private hold(r: Region, bytes: number): void {
    if (this.regions.get(r.name) !== r) return; // (let go of already: nothing held)
    r.bytes += bytes;
    this.held += bytes;
    this.trim(r);
  }

  /**
   * Lets go of the regions used longest ago while there are more than `keep` or they hold more
   * than `maxBytes` (never `except`, the one in use; nor one still being written to, which would
   * be read again without what it's writing).
   */
  private trim(except: Region): void {
    for (const [name, r] of this.regions) {
      if (this.regions.size <= this.keep && this.held <= this.maxBytes) return;
      if (r === except || r.pending > 0) continue;
      this.regions.delete(name);
      this.held -= r.bytes;
      r.bytes = 0;
    }
  }
}

interface Region {
  name: string;
  entries: Map<string, Buffer>;
  /** Appends to its file, one after another, and how many are still to finish. */
  writing: Promise<void>;
  pending: number;
  loaded: Promise<Region>;
  /** Bytes of records it holds (counted while it's kept). */
  bytes: number;
}

/**
 * Most bytes of generated terrain (compressed) a world's disk cache keeps in memory: a few dozen
 * regions, about a square kilometre or two, read again from disk beyond that. (Kept by count only,
 * a long flight held gigabytes, and a server holds on to memory once it's had it.)
 */
export const DISK_CACHE_MEMORY = 256 * 1024 * 1024;

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
