import * as THREE from 'three';
import type { Atmosphere } from './atmosphere.js';

/** Lighting the player can adjust (see the game's lighting panel), kept in this browser. */
export interface Lighting {
  /** Sun height above the horizon at noon, degrees. */
  noonSunHeight: number;
  /** Compass direction of the noon sun, degrees (0 north, 90 east, 180 south); it rises 90 degrees to its left. */
  noonSunDirection: number;
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
  noonSunHeight: [5, 90],
  noonSunDirection: [0, 360],
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
    noonSunHeight: 45,
    noonSunDirection: 165,
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

/**
 * Unit vector toward the sun at a time of day (hours): it rises 90 degrees left of the noon
 * direction at 6:00, crosses it at noonSunHeight at 12:00, and sets opposite where it rose at
 * 18:00, passing below the horizon at night.
 */
export function sunDirection(l: Lighting, hours: number): THREE.Vector3 {
  const theta = ((hours - 6) / 24) * Math.PI * 2; // 0 at sunrise, pi/2 at noon
  const e = (l.noonSunHeight * Math.PI) / 180, a = (l.noonSunDirection * Math.PI) / 180;
  // Compass: 0 = north (-Z), 90 = east (+X). `noon` is the noon direction on the ground; `rise`
  // is 90 degrees to its left (east, for a southern noon sun).
  const noon = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
  const rise = new THREE.Vector3(-noon.z, 0, noon.x).negate();
  const high = noon.clone().multiplyScalar(Math.cos(e)).add(new THREE.Vector3(0, Math.sin(e), 0));
  return rise.multiplyScalar(Math.cos(theta)).add(high.multiplyScalar(Math.sin(theta))).normalize();
}

/** Shader uniforms the lighting drives besides the atmosphere's (see createVoxelMaterial). */
export interface LightingUniforms {
  aoStrength: THREE.IUniform<number>;
  exposure: THREE.IUniform<number>;
}

const DAY = { horizon: new THREE.Color(0x9fb8cf), zenith: new THREE.Color(0x4f7fb3), glow: new THREE.Color(0xf2dcb4) };
const DUSK = { horizon: new THREE.Color(0xd99a78), zenith: new THREE.Color(0x3b5580), glow: new THREE.Color(1.0, 0.5, 0.22) };
const NIGHT = { horizon: new THREE.Color(0x0e1828), zenith: new THREE.Color(0x03070f), glow: new THREE.Color(0x1a2233) };
const MOON_LIGHT = new THREE.Color(0.5, 0.6, 0.85).multiplyScalar(0.16);
const NIGHT_SKY = new THREE.Color(0.035, 0.05, 0.1);
const NIGHT_GROUND = new THREE.Color(0.012, 0.012, 0.018);
const SUNSET_TINT = new THREE.Color(1.0, 0.5, 0.25);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Sets the uniforms for lighting `l` at a time of day (`hours`); `view` is the view distance (m),
 * which scales the haze. By day the sun lights the world (redder near the horizon); around
 * sunrise and sunset the sky glows orange; at night the moon (opposite the sun) gives a dim blue
 * light, the sky turns dark, and stars come out.
 */
export function applyLighting(l: Lighting, hours: number, atmosphere: Atmosphere, material: LightingUniforms | null, view: number): void {
  const u = atmosphere.uniforms;
  const sun = sunDirection(l, hours);
  const s = sun.y;
  const day = smoothstep(-0.05, 0.2, s);
  const dusk = smoothstep(-0.25, 0.0, s) * (1 - smoothstep(0.0, 0.3, s));
  // One light: the sun while it's up, the moon (opposite) after; each fades to nothing at the horizon.
  const warm = new THREE.Color(1, 1 - 0.18 * l.sunWarmth, 1 - 0.512 * l.sunWarmth).lerp(SUNSET_TINT, 0.7 * (1 - smoothstep(0.0, 0.35, s)));
  if (s >= 0) {
    u.sunDir.value.copy(sun);
    u.sunColor.value.copy(warm).multiplyScalar(l.sunStrength * smoothstep(0.0, 0.08, s));
    u.discColor.value.setRGB(1, 0.97, 0.9);
  } else {
    u.sunDir.value.copy(sun).negate();
    u.sunColor.value.copy(MOON_LIGHT).multiplyScalar(smoothstep(0.0, 0.15, -s));
    u.discColor.value.setRGB(0.8, 0.82, 0.86);
  }
  u.skyAmbient.value.copy(NIGHT_SKY).lerp(new THREE.Color(0.706, 0.824, 1).multiplyScalar(l.skyLight), day);
  u.groundAmbient.value.copy(NIGHT_GROUND).lerp(new THREE.Color(1, 0.875, 0.6875).multiplyScalar(l.groundLight), day);
  for (const [key, target] of [['horizonColor', 'horizon'], ['zenithColor', 'zenith'], ['glowColor', 'glow']] as const) {
    u[key].value.copy(NIGHT[target]).lerp(DAY[target], day).lerp(DUSK[target], dusk);
  }
  u.stars.value = 1 - smoothstep(-0.2, -0.02, s);
  // Half the light gone over the view distance at sea level (at haze 1), before the final fade.
  u.hazeDensity.value = (l.haze * Math.LN2) / view;
  if (material) {
    // Up to three occluding cells: 1/3 of the light each at full strength.
    material.aoStrength.value = l.cornerShading / 3;
    material.exposure.value = l.exposure;
  }
}
