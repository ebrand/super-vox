import { describe, expect, it } from 'vitest';
import { TEMPERATE, climateAt, prevailingWind, strikesBetween, weatherAt, weatherSeed, weatherTime, type PlaceClimate } from './weather.js';
import type { ClimateGrid } from './climate.js';

const seed = weatherSeed('caves');
const desert: PlaceClimate = { ...TEMPERATE, temperature: 28, moisture: 0.08 };
const wet: PlaceClimate = { ...TEMPERATE, temperature: 16, moisture: 0.9 };
const cold: PlaceClimate = { ...TEMPERATE, temperature: -8, moisture: 0.6 };

/** The share of a day's samples (every 10 minutes, at spots spread over 20 km) with `pick` true. */
function share(climate: PlaceClimate, pick: (w: ReturnType<typeof weatherAt>) => boolean, height = 0): number {
  let n = 0, yes = 0;
  for (let t = 0; t < 86_400 * 3; t += 600)
    for (let i = 0; i < 8; i++) {
      const w = weatherAt(seed, t, i * 2500, i * 1700, height, 12, climate);
      n++;
      if (pick(w)) yes++;
    }
  return yes / n;
}

describe('weather', () => {
  it('is the same for everyone: the same seed, time and place give the same weather', () => {
    expect(weatherAt(seed, 1000, 500, 700, 20, 9, TEMPERATE)).toEqual(weatherAt(seed, 1000, 500, 700, 20, 9, TEMPERATE));
    expect(weatherSeed('caves')).toBe(seed);
    expect(weatherSeed('isles')).not.toBe(seed);
    expect(weatherTime(Date.UTC(2026, 0, 1, 0, 0, 10))).toBe(10);
  });

  it('rains often where it is wet, seldom in deserts, sometimes in between', () => {
    const rainy = (w: ReturnType<typeof weatherAt>) => w.precipitation > 0.1;
    const inWet = share(wet, rainy), inDesert = share(desert, rainy), inBetween = share(TEMPERATE, rainy);
    expect(inWet).toBeGreaterThan(0.25);
    expect(inDesert).toBeLessThan(0.03);
    expect(inBetween).toBeGreaterThan(0.05);
    expect(inBetween).toBeLessThan(inWet);
    // Clouds without rain, more often than rain.
    expect(share(TEMPERATE, (w) => w.cover > 0.3)).toBeGreaterThan(inBetween);
  });

  it('snows where it is freezing, up mountains too; rains where it is warm', () => {
    const falling = (c: PlaceClimate, h = 0) => {
      for (let t = 0; t < 86_400 * 5; t += 300) {
        const w = weatherAt(seed, t, 3000, 3000, h, 12, c);
        if (w.precipitation > 0.3) return w;
      }
      throw new Error('never fell');
    };
    expect(falling(cold).snow).toBe(1);
    expect(falling(wet).snow).toBe(0);
    // 3000 m up a mild place: about 19 degrees colder (6.5 a kilometre).
    const high = falling(TEMPERATE, 3000);
    expect(high.temperature).toBeCloseTo(12 - 19.5, 5);
    expect(high.snow).toBe(1);
  });

  it('drifts with the wind: a while later, the weather that was here is downwind', () => {
    // (Measured on the wet side, where cover is seldom stuck at none or all: on average, what was
    // here is much more like what's downwind a few minutes later than what's here then.)
    const w = prevailingWind(seed), dt = 300;
    let downwind = 0, stayed = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 731, z = i * 457, t = 5000 + i * 3000;
      const now = weatherAt(seed, t, x, z, 0, 12, wet).cover;
      downwind += Math.abs(weatherAt(seed, t + dt, x + w.x * dt, z + w.z * dt, 0, 12, wet).cover - now);
      stayed += Math.abs(weatherAt(seed, t + dt, x, z, 0, 12, wet).cover - now);
    }
    expect(downwind).toBeLessThan(stayed * 0.5);
  });

  it('gathers fog on wet mornings and low ground, not on dry afternoons or mountaintops', () => {
    const at = (hours: number, c: PlaceClimate, h = 0) => weatherAt(seed, 99_000, 100, 100, h, hours, c).fog;
    expect(at(6.5, wet)).toBeGreaterThan(at(15, wet));
    expect(at(6.5, wet)).toBeGreaterThan(at(6.5, desert));
    expect(at(6.5, wet, 1500)).toBeLessThan(at(6.5, wet) / 5);
  });

  it('strikes lightning only in thunderstorms, the same strikes for everyone', () => {
    // Somewhere warm and wet, over a long while: strikes, each where the storm is.
    const hot: PlaceClimate = { ...TEMPERATE, temperature: 26, moisture: 0.95 };
    const strikes = strikesBetween(seed, 0, 6 * 3600, 0, 0, 15_000, () => hot);
    expect(strikes.length).toBeGreaterThan(0);
    for (const s of strikes) expect(weatherAt(seed, s.t, s.x, s.z, 0, 14, hot).storm).toBeGreaterThan(0);
    expect(strikesBetween(seed, 0, 6 * 3600, 0, 0, 15_000, () => hot)).toEqual(strikes);
    // In order, and within the window asked.
    for (let i = 1; i < strikes.length; i++) expect(strikes[i]!.t).toBeGreaterThanOrEqual(strikes[i - 1]!.t);
    // Never where it's freezing; seldom in deserts (heavy rain reaches them now and then).
    expect(strikesBetween(seed, 0, 6 * 3600, 0, 0, 15_000, () => cold)).toEqual([]);
    expect(strikesBetween(seed, 0, 6 * 3600, 0, 0, 15_000, () => desert).length).toBeLessThan(strikes.length / 10);
  });

  it("reads a world's climate grid at a place, and is temperate without one", () => {
    const grid: ClimateGrid = { cols: 2, rows: 1, cell: 1000 * 16, seaLevel: 32, cooling: 0.0065 / 16, ecotone: { degrees: 0, moisture: 0 }, temperature: Float32Array.from([0, 20]), moisture: Float32Array.from([0.2, 0.8]) };
    expect(climateAt(grid, 500, 500)).toMatchObject({ temperature: 0, moisture: expect.closeTo(0.2, 5), seaLevel: 2 });
    expect(climateAt(grid, 1000, 500).temperature).toBeCloseTo(10, 5);
    expect(climateAt(grid, 1500, 500).temperature).toBeCloseTo(20, 5);
    expect(climateAt(grid, 0, 0).coolingPerMetre).toBeCloseTo(0.0065, 6);
    expect(climateAt(null, 0, 0)).toBe(TEMPERATE);
  });
});
