import { describe, expect, it } from 'vitest';
import { BIOME_GROUND, BIOME_NAMES, Biome, classifyBiome } from './biomes.js';

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
