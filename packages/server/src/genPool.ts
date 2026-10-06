import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ChunkCoord, ColumnRange, PlateStages, TerrainStroke, TileCoord, WorldConfig } from '@super-vox/shared';
import type { GenJob, GenRequest, GenResponse } from './genWorker.js';
import type { RemoteGenerator } from './world.js';
import type { WorldSpec } from './worldFile.js';

/**
 * Worker threads that generate worlds' chunks, tiles and column ranges, so the main thread (the
 * sockets, edits, mobs) isn't held up by it and the work spreads over the server's cores. Each
 * worker builds a world's generator the first time it's asked about it. A column's work always
 * goes to the same worker, where the column (its heights, materials, trees) is then cached.
 */
export class GenPool {
  private readonly workers: Worker[] = [];
  private readonly waiting = new Map<number, { worker: number; resolve: (r: GenResponse & { ok: true }) => void; reject: (err: Error) => void }>();
  /** The worlds registered (to tell a replacement worker about). */
  private readonly worlds = new Map<string, GenRequest & { type: 'world' }>();
  private nextId = 1;
  private nextKey = 1;
  private closed = false;

  constructor(readonly size: number) {
    this.start();
  }

  /** Whether its worker threads are running (they stop when no world is left on it: see forget). */
  get running(): boolean {
    return this.workers.length > 0;
  }

  private start(): void {
    for (let i = 0; i < this.size; i++) this.workers.push(this.spawn(i));
  }

  /**
   * Stops every worker thread (the last world on the pool was let go of): all they held goes back
   * to the system, as nothing else gives a thread's memory back. Started again for the next world.
   */
  private stop(): void {
    const workers = this.workers.splice(0);
    for (const [id, p] of this.waiting) {
      this.waiting.delete(id);
      p.reject(new Error('generation pool stopped: its world was closed'));
    }
    for (const w of workers) void w.terminate();
  }

  /**
   * Generation of a world (its settings, as built, and terraforming) on the pool; for a plate world,
   * `stages`, the build already made (see PlateStageCache.share), so workers needn't make it again.
   */
  remote(name: string, spec: WorldSpec, config: WorldConfig, strokes: readonly TerrainStroke[], stages: PlateStages | null = null): RemoteGenerator & { forget(): void } {
    const key = `${name}#${this.nextKey++}`;
    const msg: GenRequest & { type: 'world' } = { type: 'world', key, spec, config, strokes: [...strokes], stages };
    if (!this.running && !this.closed) this.start();
    this.worlds.set(key, msg);
    for (const w of this.workers) w.postMessage(msg);
    const n = this.size;
    const run = (worker: number, job: GenJob) => this.run(worker, key, job);
    return {
      chunk: (c: ChunkCoord) => run(columnWorker(c.cx, c.cz, n), { kind: 'chunk', coord: c }).then((r) => ({ bytes: r.bytes!, ms: r.ms, buildMs: r.buildMs })),
      tile: (t: TileCoord) => run(spread(t.level * 7919 + t.tx, t.tz, n), { kind: 'tile', t }).then((r) => ({ bytes: r.bytes!, ms: r.ms })),
      column: (cx: number, cz: number) => run(columnWorker(cx, cz, n), { kind: 'column', cx, cz }).then((r) => r.range as ColumnRange),
      forget: () => {
        if (!this.worlds.delete(key)) return;
        if (this.worlds.size === 0) return this.stop();
        for (const w of this.workers) w.postMessage({ type: 'forget', key } satisfies GenRequest);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, p] of this.waiting) {
      this.waiting.delete(id);
      p.reject(new Error('generation pool closed'));
    }
    await Promise.all(this.workers.map((w) => w.terminate()));
  }

  private run(worker: number, key: string, job: GenJob): Promise<GenResponse & { ok: true }> {
    if (this.closed) return Promise.reject(new Error('generation pool closed'));
    if (!this.worlds.has(key) || !this.running) return Promise.reject(new Error(`no world ${key} here`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { worker, resolve, reject });
      this.workers[worker]!.postMessage({ type: 'job', id, key, job } satisfies GenRequest);
    });
  }

  private spawn(i: number): Worker {
    const w = startWorker();
    w.unref(); // (never what keeps the process alive)
    w.on('message', (res: GenResponse) => {
      const p = this.waiting.get(res.id);
      if (!p) return;
      this.waiting.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(new Error(res.error));
    });
    // A worker that dies takes its jobs with it: they fail, and a new one takes its place.
    w.on('error', (err: unknown) => this.lost(i, w, err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => this.lost(i, w, new Error(`generation worker stopped (${code})`)));
    return w;
  }

  /** Worker `w` (number i) stopped: once only, and only while it's still the one in use. */
  private lost(i: number, w: Worker, err: Error): void {
    if (this.closed || this.workers[i] !== w) return;
    for (const [id, p] of this.waiting) {
      if (p.worker !== i) continue;
      this.waiting.delete(id);
      p.reject(err);
    }
    const next = this.spawn(i);
    this.workers[i] = next;
    for (const msg of this.worlds.values()) next.postMessage(msg);
    void w.terminate();
  }
}

/**
 * A worker thread running module `name` (a generation worker by default). Production runs the
 * build; development and tests, the TypeScript sources, through tsx (registered in the worker
 * first: flags for it don't reach worker threads here).
 */
export function startWorker(name = 'genWorker', workerData?: unknown): Worker {
  if (!import.meta.url.endsWith('.ts')) return new Worker(new URL(`./${name}.js`, import.meta.url), { workerData });
  // (Its ES module: the CommonJS one doesn't load in a worker.)
  const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/esm/api/index.mjs')).href;
  const main = new URL(`./${name}.ts`, import.meta.url).href;
  return new Worker(`import(${JSON.stringify(tsx)}).then((m) => { m.register(); return import(${JSON.stringify(main)}); });`, { eval: true, execArgv: ['--conditions=source'], workerData });
}

/** The worker for a chunk column: always the same one, where its column is cached. */
function columnWorker(cx: number, cz: number, n: number): number {
  return spread(cx, cz, n);
}

function spread(a: number, b: number, n: number): number {
  return ((Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0) % n;
}
