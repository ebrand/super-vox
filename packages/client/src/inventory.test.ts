import { describe, expect, it } from 'vitest';
import { wheelSteps } from './inventory.js';

describe('wheelSteps', () => {
  it('steps once per notch, either way, keeping what a trackpad has scrolled so far', () => {
    expect(wheelSteps(0, 100)).toEqual({ steps: 2, travel: 20 });
    expect(wheelSteps(0, -40)).toEqual({ steps: -1, travel: 0 });
    // A trackpad's small deltas add up.
    let t = 0, steps = 0;
    for (let i = 0; i < 10; i++) {
      const r = wheelSteps(t, 9);
      t = r.travel;
      steps += r.steps;
    }
    expect(steps).toBe(2);
    expect(t).toBe(10);
    expect(wheelSteps(10, -30)).toEqual({ steps: 0, travel: -20 });
  });
});
