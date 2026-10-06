import { describe, expect, it } from 'vitest';
import { CALM_RAIN, HEAVY_RAIN, fft, levelAt, shapedNoiseChannels } from './rainNoise.js';

/** Energy (dB) in each octave band (centre Hz) of a signal at `rate`, from its spectrum, relative to the loudest. */
function bands(x: Float32Array, rate: number, centres: number[]): number[] {
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  fft(re, im, false);
  const e = centres.map((c) => {
    let sum = 0;
    for (let k = Math.ceil((c / Math.SQRT2) * n / rate); k < Math.min(n / 2, (c * Math.SQRT2 * n) / rate); k++) sum += re[k]! ** 2 + im[k]! ** 2;
    return sum;
  });
  const top = Math.max(...e);
  return e.map((v) => 10 * Math.log10(v / top));
}

describe('rain noise', () => {
  const rate = 44100, centres = [125, 250, 500, 1000, 2000, 4000, 8000];

  it('levels between and beyond the table', () => {
    expect(levelAt(HEAVY_RAIN, 1000)).toBeCloseTo(-2.8, 5);
    expect(levelAt(HEAVY_RAIN, Math.SQRT2 * 1000)).toBeCloseTo((-2.8 - 4.3) / 2, 5);
    expect(levelAt(HEAVY_RAIN, 32000)).toBeLessThan(-40);
  });

  it('a loop shaped as the table (each octave within 1.5 dB), RMS 1, two different channels', () => {
    for (const table of [CALM_RAIN, HEAVY_RAIN]) {
      const [l, r] = shapedNoiseChannels(table, 1 << 15, rate);
      let sum = 0;
      for (const v of l!) sum += v * v;
      expect(Math.sqrt(sum / l!.length)).toBeCloseTo(1, 5);
      expect(l![100]).not.toBe(r![100]);
      const got = bands(l!, rate, centres);
      const want = centres.map((c) => levelAt(table, c)), top = Math.max(...want);
      got.forEach((g, i) => expect(Math.abs(g - (want[i]! - top))).toBeLessThan(1.5));
    }
  });

  it('heavy rain is darker than calm: far less in the highs for its lows', () => {
    const calm = bands(shapedNoiseChannels(CALM_RAIN, 1 << 15, rate)[0]!, rate, [125, 8000]);
    const heavy = bands(shapedNoiseChannels(HEAVY_RAIN, 1 << 15, rate)[0]!, rate, [125, 8000]);
    expect(heavy[1]! - heavy[0]!).toBeLessThan(calm[1]! - calm[0]! - 8);
  });
});
