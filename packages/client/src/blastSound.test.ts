import { describe, expect, it } from 'vitest';
import { blastSoundPlan } from './blastSound.js';

describe('blastSoundPlan', () => {
  it('bigger blasts are louder, longer and deeper, with an echo', () => {
    const small = blastSoundPlan(10, 2.3), mid = blastSoundPlan(10, 6.4), big = blastSoundPlan(10, 16);
    expect(small.size).toBe(0);
    expect(big.size).toBe(1);
    for (const [a, b] of [[small, mid], [mid, big]] as const) {
      expect(b.loud).toBeGreaterThan(a.loud);
      expect(b.length).toBeGreaterThan(a.length);
      expect(b.rumble).toBeGreaterThan(a.rumble);
      expect(b.rumbleDecay).toBeGreaterThan(a.rumbleDecay);
      expect(b.punchTo).toBeLessThan(a.punchTo);
      expect(b.punchDecay).toBeGreaterThan(a.punchDecay);
    }
    expect(small.echo).toBe(0);
    expect(big.echo).toBeGreaterThan(0);
    // (The biggest, close by, at full loudness; the smallest well under it.)
    expect(blastSoundPlan(5, 16).loud).toBeCloseTo(1, 5);
    expect(blastSoundPlan(5, 2.3).loud).toBeLessThan(0.5);
  });

  it('farther blasts are heard later, quieter and duller (the crack first to go)', () => {
    const near = blastSoundPlan(20, 16), far = blastSoundPlan(800, 16);
    expect(near.delay).toBeCloseTo(20 / 343, 5);
    expect(far.delay).toBeCloseTo(800 / 343, 5);
    expect(far.loud).toBeLessThan(near.loud / 5);
    expect(far.muffle).toBeLessThan(near.muffle / 5);
    expect(far.crack).toBeLessThan(near.crack / 5);
    // (But a big one far off still heard more than a small one near.)
    expect(blastSoundPlan(200, 16).loud).toBeGreaterThan(0.1);
  });

  it('within a couple of radii, distance makes no difference', () => {
    expect(blastSoundPlan(3, 8).loud).toBe(blastSoundPlan(15, 8).loud);
  });
});
