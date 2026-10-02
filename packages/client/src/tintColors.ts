import { BIOME_GROUND, biomeWeights, type BiomeId, type ClimateGrid, type Ecotone } from '@super-vox/shared';
import { TINTED, materialColor } from './materials.js';

/**
 * Tint lookup (see biomeTintLut): LUT_W temperatures from LUT_T_MIN to LUT_T_MAX (degrees C)
 * across, LUT_H moistures 0..1 down; the shader samples it the same way.
 */
export const LUT_T_MIN = -40;
export const LUT_T_MAX = 50;
export const LUT_W = 128;
export const LUT_H = 32;

/**
 * Ground colour by climate (linear RGBA, LUT_W x LUT_H, row-major): each biome's ground colour
 * weighted by how much of the ecotone around that climate is in the biome (see biomeWeights).
 */
export function biomeTintLut(ecotone: Ecotone): Float32Array {
  const out = new Float32Array(LUT_W * LUT_H * 4);
  for (let j = 0; j < LUT_H; j++) {
    const m = j / (LUT_H - 1);
    for (let i = 0; i < LUT_W; i++) {
      const t = LUT_T_MIN + ((LUT_T_MAX - LUT_T_MIN) * i) / (LUT_W - 1);
      const w = biomeWeights(t, m, ecotone);
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < 8; k++) {
        if (w[k]! === 0) continue;
        const c = materialColor(BIOME_GROUND[k as BiomeId]);
        r += w[k]! * c[0];
        g += w[k]! * c[1];
        b += w[k]! * c[2];
      }
      out.set([r, g, b, 1], (i + LUT_W * j) * 4);
    }
  }
  return out;
}

/** Bilinear sample of a row-major field (cols x rows) at fractional cell coordinates (cell centres at integers). */
function bilinear(field: ArrayLike<number>, cols: number, rows: number, fx: number, fy: number, stride = 1, offset = 0): number {
  const x = Math.max(0, Math.min(cols - 1, fx)), y = Math.max(0, Math.min(rows - 1, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const at = (c: number, r: number) => field[(c + cols * r) * stride + offset]!;
  const a = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
  const b = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
  return a + (b - a) * ty;
}

/**
 * Blended ground colours for map samples (linear RGB triples; NaN where the material isn't
 * tinted), as the game's shader colours them (see voxelMaterial).
 */
export function climateTintColors(
  map: { cols: number; rows: number; step: number; heights: ArrayLike<number>; materials: ArrayLike<number>; x0?: number; z0?: number },
  climate: ClimateGrid,
  lut: Float32Array = biomeTintLut(climate.ecotone),
): Float32Array {
  const out = new Float32Array(map.cols * map.rows * 3).fill(NaN);
  for (let j = 0; j < map.rows; j++) {
    for (let i = 0; i < map.cols; i++) {
      const k = i + map.cols * j;
      if (!TINTED.has(map.materials[k]!)) continue;
      const fx = ((map.x0 ?? 0) + (i + 0.5) * map.step) / climate.cell - 0.5, fy = ((map.z0 ?? 0) + (j + 0.5) * map.step) / climate.cell - 0.5;
      const t = bilinear(climate.temperature, climate.cols, climate.rows, fx, fy) - climate.cooling * Math.max(0, map.heights[k]! - climate.seaLevel);
      const m = bilinear(climate.moisture, climate.cols, climate.rows, fx, fy);
      const lx = (Math.max(0, Math.min(1, (t - LUT_T_MIN) / (LUT_T_MAX - LUT_T_MIN)))) * (LUT_W - 1);
      const ly = Math.max(0, Math.min(1, m)) * (LUT_H - 1);
      for (let c = 0; c < 3; c++) out[k * 3 + c] = bilinear(lut, LUT_W, LUT_H, lx, ly, 4, c);
    }
  }
  return out;
}
