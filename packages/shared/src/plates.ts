import { Material } from './materials.js';
import { fractalGrid, type Octave } from './noise.js';
import type { HeightSource } from './terrain.js';
import type { WorldConfig } from './world.js';

/**
 * Settings chosen when a world is created. The world is divided into
 * tectonic plates: continental plates become land and oceanic plates sea
 * floor. Each plate's relief comes from its own seeded noise field, and
 * neighbouring plates blend smoothly where they meet. Heights are in metres.
 */
export interface PlateTerrainConfig {
  /** Plate layout: positions, sizes, and which plates are continents. */
  seed: number;
  /** Each plate's noise field; change it to reroll the relief and keep the layout. */
  terrainSeed: number;
  /** Large plates that set the continents' overall shapes (1..40). */
  majorPlates: number;
  /** Small plates crowding the seams between the major ones (0..100). */
  minorPlates: number;
  /** Area of a major plate relative to a minor one, e.g. 6 = six times larger (1..50). */
  plateSizeRatio: number;
  /** Deepest sea floor, in metres (-1000..1000, below seaLevel). */
  minHeight: number;
  /** Highest land, in metres (-1000..1000, above seaLevel). */
  maxHeight: number;
  /** The sea's surface, in metres. */
  seaLevel: number;
  /** Share of the world above the sea, 0..100 (exact); the rest is sea. */
  landPercent: number;
  /** How ragged coastlines are, 0 (smooth) .. 100 (heavily broken, many islands). */
  shoreFractal: number;
  /** Size of the largest features in each plate's noise, in metres (100..16000). */
  noiseScale: number;
  /** How much fine detail each plate's noise has, 0 (smooth swells) .. 100 (rugged). */
  noiseRoughness: number;
}

export function defaultPlateTerrain(seed = 1): PlateTerrainConfig {
  return {
    seed,
    terrainSeed: seed,
    majorPlates: 7,
    minorPlates: 15,
    plateSizeRatio: 6,
    minHeight: -300,
    maxHeight: 300,
    seaLevel: 0,
    landPercent: 30,
    shoreFractal: 50,
    noiseScale: 2000,
    noiseRoughness: 50,
  };
}

export const PLATE_LIMITS = {
  majorPlates: [1, 40],
  minorPlates: [0, 100],
  plateSizeRatio: [1, 50],
  height: [-1000, 1000],
  landPercent: [0, 100],
  shoreFractal: [0, 100],
  noiseScale: [100, 16000],
  noiseRoughness: [0, 100],
} as const;

/**
 * Plate settings from untrusted input (e.g. a JSON request or an older world file): known
 * settings are taken from `raw`, missing ones get their defaults, anything else is dropped.
 * Older worlds' `waterPercent` becomes `landPercent`. Throws RangeError if a setting is invalid.
 */
export function parsePlateTerrain(raw: unknown): PlateTerrainConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const seed = typeof r.seed === 'number' ? r.seed : 1;
  const out: Record<string, unknown> = { ...defaultPlateTerrain(seed) };
  for (const key of Object.keys(out)) if (r[key] !== undefined) out[key] = r[key];
  if (r.landPercent === undefined && typeof r.waterPercent === 'number') out.landPercent = 100 - r.waterPercent;
  const config = out as unknown as PlateTerrainConfig;
  validatePlateTerrain(config);
  return config;
}

export function validatePlateTerrain(c: PlateTerrainConfig): void {
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be an integer ${lo}..${hi}; got ${v}`);
  };
  const num = (v: number, [lo, hi]: readonly [number, number], name: string, unit = '') => {
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new RangeError(`${name} must be ${lo}..${hi}${unit}; got ${v}`);
  };
  const L = PLATE_LIMITS;
  int(c.seed, -(2 ** 31), 2 ** 31 - 1, 'seed');
  int(c.terrainSeed, -(2 ** 31), 2 ** 31 - 1, 'terrainSeed');
  int(c.majorPlates, ...L.majorPlates, 'majorPlates');
  int(c.minorPlates, ...L.minorPlates, 'minorPlates');
  num(c.plateSizeRatio, L.plateSizeRatio, 'plateSizeRatio');
  num(c.minHeight, L.height, 'minHeight', ' m');
  num(c.maxHeight, L.height, 'maxHeight', ' m');
  num(c.seaLevel, L.height, 'seaLevel', ' m');
  if (!(c.minHeight + 1 <= c.seaLevel)) throw new RangeError(`minHeight must be at least 1 m below seaLevel; got ${c.minHeight} and ${c.seaLevel}`);
  if (!(c.seaLevel + 1 <= c.maxHeight)) throw new RangeError(`maxHeight must be at least 1 m above seaLevel; got ${c.maxHeight} and ${c.seaLevel}`);
  num(c.landPercent, L.landPercent, 'landPercent');
  num(c.shoreFractal, L.shoreFractal, 'shoreFractal');
  num(c.noiseScale, L.noiseScale, 'noiseScale', ' m');
  num(c.noiseRoughness, L.noiseRoughness, 'noiseRoughness');
}

/** Coarse grid cell (units): 32 m. Heights between cells are interpolated. */
export const PLATE_CELL = 512;
const M = 16; // units per metre
/** Largest small-scale roughness (units), on the highest ground; the least, on low ground. */
const DETAIL_MAX = 6 * M;
const DETAIL_MIN = 0.4 * M;
/** Sand up to this height above the sea. Bare rock and snow start at these fractions of the land's height range. */
const BEACH = 2 * M;
const ROCK_FRACTION = 0.6;
const SNOW_FRACTION = 0.8;
/** Land rises to its full relief over this distance from the sea; the sea floor deepens over this distance from land. */
const INLAND = 1500 * M;
const OFFSHORE = 1500 * M;
/** Neighbouring plates' relief blends over this distance either side of their seam. */
const SEAM_BLEND = 400 * M;
/** Plate noise stops at this feature size; smaller detail is added per column. */
const NOISE_FINEST = 64 * M;

export interface Plate {
  x: number;
  z: number;
  major: boolean;
  /** Power-diagram weight (units^2), tuned so plate areas match plateSizeRatio. */
  weight: number;
  continental: boolean;
}

/** Small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plate-tectonic heights. Everything is decided once, on a 32 m grid, at
 * construction (a few hundred milliseconds); `heights` then interpolates that
 * grid and adds small-scale roughness, so chunk generation stays fast.
 * On wrapping worlds everything is periodic in X.
 */
export class PlateHeights implements HeightSource {
  /** Sea level, lowest and highest ground (units). */
  readonly seaLevel: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  private readonly beachLine: number;
  private readonly rockLine: number;
  private readonly snowLine: number;
  readonly cols: number;
  readonly rows: number;
  /** Surface height per grid cell (units). */
  readonly elevation: Float32Array;
  /** Plate index per grid cell. */
  readonly plateOf: Uint16Array;
  /** 0..1 per grid cell: how high the ground is within its range (drives roughness). */
  private readonly rough: Float32Array;
  readonly plates: readonly Plate[];
  private readonly detail: Octave[];
  private readonly wrap: boolean;

  constructor(
    readonly world: WorldConfig,
    readonly config: PlateTerrainConfig,
  ) {
    validatePlateTerrain(config);
    const sea = (this.seaLevel = Math.round(config.seaLevel * M));
    const lo = (this.minHeight = Math.round(config.minHeight * M));
    const hi = (this.maxHeight = Math.round(config.maxHeight * M));
    this.beachLine = sea + BEACH;
    this.rockLine = sea + (hi - sea) * ROCK_FRACTION;
    this.snowLine = sea + (hi - sea) * SNOW_FRACTION;
    if (world.widthUnits % PLATE_CELL || world.depthUnits % PLATE_CELL) {
      throw new RangeError(`world size must be a multiple of ${PLATE_CELL} units`);
    }
    if (world.minYUnits >= lo || world.maxYUnits <= hi) throw new RangeError("plate terrain doesn't fit the world's Y range");
    this.wrap = world.wrapX;
    const cols = (this.cols = world.widthUnits / PLATE_CELL);
    const rows = (this.rows = world.depthUnits / PLATE_CELL);
    const n = cols * rows;
    const rand = rng(config.seed);
    const W = world.widthUnits, D = world.depthUnits;
    // On a wrapping world each octave's lattice must tile the width exactly.
    const fit = (spacing: number) => (this.wrap ? W / Math.max(1, Math.round(W / spacing)) : spacing);
    const octaves = (seed: number, spacings: number[], persistence = 0.5): Octave[] =>
      spacings.map((s, k) => {
        const spacing = fit(s);
        return { spacing, weight: persistence ** k, periodX: this.wrap ? Math.round(W / spacing) : 0, seed: seed * 101 + k };
      });
    /** Noise over a block of grid cells, normalized to about -1..1. */
    const gridNoise = (os: Octave[], c0 = 0, r0 = 0, w = cols, d = rows) => {
      const raw = fractalGrid(os, c0 * PLATE_CELL + PLATE_CELL / 2, r0 * PLATE_CELL + PLATE_CELL / 2, w, d, PLATE_CELL);
      const norm = 2 / os.reduce((a, o) => a + o.weight, 0);
      return raw.map((v) => v * norm);
    };
    const layoutNoise = (k: number, spacings: number[], persistence = 0.5) => gridNoise(octaves(config.seed * 7919 + k, spacings, persistence));
    const dx = (a: number, b: number) => {
      let d = b - a;
      if (this.wrap) d -= Math.round(d / W) * W;
      return d;
    };
    const at = (c: number, r: number) => {
      if (this.wrap) c = ((c % cols) + cols) % cols;
      return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
    };

    // 1. Major plates: centres spread out (each the best of several random candidates).
    const plates: Plate[] = [];
    const distTo = (p: { x: number; z: number }, c: { x: number; z: number }) => Math.hypot(dx(p.x, c.x), p.z - c.z);
    const majorCount = config.majorPlates;
    for (let i = 0; i < majorCount; i++) {
      let best = { x: 0, z: 0 }, bestScore = -Infinity;
      for (let t = 0; t < 12; t++) {
        const c = { x: rand() * W, z: rand() * D };
        const sc = plates.reduce((m, p) => Math.min(m, distTo(p, c)), Infinity);
        if (sc > bestScore) [best, bestScore] = [c, sc];
      }
      plates.push({ ...best, major: true, weight: 0, continental: false });
    }
    this.plates = plates;

    // 2. Cells are assigned at warped positions, so borders wander (but never by more than about
    //    half a minor plate, or small plates fall apart).
    const minorArea = (W * D) / (majorCount * config.plateSizeRatio + config.minorPlates);
    const minorRadius = Math.sqrt(minorArea / Math.PI);
    const warpX = layoutNoise(1, [64000, 32000, 16000]);
    const warpZ = layoutNoise(2, [64000, 32000, 16000]);
    const WARP = Math.min(900 * M, 0.5 * minorRadius);
    const posX = new Float64Array(n), posZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = i % cols, r = (i - c) / cols;
      posX[i] = (c + 0.5) * PLATE_CELL + warpX[i]! * WARP;
      posZ[i] = (r + 0.5) * PLATE_CELL + warpZ[i]! * WARP;
    }
    const power = (p: Plate, x: number, z: number) => {
      const ddx = dx(p.x, x), ddz = p.z - z;
      return ddx * ddx + ddz * ddz - p.weight;
    };
    // Majors form a power diagram: nearest centre by d^2 - weight. Its borders are straight lines,
    // and the distance to the border with major b is exactly (power_b - power_a) / (2 |a - b|).
    const pd = new Float64Array(majorCount);
    const majorAt = (x: number, z: number) => {
      let a = 0;
      for (let k = 0; k < majorCount; k++) {
        pd[k] = power(plates[k]!, x, z);
        if (pd[k]! < pd[a]!) a = k;
      }
      let seam = Infinity;
      for (let b = 0; b < majorCount; b++) {
        if (b !== a) seam = Math.min(seam, (pd[b]! - pd[a]!) / (2 * Math.max(1, distTo(plates[a]!, plates[b]!))));
      }
      return { a, seam };
    };
    // Once placed, minors join the majors in one power diagram, so every border is a straight
    // line (before warping) and minors are polygons like the majors, only smaller.
    const owner = (x: number, z: number, withMinors: boolean) => {
      let best = 0, bestD = Infinity;
      const count = withMinors ? plates.length : majorCount;
      for (let k = 0; k < count; k++) {
        const d = power(plates[k]!, x, z);
        if (d < bestD) [best, bestD] = [k, d];
      }
      return best;
    };

    // Plate sizes are tuned on a coarse grid. Each round measures every plate's area and moves
    // its weight toward its target, with a per-plate step size (as in Rprop): halved when the
    // plate overshoots (its error changes sign), otherwise grown, so plates far off converge fast.
    const S = 4; // coarse grid stride (cells)
    const sample: number[] = [];
    for (let r = S >> 1; r < rows; r += S) for (let c = S >> 1; c < cols; c += S) sample.push(c + cols * r);
    const cellArea = (S * PLATE_CELL) ** 2;
    const balance = (target: number[], rounds: number, withMinors: boolean) => {
      const count = target.length;
      const area = new Float64Array(count);
      const gain = new Float64Array(count).fill(0.6);
      const lastErr = new Float64Array(count);
      for (let iter = 0; iter < rounds; iter++) {
        area.fill(0);
        for (const i of sample) area[owner(posX[i]!, posZ[i]!, withMinors)]!++;
        let mean = 0;
        for (let k = 0; k < count; k++) {
          const err = target[k]! - area[k]!;
          if (err * lastErr[k]! < 0) gain[k]! *= 0.5;
          else gain[k] = Math.min(20, gain[k]! * 1.2);
          lastErr[k] = err;
          // Raising a region's weight by w grows its area by roughly w * pi.
          plates[k]!.weight += ((err * cellArea) / Math.PI) * gain[k]!;
          mean += plates[k]!.weight;
        }
        // Only differences between weights matter.
        mean /= count;
        for (let k = 0; k < count; k++) plates[k]!.weight -= mean;
      }
    };

    // 3. Majors alone, balanced to equal sizes, give the seams the minors are placed on.
    balance(new Array<number>(majorCount).fill(sample.length / majorCount), 40, false);
    // Seam samples: within about half a coarse cell of a border between majors.
    const seamSamples = sample.filter((i) => majorAt(posX[i]!, posZ[i]!).seam < (S * PLATE_CELL) / 2);
    const parent: number[] = plates.map((_, k) => k);
    /** A cell's warped position as a plate centre: inside the world (wrapped east-west if it wraps). */
    const centreAt = (i: number) => ({
      x: this.wrap ? ((posX[i]! % W) + W) % W : Math.min(W, Math.max(0, posX[i]!)),
      z: Math.min(D, Math.max(0, posZ[i]!)),
    });
    for (let m = 0; m < config.minorPlates; m++) {
      // Each minor goes on a seam, spaced from the minors already placed (the best of several
      // random points), so they spread along all the seams instead of bunching. Once the seams are
      // crowded (no seam point is two minor radii clear), minors spill inland, nearest the seams.
      let best = centreAt(sample[0]!), bestScore = -Infinity;
      for (let t = 0; t < 24; t++) {
        const pool = t % 2 === 0 && seamSamples.length > 0 ? seamSamples : sample;
        const c = centreAt(pool[Math.floor(rand() * pool.length)]!);
        let clear = 2 * minorRadius;
        for (let k = majorCount; k < plates.length; k++) clear = Math.min(clear, distTo(plates[k]!, c));
        const seam = Math.min(majorAt(c.x, c.z).seam, 4 * minorRadius);
        const score = clear - 0.25 * seam;
        if (score > bestScore) [best, bestScore] = [c, score];
      }
      const { x, z } = best;
      const home = majorAt(x, z).a;
      // A new minor starts with the weight of the major it sits on, and grows to its target.
      plates.push({ x, z, major: false, weight: plates[home]!.weight, continental: false });
      parent.push(home);
    }

    // 4. Majors and minors together: minors carve their share out of the majors along the seams.
    const unit = sample.length / (majorCount * config.plateSizeRatio + config.minorPlates);
    balance(plates.map((p) => (p.major ? config.plateSizeRatio : 1) * unit), 80, true);
    const plateOf = (this.plateOf = new Uint16Array(n));
    for (let i = 0; i < n; i++) plateOf[i] = owner(posX[i]!, posZ[i]!, true);

    // 5. Continental major plates, in random order, until continents (majors plus the minors
    //    on their side of the seams) cover a bit more than the land share. Minor plates take the
    //    crust type of the major they sit on. (The exact coastline comes from the sea level below.)
    const area = new Array<number>(plates.length).fill(0);
    for (const p of plateOf) area[p]!++;
    const familyArea = new Array<number>(majorCount).fill(0);
    plates.forEach((_, k) => (familyArea[parent[k]!]! += area[k]!));
    // Fisher-Yates with the seeded PRNG: identical on every JS engine.
    const order = Array.from({ length: majorCount }, (_, k) => k);
    for (let k = order.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [order[k], order[j]] = [order[j]!, order[k]!];
    }
    const continentalMajor = new Array<boolean>(majorCount).fill(false);
    let covered = 0;
    const landTarget = (config.landPercent / 100) * n * 1.02;
    for (const k of order) {
      if (covered >= landTarget) break;
      continentalMajor[k] = true;
      covered += familyArea[k]!;
    }
    plates.forEach((p, k) => (p.continental = continentalMajor[parent[k]!]!));

    // 6. Distance from every cell to its plate's border (cells).
    const toSeam = new Float32Array(n).fill(Infinity);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        for (const [a, b] of [[1, 0], [0, 1]] as const) {
          const j = at(c + a, r + b);
          if (j >= 0 && plateOf[j] !== plateOf[i]) toSeam[i] = toSeam[j] = 0.5;
        }
      }
    }
    chamfer(toSeam, cols, rows, this.wrap);

    // 7. Each plate's relief: its own noise field (seeded from terrainSeed and the plate's index),
    //    with a per-plate bias (some plates sit higher than others) and strength.
    const persistence = 0.3 + 0.5 * (config.noiseRoughness / 100);
    const spacings: number[] = [];
    for (let s = config.noiseScale * M; spacings.length === 0 || s >= NOISE_FINEST; s /= 2) spacings.push(s);
    const trand = rng(config.terrainSeed ^ 0x5bd1e995);
    const relief = new Float32Array(n);
    const box = plates.map(() => ({ c0: cols, c1: -1, r0: rows, r1: -1 }));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = box[plateOf[c + cols * r]!]!;
        b.c0 = Math.min(b.c0, c); b.c1 = Math.max(b.c1, c); b.r0 = Math.min(b.r0, r); b.r1 = Math.max(b.r1, r);
      }
    }
    plates.forEach((_, k) => {
      const bias = (trand() * 2 - 1) * 0.35;
      const strength = 0.6 + trand() * 0.4;
      const b = box[k]!;
      if (b.c1 < 0) return; // swallowed by its neighbours
      const w = b.c1 - b.c0 + 1, d = b.r1 - b.r0 + 1;
      const field = gridNoise(octaves(config.terrainSeed * 7919 + (k + 1) * 104729, spacings, persistence), b.c0, b.r0, w, d);
      // Standardize the field (a sum of many octaves is flatter than a few), so the noise
      // settings change the relief's character rather than just its amplitude.
      let sum = 0, sq = 0;
      for (const v of field) { sum += v; sq += v * v; }
      const mu = sum / field.length, sd = Math.sqrt(Math.max(1e-12, sq / field.length - mu * mu));
      for (let r = b.r0; r <= b.r1; r++) {
        for (let c = b.c0; c <= b.c1; c++) {
          const i = c + cols * r;
          if (plateOf[i] === k) relief[i] = bias + strength * ((field[c - b.c0 + w * (r - b.r0)]! - mu) / sd) * 0.33;
        }
      }
    });
    // Blend across seams: near a border, fade into the smoothed field, which mixes both sides.
    {
      const R = Math.max(1, Math.round(SEAM_BLEND / PLATE_CELL / 2));
      const smooth = blur(blur(relief, cols, rows, R, this.wrap), cols, rows, R, this.wrap);
      const band = SEAM_BLEND / PLATE_CELL;
      for (let i = 0; i < n; i++) {
        const t = 1 - smoothstep(0, band, toSeam[i]!);
        relief[i] = relief[i]! + (smooth[i]! - relief[i]!) * t;
      }
    }

    // 8. Where land and sea fall: crust type (smoothed, so plate borders aren't straight coasts),
    //    a continent-scale swell, and the plates' relief.
    let base: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) base[i] = plates[plateOf[i]!]!.continental ? 1 : -1;
    base = blur(blur(base, cols, rows, 9, this.wrap), cols, rows, 9, this.wrap);
    const swell = layoutNoise(7, [64000, 32000, 16000]);
    const land = new Float32Array(n);
    for (let i = 0; i < n; i++) land[i] = base[i]! * 0.5 + swell[i]! * 0.3 + relief[i]! * 0.35;

    // 9. Shoreline fractalization: multi-scale noise (0 = none) in a band ~700 m either side of the
    //    waterline it would otherwise have, so interiors stay solid. Finer octaves weigh nearly as
    //    much as coarse ones, so coasts break up rather than just shift.
    const shore = layoutNoise(3, [16000, 8000, 4000, 2000, 1000, 512], 0.8);
    const shoreAmp = (config.shoreFractal / 100) * 2;
    const water = 1 - config.landPercent / 100;
    const tau0 = quantile(land, water);
    const toShore = new Float32Array(n).fill(Infinity);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        const wet = land[i]! <= tau0;
        for (const [a, b] of [[1, 0], [0, 1]] as const) {
          const j = at(c + a, r + b);
          if (j >= 0 && (land[j]! <= tau0) !== wet) toShore[i] = toShore[j] = 0;
        }
      }
    }
    chamfer(toShore, cols, rows, this.wrap);
    const BAND = (700 * M) / PLATE_CELL;
    for (let i = 0; i < n; i++) land[i] = land[i]! + shore[i]! * shoreAmp * 0.5 * (1 - smoothstep(0, BAND, toShore[i]!));

    // 10. The waterline: the exact quantile leaving landPercent above the sea.
    const tau = quantile(land, water);
    const toSea = new Float32Array(n).fill(Infinity);
    const toLand = new Float32Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) (land[i]! <= tau ? toSea : toLand)[i] = 0;
    chamfer(toSea, cols, rows, this.wrap);
    chamfer(toLand, cols, rows, this.wrap);

    // 11. Heights: land rises from the coast inland, following its plate's relief; the sea floor
    //    deepens away from land the same way. Both are stretched so the highest land is exactly
    //    maxHeight and the deepest sea floor exactly minHeight.
    // Relief as 0..1, ignoring the most extreme 0.5% at either end so a few outliers don't flatten the rest.
    const rMin = quantile(relief, 0.005), rMax = quantile(relief, 0.995);
    const r01 = (v: number) => Math.min(1, Math.max(0, (v - rMin) / Math.max(1e-6, rMax - rMin)));
    const shape = new Float32Array(n);
    let landMax = 0, seaMax = 0;
    for (let i = 0; i < n; i++) {
      if (land[i]! > tau) {
        const s = smoothstep(0, INLAND / PLATE_CELL, toSea[i]!) ** 0.7 * (0.15 + 0.85 * r01(relief[i]!));
        shape[i] = s;
        landMax = Math.max(landMax, s);
      } else {
        const s = smoothstep(0, OFFSHORE / PLATE_CELL, toLand[i]!) ** 0.8 * (0.3 + 0.7 * (1 - r01(relief[i]!)));
        shape[i] = s;
        seaMax = Math.max(seaMax, s);
      }
    }
    const elevation = (this.elevation = new Float32Array(n));
    const rough = (this.rough = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      if (land[i]! > tau) {
        const f = shape[i]! / Math.max(1e-6, landMax);
        elevation[i] = Math.max(sea + 1, sea + (hi - sea) * f);
        rough[i] = f;
      } else {
        const f = shape[i]! / Math.max(1e-6, seaMax);
        elevation[i] = Math.min(sea - 1, sea - (sea - lo) * f);
        rough[i] = 0;
      }
    }

    // Small-scale roughness down to 1 m (also hides the 32 m grid's facets).
    this.detail = octaves(config.terrainSeed * 7919 + 5, [512, 256, 128, 64, 32, 16]);
  }

  /** Fraction of grid cells above sea level (for tests and tools). */
  landFraction(): number {
    let land = 0;
    for (const h of this.elevation) if (h > this.seaLevel) land++;
    return land / this.elevation.length;
  }

  /** The plate under a point (units). */
  plateAt(x: number, z: number): number {
    let c = Math.floor(x / PLATE_CELL);
    if (this.wrap) c = ((c % this.cols) + this.cols) % this.cols;
    c = Math.max(0, Math.min(this.cols - 1, c));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(z / PLATE_CELL)));
    return this.plateOf[c + this.cols * r]!;
  }

  /**
   * Bilinear interpolation weights for a run of positions along one axis:
   * lower/upper cell indices and the blend factor, clamped (or wrapped) to the grid.
   */
  private axisWeights(p0: number, count: number, step: number, cells: number, wrap: boolean) {
    const i0 = new Int32Array(count), i1 = new Int32Array(count), t = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const f = (p0 + k * step + 0.5) / PLATE_CELL - 0.5;
      const a = Math.floor(f);
      t[k] = f - a;
      if (wrap) {
        i0[k] = ((a % cells) + cells) % cells;
        i1[k] = (((a + 1) % cells) + cells) % cells;
      } else {
        i0[k] = Math.max(0, Math.min(cells - 1, a));
        i1[k] = Math.max(0, Math.min(cells - 1, a + 1));
      }
    }
    return { i0, i1, t };
  }

  /** A per-cell field interpolated at the w x d samples, row-major. */
  private interpolate(field: Float32Array, x0: number, z0: number, w: number, d: number, step: number): Float64Array {
    const X = this.axisWeights(x0, w, step, this.cols, this.wrap);
    const Z = this.axisWeights(z0, d, step, this.rows, false);
    const out = new Float64Array(w * d);
    const cols = this.cols;
    for (let j = 0; j < d; j++) {
      const r0 = Z.i0[j]! * cols, r1 = Z.i1[j]! * cols, tz = Z.t[j]!;
      for (let i = 0; i < w; i++) {
        const c0 = X.i0[i]!, c1 = X.i1[i]!, tx = X.t[i]!;
        const a = field[r0 + c0]! + (field[r0 + c1]! - field[r0 + c0]!) * tx;
        const b = field[r1 + c0]! + (field[r1 + c1]! - field[r1 + c0]!) * tx;
        out[i + w * j] = a + (b - a) * tz;
      }
    }
    return out;
  }

  heights(x0: number, z0: number, w: number, d: number, step = 1): Int32Array {
    const detail = fractalGrid(this.detail, x0, z0, w, d, step);
    const norm = 2 / this.detail.reduce((a, o) => a + o.weight, 0);
    const elev = this.interpolate(this.elevation, x0, z0, w, d, step);
    const rough = this.interpolate(this.rough, x0, z0, w, d, step);
    const out = new Int32Array(w * d);
    for (let k = 0; k < out.length; k++) {
      const e = elev[k]!;
      // Never past the configured bounds: roughness fades out at the very top and bottom.
      const amp = Math.min(DETAIL_MIN + (DETAIL_MAX - DETAIL_MIN) * rough[k]!, this.maxHeight - e, e - this.minHeight);
      out[k] = Math.round(e + detail[k]! * norm * Math.max(0, amp));
    }
    return out;
  }

  materials(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array): Uint16Array {
    const out = new Uint16Array(w * d);
    // Coarse slope (rise over run) from the 32 m grid, via central differences one cell apart.
    const e = PLATE_CELL;
    const east = this.interpolate(this.elevation, x0 + e, z0, w, d, step);
    const west = this.interpolate(this.elevation, x0 - e, z0, w, d, step);
    const south = this.interpolate(this.elevation, x0, z0 + e, w, d, step);
    const north = this.interpolate(this.elevation, x0, z0 - e, w, d, step);
    for (let k = 0; k < out.length; k++) {
      const h = heights[k]!;
      const slope = Math.hypot(east[k]! - west[k]!, south[k]! - north[k]!) / (2 * e);
      out[k] =
        h <= this.beachLine ? Material.Sand
        : h >= this.snowLine ? Material.Snow
        : h >= this.rockLine || slope > 0.9 ? Material.Stone
        : Material.Grass;
    }
    return out;
  }
}

/** The value below which a fraction `q` (0..1) of the field lies (just outside the range at 0 and 1). */
function quantile(field: Float32Array, q: number): number {
  const sorted = Float32Array.from(field).sort();
  const n = sorted.length;
  if (q <= 0) return sorted[0]! - 1e-3;
  if (q >= 1) return sorted[n - 1]! + 1e-3;
  const k = Math.floor(q * n);
  return (sorted[Math.min(n - 1, k)]! + sorted[Math.max(0, k - 1)]!) / 2;
}

/** In-place two-pass chamfer distance transform (cells): zeros are sources, others start at Infinity. */
function chamfer(dist: Float32Array, cols: number, rows: number, wrap: boolean): void {
  const at = (c: number, r: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
  };
  const relax = (i: number, j: number, w: number) => {
    if (j >= 0 && dist[j]! + w < dist[i]!) dist[i] = dist[j]! + w;
  };
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        relax(i, at(c - 1, r), 1); relax(i, at(c, r - 1), 1); relax(i, at(c - 1, r - 1), Math.SQRT2); relax(i, at(c + 1, r - 1), Math.SQRT2);
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = c + cols * r;
        relax(i, at(c + 1, r), 1); relax(i, at(c, r + 1), 1); relax(i, at(c + 1, r + 1), Math.SQRT2); relax(i, at(c - 1, r + 1), Math.SQRT2);
      }
    }
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Separable box blur of a grid field with the given radius (cells); X wraps if asked. */
function blur(src: Float32Array, cols: number, rows: number, radius: number, wrap: boolean): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const span = 2 * radius + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        let cc = c + k;
        cc = wrap ? ((cc % cols) + cols) % cols : Math.max(0, Math.min(cols - 1, cc));
        sum += src[cc + cols * r]!;
      }
      tmp[c + cols * r] = sum / span;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[c + cols * Math.max(0, Math.min(rows - 1, r + k))]!;
      out[c + cols * r] = sum / span;
    }
  }
  return out;
}
