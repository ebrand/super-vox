/**
 * A connection's pending requests (chunks, tiles, columns), served in arrival order a few
 * milliseconds' worth at a time. Between batches the event loop reads the socket again, so a
 * `cancel` for requests the client has flown past arrives before they're generated, and other
 * connections get their turn.
 */
export class RequestQueue {
  /** Served first: the chunks of a column just answered, so columns finish in the order asked. */
  private readonly front = new Map<string, () => void>();
  private readonly main = new Map<string, () => void>();
  private scheduled = false;
  private closed = false;

  constructor(
    private readonly onError: (err: unknown) => void,
    /** Time to spend per batch before yielding to the event loop. */
    private readonly budgetMs = 8,
    private readonly schedule: (fn: () => void) => void = setImmediate,
  ) {}

  get size(): number {
    return this.front.size + this.main.size;
  }

  /** Queues `job` under `key`, unless a request with that key is already waiting. */
  add(key: string, job: () => void, front = false): void {
    if (this.closed || this.front.has(key) || this.main.has(key)) return;
    (front ? this.front : this.main).set(key, job);
    this.wake();
  }

  /** Drops a waiting request; false if it isn't waiting (already served, or never asked). */
  cancel(key: string): boolean {
    return this.front.delete(key) || this.main.delete(key);
  }

  close(): void {
    this.closed = true;
    this.front.clear();
    this.main.clear();
  }

  private wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    const t0 = performance.now();
    // At least one job per batch, then more while the budget lasts.
    do {
      const lane = this.front.size ? this.front : this.main;
      const next = lane.entries().next();
      if (next.done) return;
      const [key, job] = next.value;
      lane.delete(key);
      try {
        job();
      } catch (err) {
        this.onError(err);
      }
    } while (!this.closed && performance.now() - t0 < this.budgetMs);
    if (this.size) this.wake();
  }
}
