import { BIOME_NAMES, type BiomeId } from './biomes.js';
import { Material } from './materials.js';
import { PLATE_CELL, type PlateHeights } from './plates.js';
import { NO_WATER } from './water.js';
import type { WorldConfig } from './world.js';

/**
 * Castle sites: hilltops near water, found by scanning a plate world's ground on a 16 m grid.
 * A good site has a top flat enough to build on, nothing higher close by, ground falling away on
 * most sides (a defensible hill or the end of a spur), a gentler side for the road in, a height
 * in the asked-for band, and a river (or lake) nearby: closer is better, best at the hill's foot.
 * Used by the site finder page and tools/castle-sites.ts.
 */
export interface SiteSearch {
  /** Height band of the hilltop, metres above the sea. */
  minHeight: number;
  maxHeight: number;
  /** Water no further than this (m). */
  waterWithin: number;
  /** river: only rivers count; any: lakes too. */
  water: 'river' | 'any';
  /** A side is steep where the ground 160 m out is at least this much lower (m). */
  steepDrop: number;
  /** How many sites, and how far apart at least (m). */
  count: number;
  spacing: number;
}

export const DEFAULT_SITE_SEARCH: SiteSearch = { minHeight: 60, maxHeight: 225, waterWithin: 1500, water: 'river', steepDrop: 20, count: 12, spacing: 1500 };

export const SITE_LIMITS = {
  height: [-1000, 2000],
  waterWithin: [100, 10_000],
  steepDrop: [5, 200],
  count: [1, 50],
  spacing: [200, 20_000],
} as const;

export interface CastleSite {
  rank: number;
  /** Where (metres; x within the world), and the ground's height there (m above the sea). */
  x: number;
  z: number;
  y: number;
  score: number;
  /** Of 16 directions, how many fall steeply (see SiteSearch.steepDrop). */
  steepSides: number;
  /** The gentlest way up (compass point), or null if every side is steep. */
  approachFrom: string | null;
  /** How far the ground falls on average 160 m and 320 m out (m). */
  drop160: number;
  drop320: number;
  /** Share of a 96 m circle within a few metres of the top's height. */
  flatTop: number;
  water: { kind: 'river' | 'lake'; metres: number; direction: string; widthM: number | null };
  /** Ground material (its name in Material), biome name (null without biomes), trees within 48 m. */
  ground: string;
  biome: string | null;
  trees: number;
}

const M = 16;
/** Scan grid (m). */
export const SITE_STEP_M = 16;
const S = SITE_STEP_M * M;
/** Ground counts as the flat top within this many metres of the site's height. */
const FLAT_M = 6;
/** The road in: a side whose ground 160 m out is no more than this much lower (and not higher). */
const GENTLE_DROP_M = 20;
/** Sites must fall at least this much on average within 320 m. */
const MIN_DROP320_M = 30;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Checks a search's settings, throwing RangeError for one out of range. */
export function validateSiteSearch(s: SiteSearch): void {
  const num = (v: number, [lo, hi]: readonly [number, number], name: string) => {
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new RangeError(`${name} must be ${lo}..${hi}; got ${v}`);
  };
  num(s.minHeight, SITE_LIMITS.height, 'minHeight');
  num(s.maxHeight, SITE_LIMITS.height, 'maxHeight');
  if (!(s.minHeight <= s.maxHeight)) throw new RangeError(`minHeight must be at most maxHeight; got ${s.minHeight} and ${s.maxHeight}`);
  num(s.waterWithin, SITE_LIMITS.waterWithin, 'waterWithin');
  if (s.water !== 'river' && s.water !== 'any') throw new RangeError(`water must be river or any; got ${String(s.water)}`);
  num(s.steepDrop, SITE_LIMITS.steepDrop, 'steepDrop');
  num(s.count, SITE_LIMITS.count, 'count');
  num(s.spacing, SITE_LIMITS.spacing, 'spacing');
}

/**
 * The best sites in a world, best first. `progress` hears how far along the scan is (0..1) now
 * and then.
 */
export function findSites(p: PlateHeights, world: WorldConfig, search: SiteSearch, progress: (done: number) => void = () => {}): CastleSite[] {
  validateSiteSearch(search);
  const sea = p.seaLevel;
  const cols = Math.round(world.widthUnits / S), rows = Math.round(world.depthUnits / S), n = cols * rows;
  const wrap = world.wrapX;
  const idx = (c: number, r: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
  };

  // Ground (m above the sea) and water on the scan grid: 1 sea, 2 river or lake.
  const H = new Float32Array(n);
  const wet = new Uint8Array(n);
  const TILE = 400;
  const tiles = Math.ceil(rows / TILE) * Math.ceil(cols / TILE);
  let done = 0;
  for (let tz = 0; tz < rows; tz += TILE) {
    for (let tx = 0; tx < cols; tx += TILE) {
      const w = Math.min(TILE, cols - tx), d = Math.min(TILE, rows - tz);
      const h = p.heights(tx * S, tz * S, w, d, S);
      const water = p.water(tx * S, tz * S, w, d, S);
      for (let j = 0; j < d; j++) {
        for (let i = 0; i < w; i++) {
          const k = i + w * j, g = tx + i + cols * (tz + j);
          H[g] = (h[k]! - sea) / M;
          if (h[k]! <= sea) wet[g] = 1;
          else if (water && water[k] !== NO_WATER && water[k]! > h[k]!) wet[g] = 2;
        }
      }
      progress((0.7 * ++done) / tiles);
    }
  }
  // River channels from the river segments (too narrow for the grid), with their widths (m).
  const channel = new Float32Array(n);
  for (const s of p.hydrology?.segments ?? []) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az), steps = Math.max(1, Math.ceil(len / (S / 2)));
    for (let k = 0; k <= steps; k++) {
      const g = idx(Math.floor((s.ax + ((s.bx - s.ax) * k) / steps) / S), Math.floor((s.az + ((s.bz - s.az) * k) / steps) / S));
      if (g >= 0) channel[g] = Math.max(channel[g]!, s.width / M);
    }
  }
  // Lakes: water where the generator put a lake (rivers run on through lakes, as segments of no
  // width, so the lake comes first; lake water reaches a little past the lake's own 32 m cells).
  const lake = new Uint8Array(n);
  const water = new Uint8Array(n); // river or lake
  const lakeLevel = p.hydrology?.lakeLevel;
  for (let g = 0; g < n; g++) {
    const river = channel[g]! > 0 || wet[g] === 2;
    if (!river) continue;
    const c = g % cols, r = (g - c) / cols;
    const pc = Math.floor(((c + 0.5) * S) / PLATE_CELL), pr = Math.floor(((r + 0.5) * S) / PLATE_CELL);
    for (let b = -1; b <= 1 && lakeLevel && !lake[g]; b++) {
      for (let a = -1; a <= 1; a++) {
        const qc = wrap ? (((pc + a) % p.cols) + p.cols) % p.cols : pc + a, qr = pr + b;
        if (qc >= 0 && qc < p.cols && qr >= 0 && qr < p.rows && !Number.isNaN(lakeLevel[qc + p.cols * qr]!)) {
          lake[g] = 1;
          break;
        }
      }
    }
    if (search.water === 'any' || !lake[g]) water[g] = 1;
  }

  // Distance (m) to the nearest water, and which cell that is (chamfer passes, twice round for
  // wrapping worlds: close enough to straight-line distance).
  const dist = new Float32Array(n).fill(Infinity);
  const near = new Int32Array(n).fill(-1);
  for (let g = 0; g < n; g++) if (water[g]) [dist[g], near[g]] = [0, g];
  const D1 = SITE_STEP_M, D2 = SITE_STEP_M * Math.SQRT2;
  const relax = (g: number, c: number, r: number, w: number) => {
    const o = idx(c, r);
    if (o >= 0 && dist[o]! + w < dist[g]!) [dist[g], near[g]] = [dist[o]! + w, near[o]!];
  };
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const g = c + cols * r;
      relax(g, c - 1, r, D1); relax(g, c, r - 1, D1); relax(g, c - 1, r - 1, D2); relax(g, c + 1, r - 1, D2);
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const g = c + cols * r;
      relax(g, c + 1, r, D1); relax(g, c, r + 1, D1); relax(g, c + 1, r + 1, D2); relax(g, c - 1, r + 1, D2);
    }
  }
  progress(0.8);

  // Score every cell in the height band near water.
  const DIRS = Array.from({ length: 16 }, (_, k) => [Math.sin((k * Math.PI) / 8), -Math.cos((k * Math.PI) / 8)] as const); // k = 0 north
  const at = (c: number, r: number) => {
    const g = idx(Math.round(c), Math.round(r));
    return g < 0 ? NaN : H[g]!;
  };
  const R160 = 160 / SITE_STEP_M, R320 = 320 / SITE_STEP_M;
  interface Scored { c: number; r: number; score: number; h: number; steep: number; approach: number; d160: number; d320: number; flat: number; w: number; isLake: boolean }
  const scored: Scored[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const g = c + cols * r, h0 = H[g]!;
      if (wet[g] || h0 < search.minHeight || h0 > search.maxHeight || dist[g]! > search.waterWithin) continue;
      // Flat top: everything within 32 m within FLAT_M.
      let flatTop = true;
      for (let b = -2; b <= 2 && flatTop; b++) {
        for (let a = -2; a <= 2; a++) {
          if (a * a + b * b > 4) continue;
          if (!(Math.abs(at(c + a, r + b) - h0) <= FLAT_M)) {
            flatTop = false;
            break;
          }
        }
      }
      if (!flatTop) continue;
      // Sides: how far the ground falls 160 m and 320 m out, each of 16 ways.
      let steep = 0, sum160 = 0, sum320 = 0, approach = -1, approachDrop = Infinity, higher = false;
      for (let k = 0; k < 16; k++) {
        const [dx, dz] = DIRS[k]!;
        const d1 = h0 - at(c + dx * R160, r + dz * R160), d2 = h0 - at(c + dx * R320, r + dz * R320);
        // Off the world's edge, or overlooked from close by: not a hilltop.
        if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 < -5 || d2 < -10) {
          higher = true;
          break;
        }
        if (d1 >= search.steepDrop) steep++;
        if (d1 >= 0 && d1 <= GENTLE_DROP_M && d1 < approachDrop) [approach, approachDrop] = [k, d1];
        sum160 += d1;
        sum320 += d2;
      }
      if (higher || steep < 6 || sum320 / 16 < MIN_DROP320_M) continue;
      // How much of a 48 m circle is flat top.
      let flatCount = 0, total = 0;
      for (let b = -3; b <= 3; b++) {
        for (let a = -3; a <= 3; a++) {
          if (a * a + b * b > 9) continue;
          total++;
          if (Math.abs(at(c + a, r + b) - h0) <= FLAT_M) flatCount++;
        }
      }
      // The water: a lake, or a river (its width: its channel's, near the nearest water, as a
      // wide river's banks are water too).
      const ng = near[g]!, isLake = lake[ng] === 1;
      let w = 0;
      if (!isLake) {
        const nc = ng % cols, nr = (ng - nc) / cols;
        for (let b = -4; b <= 4; b++) for (let a = -4; a <= 4; a++) {
          const o = idx(nc + a, nr + b);
          if (o >= 0) w = Math.max(w, channel[o]!);
        }
      }
      const waterM = dist[g]!;
      const sWater = waterM <= 250 ? 1 : Math.max(0, 1 - (waterM - 250) / Math.max(1, search.waterWithin - 250));
      const score =
        3 * (steep / 16) + 2 * Math.min(1, sum320 / 16 / 80) + 2 * sWater + 1.5 * (flatCount / total) + 0.5 * (approach >= 0 ? 1 : 0) + 0.5 * Math.min(1, (isLake ? 20 : w) / 20);
      scored.push({ c, r, score, h: h0, steep, approach, d160: sum160 / 16, d320: sum320 / 16, flat: flatCount / total, w, isLake });
    }
  }
  progress(0.9);

  // The best, spaced apart.
  scored.sort((a, b) => b.score - a.score);
  const picked: Scored[] = [];
  const spacing = search.spacing / SITE_STEP_M;
  for (const s of scored) {
    if (picked.length >= search.count) break;
    const close = picked.some((q) => {
      let dc = q.c - s.c;
      if (wrap) dc -= Math.round(dc / cols) * cols;
      return Math.hypot(dc, q.r - s.r) < spacing;
    });
    if (!close) picked.push(s);
  }

  // Details at each site: ground, biome, trees on top, which way the water is.
  const sites = picked.map((s, i): CastleSite => {
    const x = (s.c + 0.5) * S, z = (s.r + 0.5) * S;
    const h = p.heights(x, z, 1, 1);
    const mat = p.materials(x, z, 1, 1, 1, h)[0]!;
    const biome = p.biomes(x, z, 1, 1, 1, h)?.[0];
    const trees = p.trees(x - 48 * M, z - 48 * M, x + 48 * M, z + 48 * M).filter((t) => Math.hypot(t.x - x, t.z - z) <= 48 * M).length;
    const ng = near[s.c + cols * s.r]!, nc = ng % cols, nr = (ng - nc) / cols;
    let dc = nc - s.c;
    if (wrap) dc -= Math.round(dc / cols) * cols;
    const ang = Math.atan2(dc, -(nr - s.r));
    return {
      rank: i + 1,
      x: Math.round(x / M), z: Math.round(z / M), y: Math.round((h[0]! - sea) / M),
      score: Math.round(s.score * 100) / 100,
      steepSides: s.steep,
      approachFrom: s.approach >= 0 ? COMPASS[s.approach]! : null,
      drop160: Math.round(s.d160), drop320: Math.round(s.d320),
      flatTop: Math.round(s.flat * 100) / 100,
      water: {
        kind: s.isLake ? 'lake' : 'river',
        metres: Math.round(dist[s.c + cols * s.r]!),
        direction: COMPASS[((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16]!,
        widthM: s.isLake ? null : Math.round(s.w),
      },
      ground: (Object.entries(Material) as [string, number][]).find(([, v]) => v === mat)?.[0] ?? String(mat),
      biome: biome !== undefined ? BIOME_NAMES[biome as BiomeId] : null,
      trees,
    };
  });
  progress(1);
  return sites;
}

const COLOR = new Map<number, readonly [number, number, number]>([
  [Material.Grass, [96, 150, 70]], [Material.Meadow, [120, 165, 80]], [Material.DryGrass, [170, 160, 90]],
  [Material.JungleFloor, [60, 110, 50]], [Material.TaigaFloor, [80, 110, 75]], [Material.Tundra, [140, 135, 110]],
  [Material.Sand, [215, 200, 150]], [Material.Stone, [135, 135, 135]], [Material.Gravel, [160, 155, 150]], [Material.DarkStone, [110, 110, 115]], [Material.PaleStone, [190, 185, 178]], [Material.MossyStone, [120, 135, 105]], [Material.Sandstone, [150, 140, 125]], [Material.Shale, [125, 125, 130]], [Material.Limestone, [158, 155, 148]], [Material.Granite, [146, 136, 134]], [Material.Snow, [240, 242, 246]], [Material.Ice, [200, 225, 240]],
  [Material.Dirt, [120, 90, 60]],
]);

/**
 * A picture (RGBA, w x d pixels, `step` units each, centred on (cx, cz) units): ground colours,
 * forests darker, hill shading lit from the north-west, contours every `contourM` metres, sea
 * and rivers and lakes blue; and a red ring of radius ring.r units around (ring.x, ring.z).
 */
export function sitePicture(
  p: PlateHeights, world: WorldConfig, cx: number, cz: number, w: number, d: number, step: number, contourM: number,
  ring: { x: number; z: number; r: number } | null = null,
): Uint8ClampedArray {
  const sea = p.seaLevel;
  const x0 = cx - (w / 2) * step, z0 = cz - (d / 2) * step;
  const h = p.heights(x0, z0, w, d, step), mat = p.materials(x0, z0, w, d, step, h), water = p.water(x0, z0, w, d, step);
  const can = p.canopy(x0, z0, w, d, step, h, mat);
  const out = new Uint8ClampedArray(w * d * 4);
  const band = (v: number) => Math.floor((v - sea) / M / contourM);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + w * j;
      let r: number, g: number, b: number;
      if (h[k]! <= sea) [r, g, b] = [52, 92, 140];
      else if (water && water[k] !== NO_WATER && water[k]! > h[k]!) [r, g, b] = [60, 110, 170];
      else {
        [r, g, b] = COLOR.get(mat[k]!) ?? [110, 140, 90];
        if (can && can.top[k]! > h[k]!) [r, g, b] = [r * 0.55, g * 0.75, b * 0.55];
        const e = h[Math.min(w - 1, i + 1) + w * j]! - h[Math.max(0, i - 1) + w * j]!;
        const s = h[i + w * Math.min(d - 1, j + 1)]! - h[i + w * Math.max(0, j - 1)]!;
        const shade = Math.max(0.45, Math.min(1.35, 1 - ((e + s) / (2 * step)) * 1.2));
        [r, g, b] = [r * shade, g * shade, b * shade];
        if (i > 0 && j > 0 && (band(h[k]!) !== band(h[k - 1]!) || band(h[k]!) !== band(h[k - w]!))) [r, g, b] = [r * 0.7, g * 0.7, b * 0.7];
      }
      if (ring) {
        let dx = x0 + i * step - ring.x;
        if (world.wrapX) dx -= Math.round(dx / world.widthUnits) * world.widthUnits;
        if (Math.abs(Math.hypot(dx, z0 + j * step - ring.z) - ring.r) < step * 1.2) [r, g, b] = [230, 30, 30];
      }
      out[k * 4] = r;
      out[k * 4 + 1] = g;
      out[k * 4 + 2] = b;
      out[k * 4 + 3] = 255;
    }
  }
  return out;
}
