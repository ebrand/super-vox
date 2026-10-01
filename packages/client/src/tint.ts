import * as THREE from 'three';
import { UNITS_PER_METER, type ClimateGrid } from '@super-vox/shared';
import { LUT_H, LUT_W, biomeTintLut } from './tintColors.js';
import type { Tint } from './voxelMaterial.js';

/** The tint for a world's climate (decoded from /api/world/climate). */
export function createTint(c: ClimateGrid & { cells: Uint8Array }, wrapX: boolean): Tint {
  const climate = new THREE.DataTexture(Uint8Array.from(c.cells), c.cols, c.rows, THREE.RGFormat, THREE.UnsignedByteType);
  climate.unpackAlignment = 1;
  climate.magFilter = climate.minFilter = THREE.LinearFilter;
  climate.wrapS = wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  climate.wrapT = THREE.ClampToEdgeWrapping;
  climate.needsUpdate = true;
  const lutData = biomeTintLut(c.ecotone);
  const half = new Uint16Array(lutData.length);
  for (let i = 0; i < lutData.length; i++) half[i] = THREE.DataUtils.toHalfFloat(lutData[i]!);
  const lut = new THREE.DataTexture(half, LUT_W, LUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
  lut.magFilter = lut.minFilter = THREE.LinearFilter;
  lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.needsUpdate = true;
  return {
    climate,
    lut,
    extent: new THREE.Vector2((c.cols * c.cell) / UNITS_PER_METER, (c.rows * c.cell) / UNITS_PER_METER),
    seaLevelM: c.seaLevel / UNITS_PER_METER,
    coolingPerM: c.cooling * UNITS_PER_METER,
  };
}
