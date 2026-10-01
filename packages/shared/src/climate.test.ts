import { describe, expect, it } from 'vitest';
import { byteTemperature, decodeClimate, encodeClimate, temperatureByte, type ClimateGrid } from './climate.js';
import { PLATE_CELL, PlateHeights, defaultPlateTerrain } from './plates.js';
import { FLAT_WORLD_16KM } from './world.js';

describe('climate grid', () => {
  it('round-trips through the codec to half a degree and 1/255 of moisture', () => {
    const n = 6 * 4;
    const c: ClimateGrid = {
      cols: 6, rows: 4, cell: 512, seaLevel: -32, cooling: 0.0009375, ecotone: { degrees: 3, moisture: 0.1 },
      temperature: Float32Array.from({ length: n }, (_, i) => -30 + i * 2.7),
      moisture: Float32Array.from({ length: n }, (_, i) => i / (n - 1)),
    };
    const back = decodeClimate(encodeClimate(c));
    expect(back).toMatchObject({ cols: 6, rows: 4, cell: 512, seaLevel: -32 });
    expect(back.cooling).toBeCloseTo(c.cooling, 9);
    expect(back.ecotone.degrees).toBeCloseTo(3, 6);
    expect(back.ecotone.moisture).toBeCloseTo(0.1, 6);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(back.temperature[i]! - c.temperature[i]!)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(back.moisture[i]! - c.moisture[i]!)).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    }
    expect(back.cells.length).toBe(2 * n);
    expect(byteTemperature(temperatureByte(-100))).toBe(-64);
    expect(byteTemperature(temperatureByte(100))).toBe(63.5);
  });

  it('rejects truncated data', () => {
    const bytes = encodeClimate({ cols: 2, rows: 2, cell: 512, seaLevel: 0, cooling: 0, ecotone: { degrees: 1, moisture: 0 }, temperature: new Float32Array(4), moisture: new Float32Array(4) });
    expect(() => decodeClimate(bytes.subarray(0, bytes.length - 1))).toThrow(RangeError);
    expect(() => decodeClimate(bytes.subarray(0, 10))).toThrow(RangeError);
  });

  it('comes from plate worlds whose biomes blend, and not otherwise', () => {
    const p = new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(2), mountains: 0 });
    const c = p.climate()!;
    expect(c).not.toBeNull();
    expect(c).toMatchObject({ cols: p.cols, rows: p.rows, cell: PLATE_CELL, seaLevel: p.seaLevel });
    expect(c.temperature.length).toBe(p.cols * p.rows);
    expect(c.ecotone.degrees).toBeGreaterThan(0);
    expect(new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(2), mountains: 0, biomeBlend: 0 }).climate()).toBeNull();
    expect(new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(2), mountains: 0, biomes: 0 }).climate()).toBeNull();
  });
});
