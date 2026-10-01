/**
 * Which of a connection's requests go first: `front`, the chunks of a column just answered (so
 * columns finish in the order asked); `near`, full-detail columns and chunks, around the player;
 * `far`, low-detail tiles, which get every FAR_EVERY-th turn while near work waits so distant
 * terrain still fills in.
 */
export type Lane = 'front' | 'near' | 'far';

/** While near work waits, one far job in this many. */
export const FAR_EVERY = 4;

/**
 * A connection's pending requests (chunks, tiles, columns), served by lane (see Lane), each lane
 * in arrival order, a few milliseconds' worth at a time. Between batches the event loop reads the
 * socket again, so a `cancel` for requests the client has flown past arrives before they're
 * generated, and other connections get their turn.
 */
export class RequestQueue {
  private readonly lanes: Record<Lane, Map<string, () => void>> = { front: new Map(), near: new Map(), far: new Map() };
  private sinceFar = 0;
  private scheduled = false;
  private closed = false;

  constructor(
    private readonly onError: (err: unknown) => void,
    /** Time to spend per batch before yielding to the event loop. */
    private readonly budgetMs = 8,
    private readonly schedule: (fn: () => void) => void = setImmediate,
  ) {}

  get size(): number {
    return this.lanes.front.size + this.lanes.near.size + this.lanes.far.size;
  }

  /** Queues `job` under `key`, unless a request with that key is already waiting. */
  add(key: string, job: () => void, lane: Lane = 'near'): void {
    if (this.closed || this.waiting(key)) return;
    this.lanes[lane].set(key, job);
    this.wake();
  }

  /** Drops a waiting request; false if it isn't waiting (already served, or never asked). */
  cancel(key: string): boolean {
    return this.lanes.front.delete(key) || this.lanes.near.delete(key) || this.lanes.far.delete(key);
  }

  close(): void {
    this.closed = true;
    for (const lane of Object.values(this.lanes)) lane.clear();
  }

  private waiting(key: string): boolean {
    return this.lanes.front.has(key) || this.lanes.near.has(key) || this.lanes.far.has(key);
  }

  private next(): Map<string, () => void> | null {
    const { front, near, far } = this.lanes;
    if (front.size) return front;
    if (far.size && (!near.size || this.sinceFar >= FAR_EVERY - 1)) {
      this.sinceFar = 0;
      return far;
    }
    if (near.size) {
      this.sinceFar++;
      return near;
    }
    return null;
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
      const lane = this.next();
      if (!lane) return;
      const [key, job] = lane.entries().next().value!;
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
