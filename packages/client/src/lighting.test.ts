import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAtmosphere } from './atmosphere.js';
import { LIGHTING_LIMITS, applyLighting, defaultLighting, loadLighting, parseLighting, saveLighting, sunDirection } from './lighting.js';

describe('lighting', () => {
  it('defaults to the tuned look', () => {
    const a = createAtmosphere(2000), m = { aoStrength: { value: 0 }, exposure: { value: 0 } };
    applyLighting(defaultLighting(), a, m, 2000);
    const u = a.uniforms;
    // Sun about 29 degrees up toward the south-east.
    const sun = new THREE.Vector3(0.6, 0.42, 0.45).normalize();
    expect(u.sunDir.value.distanceTo(sun)).toBeLessThan(0.01);
    const near = (c: THREE.Color, rgb: number[]) => [c.r, c.g, c.b].forEach((v, k) => expect(v).toBeCloseTo(rgb[k]!, 2));
    near(u.sunColor.value, [0.9, 0.82, 0.67]);
    near(u.skyAmbient.value, [0.24, 0.28, 0.34]);
    near(u.groundAmbient.value, [0.16, 0.14, 0.11]);
    expect(u.hazeDensity.value).toBeCloseTo(Math.LN2 / 2000, 9);
    expect(m.aoStrength.value).toBeCloseTo(0.2, 9);
    expect(m.exposure.value).toBe(1);
  });

  it('points the sun by compass direction and height', () => {
    const dir = (sunAzimuth: number, sunElevation: number) => sunDirection({ ...defaultLighting(), sunAzimuth, sunElevation }).toArray().map((v) => Math.round(v * 1000) / 1000 + 0);
    expect(dir(0, 0)).toEqual([0, 0, -1]); // north
    expect(dir(90, 0)).toEqual([1, 0, 0]); // east
    expect(dir(180, 0)).toEqual([0, 0, 1]); // south
    expect(dir(45, 90)).toEqual([0, 1, 0]); // overhead
  });

  it('scales haze, strength and warmth', () => {
    const a = createAtmosphere(4000);
    applyLighting({ ...defaultLighting(), haze: 2, sunStrength: 1, sunWarmth: 0 }, a, null, 4000);
    expect(a.uniforms.hazeDensity.value).toBeCloseTo((2 * Math.LN2) / 4000, 9);
    expect(a.uniforms.sunColor.value.toArray()).toEqual([1, 1, 1]);
  });

  it('parses untrusted data, keeping valid values and defaulting the rest', () => {
    const d = defaultLighting();
    expect(parseLighting(null)).toEqual(d);
    expect(parseLighting({ exposure: 1.5, haze: 99, sunAzimuth: 'x', junk: 1 })).toEqual({ ...d, exposure: 1.5 });
    for (const [key, [lo, hi]] of Object.entries(LIGHTING_LIMITS)) {
      expect(parseLighting({ [key]: lo })[key as keyof typeof d]).toBe(lo);
      expect(parseLighting({ [key]: hi + 1 })[key as keyof typeof d]).toBe(d[key as keyof typeof d]);
    }
  });

  it('saves and loads, surviving broken storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(saveLighting({ ...defaultLighting(), sunStrength: 1.4 }, storage)).toBe(true);
    expect(loadLighting(storage).sunStrength).toBe(1.4);
    store.set('super-vox.lighting', '{not json');
    expect(loadLighting(storage)).toEqual(defaultLighting());
    expect(saveLighting(defaultLighting(), { setItem: () => { throw new Error('full'); } })).toBe(false);
    expect(loadLighting(null)).toEqual(defaultLighting());
  });
});
