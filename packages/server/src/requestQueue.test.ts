import { describe, expect, it } from 'vitest';
import { RequestQueue } from './requestQueue.js';

/** A queue run by hand: `step()` runs one scheduled batch. */
function manual(budgetMs = 1000) {
  const pending: (() => void)[] = [];
  const errors: unknown[] = [];
  const q = new RequestQueue((e) => errors.push(e), budgetMs, (fn) => pending.push(fn));
  return { q, errors, step: () => pending.shift()?.(), scheduled: () => pending.length };
}

describe('RequestQueue', () => {
  it('serves in order, the front lane first, ignoring repeats', () => {
    const { q, step } = manual();
    const ran: string[] = [];
    q.add('a', () => {
      ran.push('a');
      q.add('a1', () => ran.push('a1'), true);
      q.add('c', () => ran.push('c again'), true); // already waiting
    });
    q.add('b', () => ran.push('b'));
    q.add('b', () => ran.push('b again'));
    q.add('c', () => ran.push('c'));
    step();
    expect(ran).toEqual(['a', 'a1', 'b', 'c']);
    expect(q.size).toBe(0);
  });

  it('drops cancelled requests and everything once closed', () => {
    const { q, step } = manual();
    const ran: string[] = [];
    for (const k of ['a', 'b', 'c', 'd']) q.add(k, () => ran.push(k));
    expect(q.cancel('b')).toBe(true);
    expect(q.cancel('x')).toBe(false);
    step();
    expect(ran).toEqual(['a', 'c', 'd']);
    expect(q.cancel('a')).toBe(false); // already served
    q.add('e', () => ran.push('e'));
    q.close();
    q.add('f', () => ran.push('f'));
    step();
    expect(ran).toEqual(['a', 'c', 'd']);
  });

  it('yields between batches when its budget runs out, and survives a failing job', () => {
    const { q, step, scheduled, errors } = manual(0); // one job per batch
    const ran: string[] = [];
    q.add('a', () => ran.push('a'));
    q.add('bad', () => {
      throw new Error('boom');
    });
    q.add('c', () => ran.push('c'));
    expect(scheduled()).toBe(1);
    step();
    expect(ran).toEqual(['a']);
    q.cancel('c'); // arrives between batches
    step();
    step();
    expect(ran).toEqual(['a']);
    expect(errors).toHaveLength(1);
    expect(scheduled()).toBe(0);
  });
});
