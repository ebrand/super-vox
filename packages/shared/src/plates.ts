import { Material } from './materials.js';
import { fractalGrid, type Octave } from './noise.js';
import type { HeightSource } from './terrain.js';
import type { WorldConfig } from './world.js';

/**
 * Settings chosen when a world is created. Terrain is built from tectonic
 * plates: continental plates become land, oceanic plates sea floor, and the
 * seams between plates raise mountains, trenches, rifts, and ridges according
 * to how the plates move relative to each other.
 */
export interface PlateTerrainConfig {
  seed: number;
  /** Large plates that set the continents' overall shapes (1..40). */
  majorPlates: number;
  /** Small plates crowding between the major ones, adding seams (0..100). */
  minorPlates: number;
  /** Share of the world under the sea, 0..100 (exact). */
  waterPercent: number;
  /** How ragged coastlines are, 0 (smooth) .. 100 (heavily broken, many islands). */
  shoreFractal: number;
}

export function defaultPlateTerrain(seed = 1): PlateTerrainConfig {
  return { seed, majorPlates: 7, minorPlates: 12, waterPercent: 70, shoreFractal: 50 };
}

export function validatePlateTerrain(c: PlateTerrainConfig): void {
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be an integer ${lo}..${hi}; got ${v}`);
  };
  int(c.seed, -(2 ** 31), 2 ** 31 - 1, 'seed');
  int(c.majorPlates, 1, 40, 'majorPlates');
  int(c.minorPlates, 0, 100, 'minorPlates');
  if (!(c.waterPercent >= 0 && c.waterPercent <= 100)) throw new RangeError(`waterPercent must be 0..100; got ${c.waterPercent}`);
  if (!(c.shoreFractal >= 0 && c.shoreFractal <= 100)) throw new RangeError(`shoreFractal must be 0..100; got ${c.shoreFractal}`);
}

/** Coarse grid cell (units): 32 m. Heights between cells are interpolated. */
export const PLATE_CELL = 512;
const M = 16; // units per metre
/** Highest mountains and deepest sea floor, relative to sea level (units). */
export const MAX_MOUNTAIN = 300 * M;
export const OCEAN_DEPTH = 150 * M;
/** Land just above the shore, typical lowland inland, and rolling hills on top (units). */
const COAST_RISE = 3 * M;
const LOWLAND = 35 * M;
const HILLS = 25 * M;
/** Largest small-scale roughness (units), reached on mountains. */
const DETAIL_MAX = 6 * M;
const DETAIL_MIN = 0.4 * M;
/** Sand up to this height above the sea; bare rock and snow on high ground. */
const BEACH = 2 * M;
const ROCK_LINE = 170 * M;
const SNOW_LINE = 220 * M;

interface Plate {
  x: number;
  z: number;
  /** Relative size in the weighted Voronoi diagram (major 1, minor smaller). */
  weight: number;
  continental: boolean;
  vx: number;
  vz: number;
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
 * Sea level is y = 0. On wrapping worlds everything is periodic in X.
 */
export class PlateHeights implements HeightSource {
  readonly seaLevel = 0;
  readonly minHeight = -OCEAN_DEPTH - DETAIL_MAX - 1;
  readonly maxHeight = MAX_MOUNTAIN + DETAIL_MAX + 1;
  readonly cols: number;
  readonly rows: number;
  /** Surface height per grid cell (units, sea level 0). */
  readonly elevation: Float32Array;
  /** Plate index per grid cell. */
  readonly plateOf: Uint16Array;
  /** 0..1 per grid cell: how mountainous (drives roughness and rock). */
  private readonly rough: Float32Array;
  readonly plates: readonly Plate[];
  private readonly detail: Octave[];
  private readonly wrap: boolean;

  constructor(
    readonly world: WorldConfig,
    readonly config: PlateTerrainConfig,
  ) {
    validatePlateTerrain(config);
    if (world.widthUnits % PLATE_CELL || world.depthUnits % PLATE_CELL) {
      throw new RangeError(`world size must be a multiple of ${PLATE_CELL} units`);
    }
    if (world.minYUnits >= this.minHeight || world.maxYUnits <= this.maxHeight) {
      throw new RangeError("plate terrain doesn't fit the world's Y range");
    }
    this.wrap = world.wrapX;
    const cols = (this.cols = world.widthUnits / PLATE_CELL);
    const rows = (this.rows = world.depthUnits / PLATE_CELL);
    const n = cols * rows;
    const rand = rng(config.seed);
    const W = world.widthUnits, D = world.depthUnits;
    const periodic = (spacing: number) => (this.wrap ? W / spacing : 0);
    const octaves = (seed: number, spacings: number[], persistence = 0.5): Octave[] =>
      spacings.map((spacing, k) => ({ spacing, weight: persistence ** k, periodX: periodic(spacing), seed: config.seed * 7919 + seed * 101 + k }));
    /** Noise over the grid's cell centres, normalized to about -1..1. */
    const gridNoise = (os: Octave[]) => {
      const raw = fractalGrid(os, PLATE_CELL / 2, PLATE_CELL / 2, cols, rows, PLATE_CELL);
      const norm = 2 / os.reduce((a, o) => a + o.weight, 0);
      return raw.map((v) => v * norm);
    };
    const dx = (a: number, b: number) => {
      let d = b - a;
      if (this.wrap) d -= Math.round(d / W) * W;
      return d;
    };

    // 1. Plates: majors spread out (best of a few candidates), minors anywhere, smaller.
    const plates: Plate[] = [];
    const distTo = (p: { x: number; z: number }, c: { x: number; z: number }) => Math.hypot(dx(p.x, c.x), p.z - c.z);
    const place = (weight: number, score: (c: { x: number; z: number }) => number, tries: number) => {
      let best = { x: 0, z: 0 }, bestScore = -Infinity;
      for (let k = 0; k < tries; k++) {
        const c = { x: rand() * W, z: rand() * D };
        const sc = score(c);
        if (sc > bestScore) [best, bestScore] = [c, sc];
      }
      const a = rand() * Math.PI * 2, speed = 0.5 + rand() * 0.5;
      plates.push({ ...best, weight, continental: false, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed });
    };
    // Majors spread out: best of several candidates by distance to existing plates.
    for (let i = 0; i < config.majorPlates; i++) {
      place(1, (c) => plates.reduce((m, p) => Math.min(m, distTo(p, c)), Infinity), 12);
    }
    // Minors crowd the seams between majors: prefer points nearly equidistant from the two nearest majors.
    const majors = plates.slice();
    for (let i = 0; i < config.minorPlates; i++) {
      place(
        0.55 + rand() * 0.25,
        (c) => {
          const d = majors.map((p) => distTo(p, c)).sort((a, b) => a - b);
          return d.length < 2 ? 0 : -(d[1]! - d[0]!);
        },
        8,
      );
    }
    this.plates = plates;

    // 2. Assign every cell to a plate (weighted Voronoi), with warped borders.
    const warpX = gridNoise(octaves(1, [64000, 32000, 16000]));
    const warpZ = gridNoise(octaves(2, [64000, 32000, 16000]));
    const WARP = 900 * M;
    const plateOf = (this.plateOf = new Uint16Array(n));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        const x = (c + 0.5) * PLATE_CELL + warpX[i]! * WARP, z = (r + 0.5) * PLATE_CELL + warpZ[i]! * WARP;
        let best = 0, bestD = Infinity;
        plates.forEach((p, k) => {
          const d = Math.hypot(dx(p.x, x), p.z - z) / p.weight;
          if (d < bestD) [best, bestD] = [k, d];
        });
        plateOf[i] = best;
      }
    }

    // 3. Continental major plates, in random order, until continents (majors plus the minors that
    //    belong to them) cover a bit more than the land share. Minor plates take the crust type of
    //    the nearest major, so microplates inside a continent aren't oceanic slivers and vice versa.
    //    (The exact coastline comes from the sea level chosen below.)
    const area = new Array<number>(plates.length).fill(0);
    for (const p of plateOf) area[p]!++;
    const majorCount = config.majorPlates;
    const parent = plates.map((p, k) => {
      if (k < majorCount) return k;
      let best = 0, bestD = Infinity;
      for (let m = 0; m < majorCount; m++) {
        const d = distTo(plates[m]!, p);
        if (d < bestD) [best, bestD] = [m, d];
      }
      return best;
    });
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
    const landTarget = (1 - config.waterPercent / 100) * n * 1.02;
    for (const k of order) {
      if (covered >= landTarget) break;
      continentalMajor[k] = true;
      covered += familyArea[k]!;
    }
    plates.forEach((p, k) => (p.continental = continentalMajor[parent[k]!]!));

    // 4. Distance to the nearest plate boundary (in cells) and the plate across it (chamfer transform).
    const dist = new Float32Array(n).fill(Infinity);
    const other = new Int32Array(n).fill(-1);
    const at = (c: number, r: number) => {
      if (this.wrap) c = ((c % cols) + cols) % cols;
      return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const j = at(c + a, r + b);
          if (j >= 0 && plateOf[j] !== plateOf[i]) {
            dist[i] = 0.5;
            other[i] = plateOf[j]!;
          }
        }
      }
    }
    const relax = (i: number, j: number, w: number) => {
      if (j >= 0 && dist[j]! + w < dist[i]!) {
        dist[i] = dist[j]! + w;
        other[i] = other[j]!;
      }
    };
    for (let pass = 0; pass < (this.wrap ? 2 : 1); pass++) {
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

    // 5. Base crust (continental +1, oceanic -1), smoothed so plate borders aren't cliffs.
    let base: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) base[i] = plates[plateOf[i]!]!.continental ? 1 : -1;
    base = blur(blur(base, cols, rows, 9, this.wrap), cols, rows, 9, this.wrap);
    // Continent-scale undulation of the crust: where the sea floods continental crust (or
    // oceanic crust rises), it does so in broad natural shapes rather than along plate polygons.
    const swell = gridNoise(octaves(7, [64000, 32000, 16000]));

    // 6. Shoreline fractalization: multi-scale noise (0 = none), applied below in a band around
    //    the waterline so interiors stay solid.
    // Finer octaves weigh nearly as much as coarse ones, so coasts break up rather than just shift.
    const shore = gridNoise(octaves(3, [16000, 8000, 4000, 2000, 1000, 512], 0.8));
    const shoreAmp = (config.shoreFractal / 100) * 2;
    // Gentle rolling hills on land, away from mountains.
    const hills = gridNoise(octaves(6, [16000, 8000, 4000, 2000]));
    // Mountain ranges vary in height along their length.
    const rangeVar = gridNoise(octaves(4, [32000, 16000]));

    // 7. Seams: uplift (mountains, ridges, arcs) and trenches/rifts from relative plate motion.
    const g = (d: number, w: number) => Math.exp(-((d / w) ** 2));
    const land = new Float32Array(n);
    const upAt = new Float32Array(n);
    const rough = (this.rough = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const p = plates[plateOf[i]!]!;
      let up = 0, down = 0;
      if (other[i]! >= 0) {
        const q = plates[other[i]!]!;
        const nx = dx(p.x, q.x), nz = q.z - p.z, len = Math.hypot(nx, nz) || 1;
        // > 0: the plates approach each other across this seam; < 0: they pull apart.
        const conv = ((p.vx - q.vx) * nx + (p.vz - q.vz) * nz) / len / 2;
        const d = dist[i]! * PLATE_CELL / M; // metres
        if (conv > 0.1) {
          if (p.continental && q.continental) up += conv * g(d, 700);
          else if (p.continental) up += 0.8 * conv * g(d - 250, 450); // coastal range inland of a trench
          else if (q.continental) down += conv * g(d, 350); // ocean-side trench
          else if (plateOf[i]! < other[i]!) up += 0.55 * conv * g(d, 400); // island arc
          else down += conv * g(d, 300);
        } else if (conv < -0.1) {
          if (p.continental) down += 0.3 * -conv * g(d, 300); // rift valley
          else up += 0.2 * -conv * g(d, 500); // mid-ocean ridge
        }
      }
      up *= 0.65 + 0.35 * rangeVar[i]!;
      upAt[i] = up;
      land[i] = base[i]! * 0.5 + swell[i]! * 0.3 + up - down * 0.8;
    }
    // Fractalize around every shoreline (outer coasts and inland seas alike): find where the
    // waterline falls without it, then roughen a band ~700 m either side of that line only.
    const tau0 = quantile(land, config.waterPercent / 100);
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
    for (let i = 0; i < n; i++) {
      const band = 1 - smoothstep(0, BAND, toShore[i]!);
      land[i] = land[i]! + shore[i]! * shoreAmp * band * 0.5;
    }

    // 8. Sea level: the exact quantile giving waterPercent under water; then heights.
    const tau = quantile(land, config.waterPercent / 100);
    let lo = Infinity;
    for (const v of land) if (v < lo) lo = v;
    // Strongest uplift on land sets the tallest peak.
    let upMax = 1e-6;
    for (let i = 0; i < n; i++) if (land[i]! > tau && upAt[i]! > upMax) upMax = upAt[i]!;
    // Distance from every land cell to the nearest sea (cells), so land rises inland.
    const toSea = new Float32Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) if (land[i]! <= tau) toSea[i] = 0;
    chamfer(toSea, cols, rows, this.wrap);
    const INLAND_CELLS = (1500 * M) / PLATE_CELL;
    const elevation = (this.elevation = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const v = land[i]!;
      if (v > tau) {
        // Land: a lowland rising from the coast inland, gentle hills, and mountains where plates
        // collide (scaled so the strongest uplift reaches the top of the range).
        const inland = smoothstep(0, INLAND_CELLS, toSea[i]!);
        const lowland = COAST_RISE + (LOWLAND - COAST_RISE) * inland;
        const rolling = HILLS * inland * (0.5 + 0.5 * hills[i]!);
        const m = Math.max(0, upAt[i]!) / upMax;
        const mountains = (MAX_MOUNTAIN - lowland - rolling) * m ** 1.4;
        elevation[i] = lowland + rolling + mountains;
        rough[i] = Math.min(1, m * 1.5);
      } else {
        // Shallow shelves near coasts, deepening offshore.
        const u = (tau - v) / Math.max(1e-6, tau - lo);
        elevation[i] = Math.min(-1, -OCEAN_DEPTH * u ** 1.3);
      }
    }

    // Small-scale roughness down to 1 m (also hides the 32 m grid's facets).
    this.detail = octaves(5, [512, 256, 128, 64, 32, 16]);
  }

  /** Fraction of grid cells above sea level (for tests and tools). */
  landFraction(): number {
    let land = 0;
    for (const h of this.elevation) if (h > this.seaLevel) land++;
    return land / this.elevation.length;
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
      const amp = DETAIL_MIN + (DETAIL_MAX - DETAIL_MIN) * rough[k]!;
      out[k] = Math.round(elev[k]! + detail[k]! * norm * amp);
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
        h <= BEACH ? Material.Sand
        : h >= SNOW_LINE ? Material.Snow
        : h >= ROCK_LINE || slope > 0.9 ? Material.Stone
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
