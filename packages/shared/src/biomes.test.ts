import { describe, expect, it } from 'vitest';
import { BIOME_GROUND, BIOME_NAMES, Biome, SHARP, biomeWeights, blendedBiome, classifyBiome, sameBiome } from './biomes.js';

describe('classifyBiome', () => {
  it('follows temperature and moisture (Whittaker)', () => {
    expect(classifyBiome(-20, 0.5)).toBe(Biome.Ice);
    expect(classifyBiome(-4, 0.9)).toBe(Biome.Tundra);
    expect(classifyBiome(3, 0.6)).toBe(Biome.Boreal);
    expect(classifyBiome(3, 0.1)).toBe(Biome.Tundra); // cold and dry
    expect(classifyBiome(12, 0.7)).toBe(Biome.Temperate);
    expect(classifyBiome(12, 0.2)).toBe(Biome.Grassland);
    expect(classifyBiome(17, 0.05)).toBe(Biome.Desert); // warm and very dry
    expect(classifyBiome(25, 0.8)).toBe(Biome.Jungle);
    expect(classifyBiome(25, 0.35)).toBe(Biome.Savanna);
    expect(classifyBiome(25, 0.1)).toBe(Biome.Desert);
  });

  it('names every biome and gives it a ground', () => {
    for (const b of Object.values(Biome)) {
      expect(BIOME_NAMES[b]).toBeTruthy();
      expect(BIOME_GROUND[b]).toBeGreaterThan(0);
    }
  });
});

describe('biome blending', () => {
  it('sameBiome is true exactly when every climate in the box has one biome', () => {
    let rnd = 7;
    const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 3000; n++) {
      const t = -20 + 50 * r(), m = r(), dt = 6 * r(), dm = 0.2 * r();
      const seen = new Set<number>();
      for (let a = 0; a <= 1.0001; a += 0.02) for (let b = 0; b <= 1.0001; b += 0.02) seen.add(classifyBiome(t + a * dt, m + b * dm));
      // The grid can miss a thin sliver of another biome, never invent one.
      if (seen.size > 1) expect(sameBiome(t, t + dt, m, m + dm)).toBe(false);
      if (sameBiome(t, t + dt, m, m + dm)) expect(seen.size).toBe(1);
    }
    // Edges themselves count: [6, 7] reaches temperate at 7.
    expect(sameBiome(6, 7, 0.6, 0.6)).toBe(false);
    expect(sameBiome(6, 6.9, 0.6, 0.6)).toBe(true);
  });

  it('weights sum to 1, are one biome when sharp, and split evenly on a border', () => {
    const sum = (w: Float64Array) => w.reduce((a, b) => a + b, 0);
    const e = { degrees: 3, moisture: 0.1 };
    for (const [t, m] of [[-20, 0.5], [3, 0.6], [7, 0.6], [12, 0.4], [25, 0.2]] as const) expect(sum(biomeWeights(t, m, e))).toBeCloseTo(1, 9);
    const sharp = biomeWeights(3, 0.6, SHARP);
    expect(sharp[Biome.Boreal]).toBeCloseTo(1, 9);
    // On the boreal/temperate line (7 C), half and half; a degree into boreal, mostly boreal.
    const edge = biomeWeights(7, 0.7, e);
    expect(edge[Biome.Boreal]).toBeCloseTo(0.5, 1);
    expect(edge[Biome.Temperate]).toBeCloseTo(0.5, 1);
    const inside = biomeWeights(6, 0.7, e);
    expect(inside[Biome.Boreal]).toBeGreaterThan(0.6);
    expect(inside[Biome.Boreal]).toBeLessThan(0.95);
    // Beyond the ecotone, only one biome.
    expect(biomeWeights(3, 0.7, e)[Biome.Boreal]).toBeCloseTo(1, 9);
  });

  it('blendedBiome is classifyBiome when sharp, and picks by the weights when not', () => {
    for (const [t, m] of [[3, 0.6], [7, 0.6], [25, 0.2]] as const) expect(blendedBiome(t, m, SHARP, 0.9, 0.9, 0.1, 0.3)).toBe(classifyBiome(t, m));
    const e = { degrees: 3, moisture: 0.1 };
    let boreal = 0, n = 0;
    for (let a = 0.05; a < 1; a += 0.1) for (let b = 0.05; b < 1; b += 0.1) for (let c = 0.25; c < 1; c += 0.5) {
      n++;
      if (blendedBiome(6, 0.7, e, a, b, c, c) === Biome.Boreal) boreal++;
    }
    expect(boreal / n).toBeCloseTo(biomeWeights(6, 0.7, e)[Biome.Boreal]!, 1);
  });
});
