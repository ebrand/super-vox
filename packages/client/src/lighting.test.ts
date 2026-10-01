import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAtmosphere } from './atmosphere.js';
import { LIGHTING_LIMITS, applyLighting, defaultLighting, loadLighting, parseLighting, saveLighting, sunDirection } from './lighting.js';

const at = (hours: number, over = {}) => {
  const a = createAtmosphere(2000), m = { aoStrength: { value: 0 }, exposure: { value: 0 } };
  applyLighting({ ...defaultLighting(), ...over }, hours, a, m, 2000);
  return { u: a.uniforms, m };
};
const lum = (c: THREE.Color) => c.r + c.g + c.b;
const round = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x * 1000) / 1000 + 0);

describe('lighting through the day', () => {
  it('moves the sun east to south (at the noon height) to west, and below the horizon at night', () => {
    const l = defaultLighting();
    const flat = { ...l, noonSunDirection: 180 };
    expect(round(sunDirection(flat, 6))).toEqual([1, 0, 0]); // rises east
    expect(round(sunDirection(flat, 18))).toEqual([-1, 0, 0]); // sets west
    const noon = sunDirection(flat, 12);
    expect(noon.z).toBeGreaterThan(0); // south
    expect(Math.asin(noon.y) * (180 / Math.PI)).toBeCloseTo(l.noonSunHeight, 6);
    expect(sunDirection(flat, 0).y).toBeLessThan(-0.5); // midnight: well below
    expect(sunDirection(flat, 9).y).toBeGreaterThan(0);
    expect(sunDirection(flat, 9).y).toBeLessThan(noon.y);
  });

  it('is bright by day, glows orange at sunset, and is dark, blue and starry at night', () => {
    const noon = at(12), dusk = at(18.1), night = at(0);
    expect(noon.u.stars.value).toBe(0);
    expect(night.u.stars.value).toBe(1);
    // At night the light comes from the moon, opposite the sun, much dimmer and bluer.
    expect(night.u.sunDir.value.y).toBeGreaterThan(0.5);
    expect(lum(night.u.sunColor.value)).toBeLessThan(lum(noon.u.sunColor.value) * 0.2);
    expect(night.u.sunColor.value.b).toBeGreaterThan(night.u.sunColor.value.r);
    expect(lum(night.u.skyAmbient.value)).toBeLessThan(lum(noon.u.skyAmbient.value) * 0.3);
    expect(lum(night.u.horizonColor.value)).toBeLessThan(lum(noon.u.horizonColor.value) * 0.25);
    // Sunset: an orange glow, redder than the midday glow.
    const g = dusk.u.glowColor.value, gn = noon.u.glowColor.value;
    expect(g.r / Math.max(g.b, 1e-6)).toBeGreaterThan(gn.r / gn.b * 1.5);
    // The low sun before sunset is redder than at noon.
    const late = at(17.3).u.sunColor.value, mid = noon.u.sunColor.value;
    expect(late.b / late.r).toBeLessThan(mid.b / mid.r);
  });

  it('applies the panel settings by day', () => {
    const { u, m } = at(12, { haze: 2, sunWarmth: 0, cornerShading: 0.6, exposure: 1.4 });
    expect(u.hazeDensity.value).toBeCloseTo((2 * Math.LN2) / 2000, 9);
    expect(u.sunColor.value.r).toBeCloseTo(u.sunColor.value.g, 6); // white sun
    expect(m.aoStrength.value).toBeCloseTo(0.2, 9);
    expect(m.exposure.value).toBe(1.4);
  });
});

describe('lighting settings', () => {
  it('parses untrusted data, keeping valid values and defaulting the rest', () => {
    const d = defaultLighting();
    expect(parseLighting(null)).toEqual(d);
    expect(parseLighting({ exposure: 1.5, haze: 99, noonSunDirection: 'x', junk: 1 })).toEqual({ ...d, exposure: 1.5 });
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
