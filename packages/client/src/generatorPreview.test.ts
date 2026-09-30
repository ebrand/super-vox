import { describe, expect, it } from 'vitest';
import { PlateHeights, defaultPlateTerrain, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from '@super-vox/shared';
import { buildPreview } from './generatorPreview.js';

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
    expect(pv.stats.maxHeight).toBeLessThanOrEqual(300);
    expect(pv.stats.maxHeight).toBeGreaterThan(250);
    expect(buildPreview({ ...config, minorPlates: 0 }, 32).stats.sizeRatio).toBeNaN();
  });

  it('rejects invalid settings', () => {
    expect(() => buildPreview({ ...config, seaLevel: 400 }, 32)).toThrow(/maxHeight/);
  });
});
