import { describe, expect, it } from 'vitest';
import { BIOME_GROUND, Biome, Material, SHARP, type ClimateGrid } from '@super-vox/shared';
import { materialColor } from './materials.js';
import { LUT_H, LUT_T_MAX, LUT_T_MIN, LUT_W, biomeTintLut, climateTintColors } from './tintColors.js';

/** The LUT entry nearest a climate. */
const lutAt = (lut: Float32Array, t: number, m: number) => {
  const i = Math.round(((t - LUT_T_MIN) / (LUT_T_MAX - LUT_T_MIN)) * (LUT_W - 1)), j = Math.round(m * (LUT_H - 1));
  return Array.from(lut.subarray((i + LUT_W * j) * 4, (i + LUT_W * j) * 4 + 3));
};
const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k]!, 4));

describe('biome tint', () => {
  const e = { degrees: 3, moisture: 0.1 };
  const lut = biomeTintLut(e);

  it('is each biome ground colour deep inside the biome', () => {
    near(lutAt(lut, -25, 0.5), materialColor(BIOME_GROUND[Biome.Ice]));
    near(lutAt(lut, 2.5, 0.7), materialColor(BIOME_GROUND[Biome.Boreal]));
    near(lutAt(lut, 35, 0.9), materialColor(BIOME_GROUND[Biome.Jungle]));
  });

  it('is half and half on a border, and sharp without an ecotone', () => {
    // 7 C (boreal | temperate) is between two LUT columns: interpolate, as the shader does.
    const col = ((7 - LUT_T_MIN) / (LUT_T_MAX - LUT_T_MIN)) * (LUT_W - 1);
    const i0 = Math.floor(col), j = Math.round(0.7 * (LUT_H - 1));
    const f = col - i0;
    const mid = [0, 1, 2].map((c) => lut[(i0 + LUT_W * j) * 4 + c]! * (1 - f) + lut[(i0 + 1 + LUT_W * j) * 4 + c]! * f);
    const boreal = materialColor(Material.TaigaFloor), temperate = materialColor(Material.Grass);
    mid.forEach((v, c) => expect(v).toBeCloseTo((boreal[c]! + temperate[c]!) / 2, 2));
    const sharp = biomeTintLut(SHARP);
    near(lutAt(sharp, 6, 0.7), boreal);
    near(lutAt(sharp, 8, 0.7), temperate);
  });

  it('colours tinted map samples from their climate, colder higher up, and leaves others alone', () => {
    // A uniform 4 x 4 cell climate: 10 C at sea level, wet; cooling 1 C per 10 units.
    const climate: ClimateGrid = {
      cols: 4, rows: 4, cell: 512, seaLevel: 0, cooling: 0.1, ecotone: e,
      temperature: new Float32Array(16).fill(10), moisture: new Float32Array(16).fill(0.7),
    };
    const map = { cols: 2, rows: 2, step: 1024, heights: [0, 80, 300, 0], materials: [Material.Grass, Material.Grass, Material.Grass, Material.Stone] };
    const c = climateTintColors(map, climate, lut);
    const at = (k: number) => Array.from(c.subarray(k * 3, k * 3 + 3));
    near(at(0), lutAt(lut, 10, 0.7)); // temperate
    // 80 units up: 2 C, boreal; 300 units up: -20 C, ice (snow white).
    near(at(1), lutAt(lut, 2, 0.7));
    near(at(1), materialColor(Material.TaigaFloor));
    near(at(2), materialColor(Material.Snow));
    expect(Number.isNaN(at(3)[0]!)).toBe(true);
  });
});
