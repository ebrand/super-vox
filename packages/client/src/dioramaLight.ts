import * as THREE from 'three';

/**
 * The diorama's light: a sun at `height` degrees above the horizon, shining from `from` (compass
 * degrees: 0 north, 90 east), `warmth` 0 (white) .. 1 (golden, as the game's lighting warms it),
 * and `shade` 0 .. 1: how much light the sides facing away from the sun get (sky and ground light;
 * 0.5 is the game's).
 */
export interface DioramaLight {
  height: number;
  from: number;
  warmth: number;
  shade: number;
}

/** A late-afternoon sun from the south-west: low and warm, so slopes and walls shade deeply. */
export const DEFAULT_DIORAMA_LIGHT: DioramaLight = { height: 22, from: 225, warmth: 0.7, shade: 0.35 };

export const DIORAMA_LIGHT_LIMITS = { height: [3, 90], from: [0, 360], warmth: [0, 1], shade: [0, 1] } as const;

// The game's sky and ground light (see createAtmosphere), at shade 0.5.
const SKY = new THREE.Color(0.24, 0.28, 0.34);
const GROUND = new THREE.Color(0.16, 0.14, 0.11);

/** The shader inputs for a light: sun direction (toward the sun) and colour, sky and ground light. */
export function dioramaLighting(l: DioramaLight): { sunDir: THREE.Vector3; sunColor: THREE.Color; sky: THREE.Color; ground: THREE.Color } {
  const e = (l.height * Math.PI) / 180, a = (l.from * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
  // As the game's sun warms (lighting.ts), a touch stronger to make up for the low angle.
  const sunColor = new THREE.Color(1, 1 - 0.18 * l.warmth, 1 - 0.512 * l.warmth).multiplyScalar(1.1);
  const k = 2 * l.shade;
  return { sunDir, sunColor, sky: SKY.clone().multiplyScalar(k), ground: GROUND.clone().multiplyScalar(k) };
}

/** A light from stored or typed settings: anything missing or out of range takes the default. */
export function parseDioramaLight(raw: unknown): DioramaLight {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_DIORAMA_LIGHT };
  for (const k of Object.keys(out) as (keyof DioramaLight)[]) {
    const v = r[k], [lo, hi] = DIORAMA_LIGHT_LIMITS[k];
    if (typeof v === 'number' && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}
