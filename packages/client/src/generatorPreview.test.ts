import { describe, expect, it } from 'vitest';
import { PlateHeights, PlateStageCache, defaultPlateTerrain, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from '@super-vox/shared';
import { buildPreview, previewSteps } from './generatorPreview.js';
import { TINTED } from './materials.js';

describe('buildPreview', () => {
  const config = { ...defaultPlateTerrain(3), landPercent: 40 };
  const pv = buildPreview(config, 128);

  it('samples the whole world at the requested width', () => {
    expect([pv.map.cols, pv.map.rows, pv.map.step]).toEqual([128, 128, 2000]);
    expect(pv.map.heights).toHaveLength(128 * 128);
    expect(pv.map.materials).toHaveLength(128 * 128);
    expect(pv.plateOf).toHaveLength(128 * 128);
    expect(pv.map.seaLevel).toBe(0);
    // A 16 x 8 km world is half as tall.
    expect(buildPreview(config, 64, ROUND_WORLD_16x8KM).map.rows).toBe(32);
  });

  it('shows exactly the terrain the server would generate', () => {
    const p = new PlateHeights(FLAT_WORLD_16KM, config);
    for (const [i, j] of [[0, 0], [17, 90], [127, 127], [64, 3]] as const) {
      const x = (i + 0.5) * 2000, z = (j + 0.5) * 2000;
      expect(pv.map.heights[i + 128 * j]).toBe(p.heights(x, z, 1, 1)[0]);
      expect(pv.plateOf[i + 128 * j]).toBe(p.plateAt(x, z));
    }
  });

  it('reports plate counts, land share, height range and size ratio', () => {
    expect(pv.plates).toHaveLength(config.majorPlates + config.minorPlates);
    expect(pv.stats).toMatchObject({ majors: 7, minors: 15 });
    expect(pv.stats.land).toBeCloseTo(0.4, 2);
    expect(pv.stats.sizeRatio).toBeCloseTo(6, 0);
    expect(pv.stats.minHeight).toBeGreaterThanOrEqual(-300);
    // Mountains (on by default) rise above the 300 m hills, up to the 600 m mountain height.
    expect(pv.stats.maxHeight).toBeLessThanOrEqual(600);
    expect(pv.stats.maxHeight).toBeGreaterThan(350);
    expect(buildPreview({ ...config, minorPlates: 0 }, 32).stats.sizeRatio).toBeNaN();
    expect(pv.stats.islands).toEqual({ arc: 0, hotspot: 0, land: 0 });
    expect(pv.stats.ranges).toBeGreaterThan(0);
    // Biomes (on by default): one per sample, shares of the land adding up to 1.
    expect(pv.biome).toHaveLength(128 * 128);
    expect(pv.stats.biomes!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const noBiomes = buildPreview({ ...config, biomes: 0 }, 32);
    expect(noBiomes.biome).toBeNull();
    expect(noBiomes.stats.biomes).toBeNull();
    expect(buildPreview({ ...config, mountains: 0 }, 32).stats.ranges).toBe(0);
    const withIslands = buildPreview({ ...config, islandArcs: 80, hotspots: 10 }, 32).stats;
    expect(withIslands.islands.arc).toBeGreaterThan(0);
    expect(withIslands.islands.hotspot).toBeGreaterThan(0);
    expect(withIslands.islands.land).toBeGreaterThan(0);
    expect(withIslands.land).toBeCloseTo(0.4, 2);
  });

  it('blends ground colours between biomes as the game does, and not with sharp borders', () => {
    const colors = pv.map.colors!;
    expect(colors).toHaveLength(128 * 128 * 3);
    let tinted = 0;
    for (let k = 0; k < 128 * 128; k++) {
      // Only vegetated or desert ground is tinted; sea floor, beaches, rock and treetops aren't.
      if (TINTED.has(pv.map.materials[k]!)) {
        tinted++;
        expect(Number.isNaN(colors[k * 3]!)).toBe(false);
      } else expect(Number.isNaN(colors[k * 3]!)).toBe(true);
    }
    expect(tinted).toBeGreaterThan(100);
    expect(buildPreview({ ...config, biomeBlend: 0 }, 32).map.colors).toBeUndefined();
  });

  it('rejects invalid settings', () => {
    expect(() => buildPreview({ ...config, seaLevel: 400 }, 32)).toThrow(/maxHeight/);
  });
});

describe('previewSteps', () => {
  it('pauses between steps and, with a stage cache, builds the same preview as buildPreview', () => {
    const cache = new PlateStageCache();
    const config = { ...defaultPlateTerrain(4), landPercent: 35 };
    const run = (c: typeof config) => {
      const steps = previewSteps(c, 64, FLAT_WORLD_16KM, cache);
      let pauses = 0;
      for (;;) {
        const r = steps.next();
        if (r.done) return { pauses, preview: r.value };
        pauses++;
      }
    };
    const first = run(config);
    expect(first.pauses).toBeGreaterThanOrEqual(5);
    const strip = (pv: ReturnType<typeof buildPreview>) => ({ ...pv, stats: { ...pv.stats, ms: 0 } });
    expect(strip(first.preview)).toEqual(strip(buildPreview(config, 64)));
    // A change to the snow line only: every plate stage reused, same as a fresh build.
    const hits = cache.hits;
    const snow = run({ ...config, snowAltitude: 100 });
    expect(cache.hits - hits).toBe(8);
    expect(strip(snow.preview)).toEqual(strip(buildPreview({ ...config, snowAltitude: 100 }, 64)));
    // Pausing after each new plate stage: one more pause per stage made, and the same preview.
    cache.pauseAfterEach = true;
    const paused = run({ ...config, landPercent: 45 });
    expect(paused.pauses - first.pauses).toBe(6); // all but the layout and relief stages redone
    expect(strip(paused.preview)).toEqual(strip(buildPreview({ ...config, landPercent: 45 }, 64)));
  });
});
