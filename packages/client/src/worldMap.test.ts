import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Material } from '@super-vox/shared';
import { materialColor } from './materials.js';
import { decodeWorldMap, linearToSrgb, mapColor, renderMap, travelClick, type MapData } from './worldMap.js';

describe('map colours', () => {
  it('converts linear to sRGB like three.js (GPU constants; within rounding of its JS helper)', () => {
    for (const c of [0, 0.001, 0.003, 0.05, 0.18, 0.5, 0.9, 1]) {
      expect(Math.abs(linearToSrgb(c) - new THREE.Color(c, c, c).convertLinearToSRGB().r)).toBeLessThan(2e-5);
    }
  });

  it('lights a flat top face like the voxel shader does', () => {
    const sun = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    const light = 0.55 + 0.45 * sun.y;
    const expected = materialColor(Material.Grass).map((c) => linearToSrgb(c * light));
    mapColor(Material.Grass, [0, 1, 0], false).forEach((c, k) => expect(c).toBeCloseTo(expected[k]!, 10));
  });

  it('blends the sea plane over the sea floor at its opacity', () => {
    const floor = mapColor(Material.Sand, [0, 1, 0], false);
    const wet = mapColor(Material.Sand, [0, 1, 0], true);
    const sea = new THREE.Color(0x2f6d9c).getHexString(); // sRGB hex, as the plane's material colour
    expect(sea).toBe('2f6d9c');
    const seaRgb = [0x2f / 255, 0x6d / 255, 0x9c / 255];
    wet.forEach((c, k) => expect(c).toBeCloseTo(0.6 * seaRgb[k]! + 0.4 * floor[k]!, 10));
  });

  it('shades slopes facing away from the sun darker', () => {
    const facing = mapColor(Material.Grass, [0.6, 0.8, 0], false);
    const away = mapColor(Material.Grass, [-0.6, 0.8, 0], false);
    expect(away[1]).toBeLessThan(facing[1]);
  });
});

describe('world map data', () => {
  const map: MapData = {
    cols: 3, rows: 2, step: 1000, seaLevel: 0,
    heights: Int16Array.of(100, 50, -20, 0, 300, -500),
    materials: Uint8Array.of(Material.Grass, Material.Grass, Material.Sand, Material.Sand, Material.Snow, Material.Sand),
  };

  it('decodes the server format', () => {
    const n = 6;
    const buf = new ArrayBuffer(12 + n * 3);
    const v = new DataView(buf);
    v.setUint16(0, 3, true); v.setUint16(2, 2, true); v.setUint32(4, 1000, true); v.setInt32(8, 0, true);
    map.heights.forEach((h, i) => v.setInt16(12 + i * 2, h, true));
    new Uint8Array(buf, 12 + n * 2).set(map.materials);
    expect(decodeWorldMap(buf)).toEqual(map);
    v.setInt32(8, -(2 ** 31), true);
    expect(decodeWorldMap(buf).seaLevel).toBeNull();
    expect(() => decodeWorldMap(buf.slice(0, 20))).toThrow();
  });

  it('renders one opaque pixel per sample, with water only below sea level', () => {
    const px = renderMap(map);
    expect(px.length).toBe(6 * 4);
    for (let k = 0; k < 6; k++) expect(px[k * 4 + 3]).toBe(255);
    // Sample 2 (sand, below sea) is bluer than sample 3 (sand, at sea level).
    expect(px[2 * 4 + 2]! - px[2 * 4]!).toBeGreaterThan(px[3 * 4 + 2]! - px[3 * 4]!);
  });
});

describe('travelClick', () => {
  it('goes somewhere only with ⌘ (or Ctrl) held', () => {
    expect(travelClick({ metaKey: false, ctrlKey: false })).toBe(false);
    expect(travelClick({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(travelClick({ metaKey: false, ctrlKey: true })).toBe(true);
  });
});
