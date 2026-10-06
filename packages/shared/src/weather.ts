import type { ClimateGrid } from './climate.js';
import { fractalAt, hash2, type Octave } from './noise.js';

/**
 * Weather: worked out, not stored. A world's weather anywhere at any moment follows from its seed
 * (see weatherSeed), the time (the server's: every player and the server see the same weather)
 * and the climate there (its ClimateGrid: temperature at sea level, how fast it cools going up, and
 * moisture). Weather systems are cloud fields drifting on the world's prevailing wind and changing
 * shape as they go; how much of the sky they cover, and whether rain falls, follow how wet the
 * climate is (deserts rarely see either), and what falls follows the temperature there: snow where
 * it's freezing, up mountains too. Warm, heavy rain brings thunderstorms. Fog gathers on wet
 * mornings, in rain and after it, thickest low down. Look and sound only, for now: nothing in the
 * world changes with it.
 *
 * Distances in metres, temperatures in degrees C, times in seconds (see weatherTime).
 */

/** What the weather is at a place and moment (each 0..1, but wind in m/s). */
export interface Weather {
  /** How much of the sky is cloud. */
  cover: number;
  /** How hard it's raining or snowing. */
  precipitation: number;
  /** Of that, how much is snow (the rest rain). */
  snow: number;
  /** How stormy: thunder and lightning where it's high. */
  storm: number;
  /** How thick the fog is near the ground. */
  fog: number;
  /** Where the weather's going: the wind (m/s, x east and z south). */
  wind: { x: number; z: number };
  /** The air's temperature there (C). */
  temperature: number;
}

/** The climate at a place (see climateAt): sea-level temperature (C), moisture (0..1), and cooling with height (C per metre). */
export interface PlaceClimate {
  temperature: number;
  moisture: number;
  coolingPerMetre: number;
  /** The sea's height (m), heights are measured from. */
  seaLevel: number;
}

/** A world without a climate grid (no biomes): mild and middling wet, cooling as the standard atmosphere does. */
export const TEMPERATE: PlaceClimate = { temperature: 12, moisture: 0.5, coolingPerMetre: 0.0065, seaLevel: 0 };

const UNITS_PER_METRE = 16;

/** The climate at (x, z) (m), from a world's grid (bilinear, clamped at its edges); TEMPERATE without one. */
export function climateAt(grid: ClimateGrid | null, x: number, z: number): PlaceClimate {
  if (!grid) return TEMPERATE;
  const cellM = grid.cell / UNITS_PER_METRE;
  const fx = x / cellM - 0.5, fz = z / cellM - 0.5;
  const c0 = Math.floor(fx), r0 = Math.floor(fz), tx = fx - c0, tz = fz - r0;
  const at = (field: Float32Array, c: number, r: number) => field[Math.max(0, Math.min(grid.cols - 1, c)) + grid.cols * Math.max(0, Math.min(grid.rows - 1, r))]!;
  const lerp = (field: Float32Array) => {
    const a = at(field, c0, r0) + (at(field, c0 + 1, r0) - at(field, c0, r0)) * tx;
    const b = at(field, c0, r0 + 1) + (at(field, c0 + 1, r0 + 1) - at(field, c0, r0 + 1)) * tx;
    return a + (b - a) * tz;
  };
  return { temperature: lerp(grid.temperature), moisture: lerp(grid.moisture), coolingPerMetre: grid.cooling * UNITS_PER_METRE, seaLevel: grid.seaLevel / UNITS_PER_METRE };
}

/** A world's weather seed, from its name (the same on the server and every client). */
export function weatherSeed(world: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < world.length; i++) h = Math.imul(h ^ world.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Weather time (s) at server time `ms` (epoch ms): from the start of 2026, so distances drifted stay modest. */
export function weatherTime(ms: number): number {
  return (ms - Date.UTC(2026, 0, 1)) / 1000;
}

/** How fast weather systems drift (m/s) on the prevailing wind. */
export const WIND_SPEED = 15;
/** How long one shape of the cloud field lasts before it has become the next (s). */
const EVOLVE = 3600;

/** The prevailing wind (m/s): each world its own direction. */
export function prevailingWind(seed: number): { x: number; z: number } {
  const a = hash2(seed, 7, 1) * Math.PI * 2;
  return { x: Math.cos(a) * WIND_SPEED, z: Math.sin(a) * WIND_SPEED };
}

const octaves = (seed: number, spacings: readonly number[]): Octave[] =>
  spacings.map((spacing, i) => ({ spacing, weight: 1 / (i + 1.4), periodX: 0, seed: (seed + i * 101) | 0 }));
const sum = (os: readonly Octave[]) => os.reduce((a, o) => a + o.weight, 0);

/** Cloud field noise at (x, z) of shape `k` (0..1, mostly 0.3..0.7). */
function cloudNoise(seed: number, k: number, x: number, z: number): number {
  const os = octaves((seed ^ Math.imul(k, 0x9e3779b1)) | 0, [9000, 3500, 1300]);
  return 0.5 + fractalAt(os, x, z) / sum(os);
}

/** Where the storms gather (0..1): larger, slower than the clouds. */
function stormNoise(seed: number, k: number, x: number, z: number): number {
  const os = octaves((seed ^ 0x51ed270b ^ Math.imul(k, 0x85ebca6b)) | 0, [14000, 5000]);
  return 0.5 + fractalAt(os, x, z) / sum(os);
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The cloud field's value at (x, z) (m) and time t: drifted by the wind, blending from one shape to the next. */
function field(seed: number, t: number, x: number, z: number, noise: (seed: number, k: number, x: number, z: number) => number): number {
  const w = prevailingWind(seed);
  const px = x - w.x * t, pz = z - w.z * t;
  const k = Math.floor(t / EVOLVE), f = smoothstep(0, 1, t / EVOLVE - k);
  return noise(seed, k, px, pz) * (1 - f) + noise(seed, k + 1, px, pz) * f;
}

/**
 * The weather at (x, z) (m), on ground (or at a height) `height` m, at weather time `t` (s; see
 * weatherTime), `hours` into the day (for morning fog), in `climate` there (see climateAt).
 */
export function weatherAt(seed: number, t: number, x: number, z: number, height: number, hours: number, climate: PlaceClimate): Weather {
  const wind = prevailingWind(seed);
  // Wetter climates have more cloud, and rain from thinner of it.
  const wet = (climate.moisture - 0.5) * 0.36;
  const n = field(seed, t, x, z, cloudNoise) + wet;
  const cover = smoothstep(0.36, 0.66, n);
  const precipitation = smoothstep(0.6, 0.82, n);
  const above = Math.max(0, height - climate.seaLevel);
  const temperature = climate.temperature - climate.coolingPerMetre * above;
  // Snow at and below freezing (sleet between, counted as snow by its share).
  const snow = smoothstep(2, -1, temperature);
  // Thunder in warm, heavy rain where the storm field is high.
  const storm = smoothstep(0.55, 0.72, field(seed, t, x, z, stormNoise)) * smoothstep(0.45, 0.85, precipitation) * smoothstep(8, 18, temperature);
  // Fog: wet mornings (around six), rain and wet air, thickest low down.
  const fromSix = (((hours - 6.5) % 24) + 24) % 24, apart = Math.min(fromSix, 24 - fromSix);
  const morning = Math.exp(-(apart * apart) / 8);
  const low = Math.exp(-above / 250);
  const fog = Math.min(1, (0.2 * climate.moisture + 0.7 * morning * climate.moisture + 0.45 * precipitation + 0.2 * cover * climate.moisture) * low);
  return { cover, precipitation, snow, storm, fog, wind, temperature };
}

/** Lightning: where and when (m, weather time s) a bolt struck. */
export interface Strike {
  x: number;
  z: number;
  t: number;
}

/** Lightning cells (m across) and how long each gets a chance to strike (s). */
const STRIKE_CELL = 1500;
const STRIKE_SLOT = 4;
/** In the stormiest weather, how likely a cell strikes in a slot. */
const STRIKE_CHANCE = 0.07;

/**
 * The lightning that struck within `radius` m of (x, z) between weather times t0 and t1 (s),
 * earliest first: the same for everyone (each cell and moment decided by the seed), more where the
 * storm is stronger (`climate`: the climate at a place, see climateAt).
 */
export function strikesBetween(seed: number, t0: number, t1: number, x: number, z: number, radius: number, climate: (x: number, z: number) => PlaceClimate): Strike[] {
  const out: Strike[] = [];
  const c0 = Math.floor((x - radius) / STRIKE_CELL), c1 = Math.floor((x + radius) / STRIKE_CELL);
  const r0 = Math.floor((z - radius) / STRIKE_CELL), r1 = Math.floor((z + radius) / STRIKE_CELL);
  for (let s = Math.floor(t0 / STRIKE_SLOT); s * STRIKE_SLOT < t1; s++) {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const h = hash2(c * 7919 + s, r * 104729 + s, seed ^ 0x2545f491);
        if (h > STRIKE_CHANCE) continue; // (cheap: most never could)
        const sx = (c + hash2(c, r, s ^ seed)) * STRIKE_CELL, sz = (r + hash2(r, c, s ^ seed ^ 0x9e37)) * STRIKE_CELL;
        const st = (s + hash2(s, c ^ r, seed)) * STRIKE_SLOT;
        if (st < t0 || st >= t1 || Math.hypot(sx - x, sz - z) > radius) continue;
        const cl = climate(sx, sz);
        const w = weatherAt(seed, st, sx, sz, cl.seaLevel, 14, cl);
        if (h < STRIKE_CHANCE * w.storm) out.push({ x: sx, z: sz, t: st });
      }
  }
  return out.sort((a, b) => a.t - b.t);
}
