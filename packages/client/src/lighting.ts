import * as THREE from 'three';
import type { Atmosphere } from './atmosphere.js';

/** Lighting the player can adjust (see the game's lighting panel), kept in this browser. */
export interface Lighting {
  /** Sun height above the horizon, degrees. */
  sunElevation: number;
  /** Compass direction of the sun, degrees (0 north, 90 east, 180 south). */
  sunAzimuth: number;
  /** Strength of direct sunlight. */
  sunStrength: number;
  /** 0 white sunlight .. 1 golden. */
  sunWarmth: number;
  /** Strength of blue-ish light from the sky (what shaded sides get). */
  skyLight: number;
  /** Strength of warm light bounced up from the ground (undersides). */
  groundLight: number;
  /** How much corners and creases darken, 0 (none) .. 1 (black in the deepest corner). */
  cornerShading: number;
  /** Haze thickness relative to the default; the final fade at the view distance always stays. */
  haze: number;
  /** Overall brightness multiplier, before haze. */
  exposure: number;
}

export const LIGHTING_LIMITS: Record<keyof Lighting, readonly [number, number]> = {
  sunElevation: [2, 90],
  sunAzimuth: [0, 360],
  sunStrength: [0, 2],
  sunWarmth: [0, 1],
  skyLight: [0, 1.5],
  groundLight: [0, 1],
  cornerShading: [0, 1],
  haze: [0, 4],
  exposure: [0.3, 2],
};

export function defaultLighting(): Lighting {
  return {
    sunElevation: 29,
    sunAzimuth: 127,
    sunStrength: 0.9,
    sunWarmth: 0.5,
    skyLight: 0.34,
    groundLight: 0.16,
    cornerShading: 0.6,
    haze: 1,
    exposure: 1,
  };
}

/** Lighting from untrusted data: anything missing, non-numeric or out of range takes its default. */
export function parseLighting(raw: unknown): Lighting {
  const d = defaultLighting();
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...d };
  for (const key of Object.keys(d) as (keyof Lighting)[]) {
    const v = r[key], [lo, hi] = LIGHTING_LIMITS[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[key] = v;
  }
  return out;
}

const KEY = 'super-vox.lighting';

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLighting(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Lighting {
  try {
    const raw = storage?.getItem(KEY);
    return parseLighting(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultLighting();
  }
}

export function saveLighting(l: Lighting, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(parseLighting(l)));
    return true;
  } catch {
    return false;
  }
}

/** Unit vector toward the sun. */
export function sunDirection(l: Lighting): THREE.Vector3 {
  const e = (l.sunElevation * Math.PI) / 180, a = (l.sunAzimuth * Math.PI) / 180;
  // Compass: 0 = north (-Z), 90 = east (+X).
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}

/** Shader uniforms the lighting drives besides the atmosphere's (see createVoxelMaterial). */
export interface LightingUniforms {
  aoStrength: THREE.IUniform<number>;
  exposure: THREE.IUniform<number>;
}

/** Sets the uniforms for `l`; `view` is the view distance (m), which scales the haze. */
export function applyLighting(l: Lighting, atmosphere: Atmosphere, material: LightingUniforms | null, view: number): void {
  const u = atmosphere.uniforms;
  u.sunDir.value.copy(sunDirection(l));
  u.sunColor.value.setRGB(1, 1 - 0.18 * l.sunWarmth, 1 - 0.512 * l.sunWarmth).multiplyScalar(l.sunStrength);
  u.skyAmbient.value.setRGB(0.706, 0.824, 1).multiplyScalar(l.skyLight);
  u.groundAmbient.value.setRGB(1, 0.875, 0.6875).multiplyScalar(l.groundLight);
  // Half the light gone over the view distance at sea level (at haze 1), before the final fade.
  u.hazeDensity.value = (l.haze * Math.LN2) / view;
  if (material) {
    // Up to three occluding cells: 1/3 of the light each at full strength.
    material.aoStrength.value = l.cornerShading / 3;
    material.exposure.value = l.exposure;
  }
}
