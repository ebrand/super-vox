import { BLOCK_SIZE } from './chunk.js';

/**
 * Caves: tunnels and chambers carved out of the rock (see TerrainGenerator). Tunnels follow the
 * zero lines of 2D noise (continuous curves, so they run on and branch rather than break up), at a
 * few levels below the ground, each wandering up and down a little: long passages that mostly run
 * level. Chambers are where 3D noise stretched sideways is high: wide and low. Both only in caving
 * regions (a broad 2D noise), so caves come in clusters with plain rock between, rarer the lower
 * `amount` is. Never near the surface (more rock over them under water), nor too deep. They're
 * reached by entrances: passages sloping down from the surface to the highest tunnels, where they
 * meet one (see entrances).
 */
export interface CaveSettings {
  /** 0 (none) .. 100 (common and big). */
  amount: number;
  seed: number;
}

/** Rock left over a cave (units): under land, and under water (so the sea and lakes stay put). */
export const CAVE_ROOF = 3 * BLOCK_SIZE;
export const CAVE_ROOF_UNDER_WATER = 10 * BLOCK_SIZE;
/** Caves reach no deeper than this below the ground (units). */
export const CAVE_DEPTH = 90 * BLOCK_SIZE;

/** Noise scales (blocks): tunnels' winding, and their levels' wandering up and down; chambers across and up; caving regions across. */
const TUNNEL_WIND = 90, TUNNEL_WANDER = 240;
const CHAMBER_ACROSS = 72, CHAMBER_UP = 20;
/** Tunnel levels: how far below the ground (blocks), each wandering this much up or down. */
const TUNNEL_LEVELS = [14, 34, 62] as const;
const LEVEL_WANDER = 9;
const REGION = 700;
/**
 * Entrances: at most one per ENTRANCE_GRID square of blocks (tried at a few points in it, kept
 * where its foot is on a tunnel of the highest level), a passage ENTRANCE_LENGTH long (blocks)
 * sloping down from the surface, ENTRANCE_WIDTH across and 4 high.
 */
const ENTRANCE_GRID = 64, ENTRANCE_LENGTH = 26, ENTRANCE_WIDTH = 3, ENTRANCE_TRIES = 32;
/** The lattice the noise is sampled on (blocks), the rest interpolated. */
const STEP_ACROSS = 4, STEP_UP = 2;

/** A hash of lattice point (x, y, z) to [-1, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x2c1b3c6d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth 3D value noise, about -1..1, at (x, y, z) in lattice units. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const tx = fade(x - x0), ty = fade(y - y0), tz = fade(z - z0);
  const c = (dx: number, dy: number, dz: number) => hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), tx), lerp(c(0, 1, 0), c(1, 1, 0), tx), ty),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), tx), lerp(c(0, 1, 1), c(1, 1, 1), tx), ty),
    tz,
  );
}

/** Two octaves of it (the second half as strong, twice as fine), about -1..1. */
function fractal3(x: number, y: number, z: number, seed: number): number {
  return (valueNoise3(x, y, z, seed) + 0.5 * valueNoise3(x * 2 + 17.3, y * 2 + 5.1, z * 2 + 9.7, seed + 1)) / 1.5;
}

/** How far into its caving region (x, z) is: 0 at its edge (or outside), 1 well inside. */
function regionFade(settings: CaveSettings, x: number, z: number): number {
  const t = thresholds(settings.amount);
  return Math.max(0, Math.min(1, (valueNoise3(x / REGION, 0.5, z / REGION, settings.seed + 7) - t.region) / 0.12));
}

/** How far off the line of level 0's tunnel (x, z) is, as a share of its half-width there (under 1: on it). */
function tunnelOff(settings: CaveSettings, x: number, z: number, fadeIn: number): number {
  const w = fractal3(x / TUNNEL_WIND, 0, z / TUNNEL_WIND, settings.seed + 11);
  return Math.abs(w) / (thresholds(settings.amount).tunnel * fadeIn);
}

/** Level `level`'s tunnel's depth below the ground at (x, z) (blocks; rounded where it's carved). */
function tunnelDepth(settings: CaveSettings, level: number, x: number, z: number): number {
  return TUNNEL_LEVELS[level]! - LEVEL_WANDER * valueNoise3(x / TUNNEL_WANDER, level * 3.1, z / TUNNEL_WANDER, settings.seed + 11 * (level + 1) + 1);
}

export interface Entrance {
  /** Its top (blocks), the way it runs down (a unit vector), and its depth at its foot (blocks). */
  x: number;
  z: number;
  ux: number;
  uz: number;
  depth: number;
}

/** The entrance in grid square (gx, gz), if it has one. */
export function entranceIn(settings: CaveSettings, gx: number, gz: number): Entrance | null {
  // Fewer the lower the amount (and only in caving regions, on a tunnel).
  const a = Math.min(100, Math.max(0, settings.amount)) / 100;
  if ((hash3(gx, 7, gz, settings.seed + 31) + 1) / 2 > 0.5 + 0.5 * a) return null;
  for (let i = 0; i < ENTRANCE_TRIES; i++) {
    const r = (j: number) => (hash3(gx, 100 + i * 4 + j, gz, settings.seed + 31) + 1) / 2;
    // Its foot somewhere in the square, its top up a slope from it in any direction.
    const fx = (gx + r(0)) * ENTRANCE_GRID, fz = (gz + r(1)) * ENTRANCE_GRID, angle = r(2) * 2 * Math.PI;
    const fade = regionFade(settings, fx, fz);
    if (fade < 0.5 || tunnelOff(settings, fx, fz, fade) > 0.6) continue;
    const ux = Math.cos(angle), uz = Math.sin(angle);
    return { x: fx - ux * ENTRANCE_LENGTH, z: fz - uz * ENTRANCE_LENGTH, ux, uz, depth: tunnelDepth(settings, 0, fx, fz) };
  }
  return null;
}

/** Thresholds for an amount: caving regions, tunnels' width, chambers. */
function thresholds(amount: number): { region: number; tunnel: number; chamber: number } {
  const a = Math.min(100, Math.max(0, amount)) / 100;
  return { region: 0.62 - 0.85 * a, tunnel: 0.03 + 0.05 * a, chamber: 0.6 - 0.22 * a };
}

/**
 * Which blocks of a chunk column are cave: `surface` and `underWater` per block column (16 x 16,
 * bx + 16 * bz; the ground's lowest point over it, units, and whether water stands over it), and
 * the world's floor (units). Null if there are none; else the block layers [lo, hi) the mask covers
 * (absolute block y) and the mask, (bx + 16 * bz) + 256 * (by - lo).
 */
export function caveColumn(
  settings: CaveSettings,
  cx: number,
  cz: number,
  surface: ArrayLike<number>,
  underWater: ArrayLike<boolean>,
  floor: number,
): { lo: number; hi: number; mask: Uint8Array } | null {
  if (settings.amount <= 0) return null;
  const t = thresholds(settings.amount);
  const n = 16, bx0 = cx * n, bz0 = cz * n;
  // The caving region (2D, broad): any of the column in one?
  let regionMax = -Infinity;
  const region = new Float64Array(n * n);
  for (let bz = 0; bz < n; bz++)
    for (let bx = 0; bx < n; bx++) {
      const r = valueNoise3((bx0 + bx) / REGION, 0.5, (bz0 + bz) / REGION, settings.seed + 7);
      region[bx + n * bz] = r;
      regionMax = Math.max(regionMax, r);
    }
  // Entrances reaching into this column (from the grid squares within their length of it).
  const entrances: Entrance[] = [];
  const reach = ENTRANCE_LENGTH + ENTRANCE_WIDTH;
  for (let gz = Math.floor((bz0 - reach) / ENTRANCE_GRID); gz <= Math.floor((bz0 + n + reach) / ENTRANCE_GRID); gz++)
    for (let gx = Math.floor((bx0 - reach) / ENTRANCE_GRID); gx <= Math.floor((bx0 + n + reach) / ENTRANCE_GRID); gx++) {
      const e = entranceIn(settings, gx, gz);
      if (e) entrances.push(e);
    }
  if (regionMax <= t.region && !entrances.length) return null;
  // The depths caves may take, block layers [lo, hi) (entrances: up to the surface).
  let lo = Infinity, hi = -Infinity;
  if (entrances.length) for (let k = 0; k < n * n; k++) hi = Math.max(hi, Math.ceil(surface[k]! / BLOCK_SIZE) + 2);
  for (let k = 0; k < n * n; k++) {
    const roof = surface[k]! - (underWater[k] ? CAVE_ROOF_UNDER_WATER : CAVE_ROOF);
    hi = Math.max(hi, Math.floor(roof / BLOCK_SIZE));
    lo = Math.min(lo, Math.ceil(Math.max(floor + BLOCK_SIZE, surface[k]! - CAVE_DEPTH) / BLOCK_SIZE));
  }
  if (!(hi > lo)) return null;
  // The noise on a lattice over that (STEP_ACROSS across, STEP_UP up), interpolated per block.
  const ly0 = Math.floor(lo / STEP_UP) * STEP_UP;
  const nx = n / STEP_ACROSS + 1, ny = Math.ceil((hi - ly0) / STEP_UP) + 1;
  const lattice = (scaleAcross: number, scaleUp: number, seed: number) => {
    const out = new Float64Array(nx * nx * ny);
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nx; k++)
        for (let i = 0; i < nx; i++)
          out[i + nx * (k + nx * j)] = fractal3((bx0 + i * STEP_ACROSS) / scaleAcross, (ly0 + j * STEP_UP) / scaleUp, (bz0 + k * STEP_ACROSS) / scaleAcross, seed);
    return out;
  };
  const fc = lattice(CHAMBER_ACROSS, CHAMBER_UP, settings.seed + 5);
  const at = (f: Float64Array, bx: number, by: number, bz: number) => {
    const fx = bx / STEP_ACROSS, fz = bz / STEP_ACROSS, fy = (by - ly0) / STEP_UP;
    const i = Math.min(nx - 2, Math.floor(fx)), k = Math.min(nx - 2, Math.floor(fz)), j = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - i, tz = fz - k, ty = fy - j;
    const v = (di: number, dj: number, dk: number) => f[i + di + nx * (k + dk + nx * (j + dj))]!;
    return lerp(lerp(lerp(v(0, 0, 0), v(1, 0, 0), tx), lerp(v(0, 0, 1), v(1, 0, 1), tx), tz), lerp(lerp(v(0, 1, 0), v(1, 1, 0), tx), lerp(v(0, 1, 1), v(1, 1, 1), tx), tz), ty);
  };
  const mask = new Uint8Array(n * n * (hi - lo));
  let any = false;
  for (let bz = 0; bz < n; bz++)
    for (let bx = 0; bx < n; bx++) {
      const k = bx + n * bz;
      // Entrances through it (not under water: they'd let the water in).
      if (!underWater[k])
        for (const e of entrances) {
          const dx = bx0 + bx + 0.5 - e.x, dz = bz0 + bz + 0.5 - e.z;
          const along = dx * e.ux + dz * e.uz, across = Math.abs(dz * e.ux - dx * e.uz);
          if (along < 0 || along > ENTRANCE_LENGTH + 1 || across > ENTRANCE_WIDTH / 2) continue;
          // Its floor, down from the surface to the tunnel at its foot.
          const floorY = Math.floor(surface[k]! / BLOCK_SIZE - (Math.min(along, ENTRANCE_LENGTH) / ENTRANCE_LENGTH) * e.depth) - 1;
          for (let by = Math.max(lo, floorY); by < Math.min(hi, floorY + 4 + Math.ceil(surface[k]! / BLOCK_SIZE) - Math.floor(surface[k]! / BLOCK_SIZE)); by++) {
            mask[k + n * n * (by - lo)] = 1;
            any = true;
          }
        }
      // In the region, fading in over its edge (so caves thin out rather than stop).
      const edge = (region[k]! - t.region) / 0.12;
      if (edge <= 0) continue;
      const fadeIn = Math.min(1, edge);
      const roof = Math.floor((surface[k]! - (underWater[k] ? CAVE_ROOF_UNDER_WATER : CAVE_ROOF)) / BLOCK_SIZE);
      const bottom = Math.ceil(Math.max(floor + BLOCK_SIZE, surface[k]! - CAVE_DEPTH) / BLOCK_SIZE);
      // Tunnels: per level, whether this block column is on its line (and how far off it, for the
      // tunnel's height: tallest on the line), and the level's height here.
      const x = bx0 + bx, z = bz0 + bz;
      const tunnels: { y: number; half: number }[] = [];
      TUNNEL_LEVELS.forEach((_depth, level) => {
        const s0 = settings.seed + 11 * (level + 1);
        const w = fractal3(x / TUNNEL_WIND, level * 7.3, z / TUNNEL_WIND, s0);
        const off = Math.abs(w) / (t.tunnel * fadeIn);
        if (off >= 1) return;
        const y = Math.round(surface[k]! / BLOCK_SIZE - tunnelDepth(settings, level, x, z));
        // 2 to 3 blocks up and down from its middle, less toward its sides (a rounded passage).
        const half = (2 + valueNoise3(x / 40, level, z / 40, s0 + 2)) * Math.sqrt(1 - off * off);
        tunnels.push({ y, half });
      });
      for (let by = Math.max(lo, bottom); by < Math.min(hi, roof); by++) {
        const tunnel = tunnels.some((tu) => Math.abs(by - tu.y) <= tu.half);
        const chamber = !tunnel && at(fc, bx, by, bz) > t.chamber + (1 - fadeIn) * 0.3;
        if (tunnel || chamber) {
          mask[k + n * n * (by - lo)] = 1;
          any = true;
        }
      }
    }
  return any ? { lo, hi, mask } : null;
}
