import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Server-wide running totals. */
export interface Totals {
  chunksOut: number;
  tilesOut: number;
  columnsOut: number;
  edits: number;
  editErrors: number;
  messagesIn: number;
  bytesIn: number;
  bytesOut: number;
  /** Blocks whose water changed (all worlds). */
  waterChanges: number;
}

/** One second of the server's life. Rates are per second. */
export interface Sample {
  /** Epoch ms at the end of the second. */
  t: number;
  chunks: number;
  tiles: number;
  edits: number;
  messagesIn: number;
  bytesIn: number;
  bytesOut: number;
  waterChanges: number;
  /** Process CPU use, % of one core. */
  cpu: number;
  rssMB: number;
  heapMB: number;
  /** Event loop delay over the second (ms): how late timers ran, the server's responsiveness. */
  loopP99: number;
  players: number;
}

export interface ServerError {
  t: number;
  kind: string;
  message: string;
  world?: string;
}

/** History kept: five minutes of seconds. */
export const HISTORY = 300;
const MAX_ERRORS = 50;

const zero = (): Totals => ({ chunksOut: 0, tilesOut: 0, columnsOut: 0, edits: 0, editErrors: 0, messagesIn: 0, bytesIn: 0, bytesOut: 0, waterChanges: 0 });

/** Counts what the server does and samples it every second (see tick). */
export class Metrics {
  readonly totals: Totals = zero();
  readonly history: Sample[] = [];
  readonly errors: ServerError[] = [];
  readonly startedAt = Date.now();
  private last: Totals = zero();
  private lastCpu = process.cpuUsage();
  private lastT = performance.now();
  private readonly loop: ReturnType<typeof monitorEventLoopDelay>;

  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
  }

  error(kind: string, message: string, world?: string): void {
    this.errors.push({ t: Date.now(), kind, message, ...(world !== undefined ? { world } : {}) });
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
  }

  /** Records the second since the last tick. */
  tick(players: number): Sample {
    const now = performance.now(), dt = Math.max(1e-3, (now - this.lastT) / 1000);
    const cpu = process.cpuUsage(this.lastCpu);
    const mem = process.memoryUsage();
    const d = (k: keyof Totals) => (this.totals[k] - this.last[k]) / dt;
    const sample: Sample = {
      t: Date.now(),
      chunks: d('chunksOut'),
      tiles: d('tilesOut'),
      edits: d('edits'),
      messagesIn: d('messagesIn'),
      bytesIn: d('bytesIn'),
      bytesOut: d('bytesOut'),
      waterChanges: d('waterChanges'),
      cpu: ((cpu.user + cpu.system) / 1000 / (dt * 1000)) * 100,
      rssMB: mem.rss / 2 ** 20,
      heapMB: mem.heapUsed / 2 ** 20,
      loopP99: this.loop.count > 0 ? this.loop.percentile(99) / 1e6 : 0,
      players,
    };
    this.loop.reset();
    this.last = { ...this.totals };
    this.lastCpu = process.cpuUsage();
    this.lastT = now;
    this.history.push(sample);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    return sample;
  }

  stop(): void {
    this.loop.disable();
  }
}

/** The p-th percentile (0..100) of some numbers, or null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
