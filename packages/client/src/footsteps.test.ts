import { describe, expect, it } from 'vitest';
import { Material, SPRINT, WALK_SPEED } from '@super-vox/shared';
import { FootstepWeather, STRIDE, SPRINT_STRIDE, StepCounter, stepSound, surfaceOf, tapSound, underSnow, type Surface } from './footsteps.js';

/** A seeded random (so a sound's the same each run). */
function seeded(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('surfaces', () => {
  it('what each ground sounds like', () => {
    expect(surfaceOf(Material.Grass)).toBe('soft');
    expect(surfaceOf(Material.Dirt)).toBe('soft');
    expect(surfaceOf(Material.Stone)).toBe('hard');
    expect(surfaceOf(Material.Planks)).toBe('wood');
    expect(surfaceOf(Material.DesertSand)).toBe('sand');
    expect(surfaceOf(Material.Gravel)).toBe('gravel');
    expect(surfaceOf(Material.Snow)).toBe('snow');
    expect(surfaceOf(Material.Water)).toBe('water');
    expect(surfaceOf(Material.PouredWater)).toBe('water');
  });

  it('snow lying turns earth, sand and gravel to snow, not stone or wood', () => {
    expect(underSnow('soft', 0.5)).toBe('snow');
    expect(underSnow('gravel', 0.5)).toBe('snow');
    expect(underSnow('hard', 0.5)).toBe('hard');
    expect(underSnow('wood', 0.5)).toBe('wood');
    expect(underSnow('soft', 0.1)).toBe('soft');
  });
});

describe('StepCounter', () => {
  /** Steps walking `metres` in steps of 5 cm. */
  const steps = (metres: number, sprint = false, counter = new StepCounter()) => {
    let n = 0;
    for (let d = 0; d < metres - 1e-9; d += 0.05) if (counter.update(0.05, sprint)) n++;
    return n;
  };

  it('a step setting off, then one a stride; fewer sprinting', () => {
    expect(steps(10)).toBe(1 + Math.floor((10 - 0.05) / STRIDE));
    expect(steps(10, true)).toBe(1 + Math.floor((10 - 0.05) / SPRINT_STRIDE));
  });

  it('80 steps a minute walking at full pace, 120 sprinting', () => {
    // (A minute at each pace, in 1/60 s frames.)
    const minute = (speed: number, sprint: boolean) => {
      const c = new StepCounter();
      let n = 0;
      for (let f = 0; f < 3600; f++) if (c.update(speed / 60, sprint)) n++;
      return n;
    };
    expect(minute(WALK_SPEED, false)).toBeGreaterThanOrEqual(80);
    expect(minute(WALK_SPEED, false)).toBeLessThanOrEqual(81);
    expect(minute(WALK_SPEED * SPRINT, true)).toBeGreaterThanOrEqual(120);
    expect(minute(WALK_SPEED * SPRINT, true)).toBeLessThanOrEqual(121);
  });

  it('standing still: none; moving off again: one at once', () => {
    const c = new StepCounter();
    steps(0.5, false, c);
    expect(c.update(0, false)).toBe(false);
    expect(c.update(0.05, false)).toBe(true);
  });
});

describe('FootstepWeather', () => {
  it('rain wets the ground in about 15 s (hard rain) and it dries in 3 min; snow lies, then melts', () => {
    const w = new FootstepWeather();
    for (let t = 0; t < 15; t += 0.1) w.update(1, 0, 0.1);
    expect(w.wet).toBeCloseTo(1, 1);
    for (let t = 0; t < 90; t += 0.1) w.update(0, 0, 0.1);
    expect(w.wet).toBeCloseTo(0.5, 1);
    for (let t = 0; t < 90; t += 0.1) w.update(0, 0, 0.1);
    expect(w.wet).toBe(0);
    for (let t = 0; t < 30; t += 0.1) w.update(0, 1, 0.1);
    expect(w.snowCover).toBeCloseTo(1, 1);
  });
});

describe('stepSound', () => {
  const rate = 44100;
  /** Peak, RMS, and how long it's above a tenth of its peak (s). */
  const measure = (x: Float32Array) => {
    let peak = 0, sum = 0, last = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
    for (let i = 0; i < x.length; i++) {
      sum += x[i]! ** 2;
      if (Math.abs(x[i]!) > peak / 10) last = i;
    }
    return { peak, rms: Math.sqrt(sum / x.length), lasts: last / rate };
  };

  it('every surface sounds (finite, heard, never clipping)', () => {
    for (const s of ['soft', 'hard', 'wood', 'sand', 'gravel', 'snow', 'water'] as Surface[]) {
      for (const hard of [0.4, 1]) {
        const m = measure(stepSound(s, 0, hard, rate, seeded(7)));
        expect(Number.isFinite(m.rms)).toBe(true);
        expect(m.peak).toBeGreaterThan(0.02);
        expect(m.peak).toBeLessThan(1);
      }
    }
  });

  it('wet ground adds a squelch; snow crunches longer than stone taps; a landing is louder', () => {
    expect(measure(stepSound('soft', 1, 0.4, rate, seeded(3))).rms).toBeGreaterThan(measure(stepSound('soft', 0, 0.4, rate, seeded(3))).rms * 1.2);
    expect(measure(stepSound('snow', 0, 0.4, rate, seeded(3))).lasts).toBeGreaterThan(measure(stepSound('hard', 0, 0.4, rate, seeded(3))).lasts * 2);
    expect(measure(stepSound('soft', 0, 1, rate, seeded(3))).rms).toBeGreaterThan(measure(stepSound('soft', 0, 0.4, rate, seeded(3))).rms * 1.3);
  });

  it('no two steps quite alike', () => {
    const a = stepSound('soft', 0, 0.4, rate), b = stepSound('soft', 0, 0.4, rate);
    expect(a.some((v, i) => v !== b[i])).toBe(true);
  });

  it("a hammer's tap: short, heard, never clipping", () => {
    const m = measure(tapSound(rate, seeded(5)));
    expect(m.peak).toBeGreaterThan(0.05);
    expect(m.peak).toBeLessThan(1);
    expect(m.lasts).toBeLessThan(0.2);
  });

  it('cheap enough to make on the spot', () => {
    const t = performance.now();
    for (let i = 0; i < 20; i++) stepSound(i % 2 ? 'snow' : 'gravel', 1, 0.6, 48000);
    expect((performance.now() - t) / 20).toBeLessThan(15);
  });
});
