import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshWorkerPool } from './workerPool.js';

/** Stand-in workers: record what they're given and reply when the test says. */
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  jobs: { id: number }[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(job: { id: number }) {
    this.jobs.push(job);
  }
  finish() {
    const job = this.jobs.shift()!;
    this.onmessage?.({ data: { id: job.id, buffers: null, ms: 1 } } as MessageEvent);
  }
  terminate() {}
}

afterEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
});

describe('MeshWorkerPool', () => {
  it('gives each worker one job at a time and skips jobs no longer wanted', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pool = new MeshWorkerPool(2);
    const tile = { kind: 'tile' as const, tile: new Uint8Array() };
    let wantC = true;
    const a = pool.run(tile), b = pool.run(tile), c = pool.run(tile, () => wantC), d = pool.run(tile);
    expect(workers.map((w) => w.jobs.length)).toEqual([1, 1]);
    expect(pool.busy).toBe(4);
    wantC = false;
    workers.find((w) => w.jobs.length)!.finish(); // c is skipped, d goes to the free worker
    expect(await c).toMatchObject({ skipped: true, buffers: null });
    expect(workers.map((w) => w.jobs.length).reduce((s, n) => s + n)).toBe(2);
    for (const w of workers) while (w.jobs.length) w.finish();
    await Promise.all([a, b, d]);
    expect(pool.busy).toBe(0);
    expect(pool.skipped).toBe(1);
    expect(pool.averageMs).toBe(1);
  });
});
