/**
 * A search for somewhere to settle (an outlaws' camp, a village), a few places a step: one group's at
 * a time; a group whose search found nowhere left to rest a while before it looks again. (Each
 * place looked at samples the ground many times: done all at once, for every group that had met,
 * every second, and again every second for those that found nowhere, it held the server up for
 * seconds at a time.)
 */
export class SiteSearch<S> {
  private going: { ids: readonly number[]; places: Iterator<S | null, null> } | null = null;
  /** Those whose last search found nowhere: until when (ms) they rest. */
  private readonly resting = new Map<number, number>();

  /**
   * @param perStep places looked at a step
   * @param restMs how long (ms) a group whose search found nowhere waits to look again
   */
  constructor(
    private readonly perStep: number,
    private readonly restMs: number,
  ) {}

  /** Whether `id` may start a search (it's not in one, nor resting after one that found nowhere). */
  free(id: number, now: number): boolean {
    const until = this.resting.get(id);
    if (until !== undefined && until <= now) this.resting.delete(id);
    return !(until !== undefined && until > now) && !this.going?.ids.includes(id);
  }

  /**
   * On with the search under way, or one `start` begins (null: nobody to look): the place found and
   * for whom, once one is; null meanwhile (and when it found nowhere: they rest).
   */
  step(now: number, start: () => { ids: readonly number[]; places: Iterator<S | null, null> } | null): { ids: readonly number[]; site: S } | null {
    this.going ??= start();
    const g = this.going;
    if (!g) return null;
    for (let i = 0; i < this.perStep; i++) {
      const n = g.places.next();
      if (n.done) {
        this.going = null;
        for (const id of g.ids) this.resting.set(id, now + this.restMs);
        return null;
      }
      if (n.value !== null) {
        this.going = null;
        return { ids: g.ids, site: n.value };
      }
    }
    return null;
  }
}
