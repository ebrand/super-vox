import type { MeshRequest, MeshResponse } from './mesher.worker.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A mesh request without its id; the pool assigns one. */
type Job = DistributiveOmit<MeshRequest, 'id'>;

/** Round-robin pool of mesh workers with per-job promises and timing stats. */
export class MeshWorkerPool {
  private readonly workers: Worker[];
  private readonly pending = new Map<number, (res: MeshResponse) => void>();
  private nextId = 1;
  private next = 0;
  private msTotal = 0;
  private count = 0;

  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<MeshResponse>) => {
        this.msTotal += ev.data.ms;
        this.count++;
        const resolve = this.pending.get(ev.data.id);
        this.pending.delete(ev.data.id);
        resolve?.(ev.data);
      };
      return w;
    });
  }

  run(job: Job): Promise<MeshResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.workers[this.next++ % this.workers.length]!.postMessage({ ...job, id } as MeshRequest);
    });
  }

  get busy(): number {
    return this.pending.size;
  }

  get averageMs(): number {
    return this.count ? this.msTotal / this.count : 0;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
