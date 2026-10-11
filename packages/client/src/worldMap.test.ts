import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Material } from '@super-vox/shared';
import { materialColor } from './materials.js';
import { contourInterval, decodeWorldMap, linearToSrgb, mapColor, renderMap, travelClick, type MapData } from './worldMap.js';

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

  it("decodes the ground's own heights after the rest, when they're sent", () => {
    const n = 6;
    const buf = new ArrayBuffer(12 + n * 5);
    const v = new DataView(buf);
    v.setUint16(0, 3, true); v.setUint16(2, 2, true); v.setUint32(4, 1000, true); v.setInt32(8, 0, true);
    map.heights.forEach((h, i) => v.setInt16(12 + i * 2, h, true));
    new Uint8Array(buf, 12 + n * 2).set(map.materials);
    for (let i = 0; i < n; i++) v.setInt16(12 + n * 3 + i * 2, i * 10, true);
    expect(Array.from(decodeWorldMap(buf).ground!)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('draws contours where the ground crosses each interval (from its own height, not tree tops), not over water', () => {
    // A slope rising a metre a column, 40 columns, 1 m a pixel (contours every metre: every fifth bolder).
    const cols = 40, rows = 3, step = 16;
    const ground = new Int16Array(cols * rows), heights = new Int16Array(cols * rows), materials = new Uint8Array(cols * rows).fill(Material.Grass);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      ground[i + cols * j] = i * 16 + 8;
      // (Trees over column 10: tall, their tops no contour.)
      heights[i + cols * j] = i === 10 ? 400 : i * 16 + 8;
    }
    const slope: MapData = { cols, rows, step, seaLevel: null, heights, materials, ground };
    expect(contourInterval(step)).toBe(1);
    const plain = renderMap(slope), lined = renderMap(slope, true);
    const darker = (i: number) => lined[(i + cols) * 4]! < plain[(i + cols) * 4]!;
    // Every column's on the low side of a crossing (a metre a column): all lined; every fifth darker still.
    expect(Array.from({ length: cols - 1 }, (_, i) => darker(i)).every(Boolean)).toBe(true);
    const shade = (i: number) => lined[(i + cols) * 4]! / plain[(i + cols) * 4]!;
    expect(shade(4)).toBeLessThan(shade(5)); // (column 4 to 5 crosses 5 m: bold)
    // Water: no lines.
    const wet: MapData = { ...slope, materials: new Uint8Array(cols * rows).fill(Material.Water) };
    expect(Array.from(renderMap(wet, true))).toEqual(Array.from(renderMap(wet)));
    // Coarse maps: contours further apart.
    expect([contourInterval(16 * 16), contourInterval(64 * 16)]).toEqual([10, 25]);
    expect(contourInterval(4 * 16)).toBe(5);
  });

  it("tints the land at or over a lake's level red (from the ground's own height), not the water", () => {
    const cols = 4, rows = 1;
    const ground = Int16Array.of(100, 200, 300, 200), heights = Int16Array.of(100, 900, 300, 200);
    const materials = Uint8Array.of(Material.Grass, Material.Grass, Material.Grass, Material.Water);
    const m: MapData = { cols, rows, step: 16, seaLevel: null, heights, materials, ground };
    const plain = renderMap(m), red = renderMap(m, false, 200);
    const tinted = (i: number) => red[i * 4]! > plain[i * 4]! && red[i * 4 + 1]! < plain[i * 4 + 1]!;
    // Under the level: as it is; at it (under trees too) and over it: red; the water itself: as it is.
    expect([0, 1, 2, 3].map(tinted)).toEqual([false, true, true, false]);
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
