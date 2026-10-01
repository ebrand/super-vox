import type { MeshRequest, MeshResponse } from './mesher.worker.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A mesh request without its id; the pool assigns one. */
type Job = DistributiveOmit<MeshRequest, 'id'>;

/**
 * Pool of mesh workers with per-job promises and timing stats. Each worker has one job at a time;
 * the rest wait here, so a job that stops being wanted while it waits (we flew past its chunk) is
 * skipped rather than meshed.
 */
export class MeshWorkerPool {
  private readonly workers: Worker[];
  private readonly idle: Worker[];
  private readonly waiting: { job: Job; current?: () => boolean; resolve: (res: MeshResponse) => void }[] = [];
  private readonly running = new Map<number, (res: MeshResponse) => void>();
  private nextId = 1;
  private msTotal = 0;
  private count = 0;
  private skippedCount = 0;

  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<MeshResponse>) => {
        this.msTotal += ev.data.ms;
        this.count++;
        const resolve = this.running.get(ev.data.id);
        this.running.delete(ev.data.id);
        this.idle.push(w);
        resolve?.(ev.data);
        this.dispatch();
      };
      return w;
    });
    this.idle = [...this.workers];
  }

  /**
   * Meshes `job` on the next free worker. If `current` returns false by then, the job is skipped:
   * it resolves with no buffers and `skipped` set.
   */
  run(job: Job, current?: () => boolean): Promise<MeshResponse> {
    return new Promise((resolve) => {
      this.waiting.push({ job, ...(current ? { current } : {}), resolve });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.waiting.length > 0) {
      const { job, current, resolve } = this.waiting.shift()!;
      if (current && !current()) {
        this.skippedCount++;
        resolve({ id: 0, buffers: null, ms: 0, skipped: true });
        continue;
      }
      const id = this.nextId++;
      this.running.set(id, resolve);
      this.idle.pop()!.postMessage({ ...job, id } as MeshRequest);
    }
  }

  /** Jobs waiting or running. */
  get busy(): number {
    return this.waiting.length + this.running.size;
  }

  /** Jobs skipped because they were no longer wanted. */
  get skipped(): number {
    return this.skippedCount;
  }

  get averageMs(): number {
    return this.count ? this.msTotal / this.count : 0;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
