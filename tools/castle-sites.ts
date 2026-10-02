/**
 * Castle site finder: hilltops near a river, ranked, for a world on the live server (or any
 * server). It reads the world's settings from <server>/api/worlds and rebuilds its terrain here
 * with the same generator the server runs (nothing is asked of the server beyond that), then
 * scans the whole world on a 16 m grid.
 *
 *   npx tsx tools/castle-sites.ts [--world cartesian] [--server https://voxel.ericbrandcode.com]
 *     [--min 60] [--max 225] [--river 1500] [--water river|any] [--steep 20] [--count 12] [--out data/castle-sites]
 *
 * A good site: a top flat enough to build on (within a few metres over ~60 m), nothing higher
 * within 320 m, ground falling away on most sides (a defensible hill or the end of a spur), a
 * gentler side for the road in, between --min and --max metres above the sea (the snow line
 * wanders down to about 210 m on default worlds: such sites say Snow), and a river within --river
 * metres (closer is better, best at the foot of the hill; --water any counts lakes too).
 *
 * Writes sites.json, overview.png (the world, sites in red) and site-N.png (3.2 km around each
 * site: ground colours, hill shading, 20 m contours, water, the site ringed in red) to --out/<world>.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  BIOME_NAMES,
  Material,
  NO_WATER,
  PLATE_CELL,
  PlateHeights,
  WORLD_SHAPES,
  migratePlateTerrain,
  type BiomeId,
  type WorldShape,
} from '../packages/shared/src/index.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const arg = (k: string, d: string) => args.get(k) ?? d;
const SERVER = arg('server', 'https://voxel.ericbrandcode.com');
const WORLD = arg('world', 'cartesian');
const MIN_M = Number(arg('min', '60')), MAX_M = Number(arg('max', '225'));
const RIVER_M = Number(arg('river', '1500'));
const COUNT = Number(arg('count', '12'));
/** river: only rivers count as water nearby; any: lakes too. */
const WATER = arg('water', 'river');
const OUT = join(arg('out', 'data/castle-sites'), WORLD);

const M = 16; // units per metre
const STEP_M = 16, S = STEP_M * M; // scan grid
/** Ground counts as a flat top within this many metres of the site's height. */
const FLAT_M = 6;
/**
 * A side is steep if the ground 160 m out is at least this much lower. (Plate worlds' hills are
 * gentle: on "cartesian", only 1% of flat hilltops fall 21 m on average within 160 m.)
 */
const STEEP_DROP_M = Number(arg('steep', '20'));
/** Sites must fall at least this much on average within 320 m. */
const MIN_DROP320_M = 30;
/** The road in: a side whose ground 160 m out is no more than this much lower (and not higher). */
const GENTLE_DROP_M = 20;
/** Sites closer than this to a better one aren't listed. */
const SPACING_M = 1500;

// ---- The world, rebuilt here.
const res = await fetch(`${SERVER}/api/worlds`);
if (!res.ok) throw new Error(`${SERVER}/api/worlds: ${res.status}`);
const list = (await res.json()) as { worlds: { name: string; spec: { generator: string; plates?: unknown; shape?: WorldShape } }[] };
const entry = list.worlds.find((w) => w.name === WORLD);
if (!entry) throw new Error(`no world "${WORLD}" (there are: ${list.worlds.map((w) => w.name).join(', ')})`);
if (entry.spec.generator !== 'plates') throw new Error(`"${WORLD}" isn't a plate world`);
const world = WORLD_SHAPES[entry.spec.shape ?? 'round-64x32'];
const config = migratePlateTerrain(entry.spec.plates);
let t0 = performance.now();
const p = new PlateHeights(world, config);
const sea = p.seaLevel;
console.log(`${WORLD}: ${world.widthUnits / M / 1000} x ${world.depthUnits / M / 1000} km, built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// ---- Ground (metres above the sea) and water on the scan grid.
t0 = performance.now();
const cols = world.widthUnits / S, rows = world.depthUnits / S, n = cols * rows;
const wrap = world.wrapX;
const H = new Float32Array(n);
/** 1 sea, 2 lake or river standing water. */
const wet = new Uint8Array(n);
const TILE = 400;
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
  }
}
// Rivers too narrow to show on a 16 m grid: from the river segments themselves (with their widths).
const riverWidth = new Float32Array(n); // metres, 0 where no river
for (const s of p.hydrology?.segments ?? []) {
  const len = Math.hypot(s.bx - s.ax, s.bz - s.az), steps = Math.max(1, Math.ceil(len / (S / 2)));
  for (let k = 0; k <= steps; k++) {
    const x = s.ax + ((s.bx - s.ax) * k) / steps, z = s.az + ((s.bz - s.az) * k) / steps;
    let c = Math.floor(x / S);
    if (wrap) c = ((c % cols) + cols) % cols;
    const r = Math.floor(z / S);
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const g = c + cols * r;
    riverWidth[g] = Math.max(riverWidth[g]!, s.width / M);
  }
}
const segmentWidth = Float32Array.from(riverWidth); // the channels themselves
// Lakes: standing water where the generator put a lake (its 32 m grid); other standing water is
// the banks of a wide river, beside its centre line.
const lake = new Uint8Array(n);
const lakeLevel = p.hydrology?.lakeLevel;
for (let g = 0; g < n; g++) {
  if (wet[g] !== 2 && riverWidth[g] === 0) continue;
  // (Rivers run on through lakes, as segments of no width: the lake comes first.)
  const c = g % cols, r = (g - c) / cols;
  const pc = Math.floor(((c + 0.5) * S) / PLATE_CELL), pr = Math.floor(((r + 0.5) * S) / PLATE_CELL);
  // (Lake water reaches a little past the lake's own cells: any of the 3 x 3 around counts.)
  for (let b = -1; b <= 1 && lakeLevel && !lake[g]; b++) for (let a = -1; a <= 1; a++) {
    const qc = wrap ? (((pc + a) % p.cols) + p.cols) % p.cols : pc + a, qr = pr + b;
    if (qc >= 0 && qc < p.cols && qr >= 0 && qr < p.rows && !Number.isNaN(lakeLevel[qc + p.cols * qr]!)) { lake[g] = 1; break; }
  }
  if (lake[g]) riverWidth[g] = 20; // (scored as wide water)
  else if (riverWidth[g] === 0) riverWidth[g] = 12;
}
console.log(`ground and water sampled in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const idx = (c: number, r: number) => {
  if (wrap) c = ((c % cols) + cols) % cols;
  return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
};

// ---- Distance (m) to the nearest river or lake, and which cell that is.
const dist = new Float32Array(n).fill(Infinity);
const near = new Int32Array(n).fill(-1);
{
  const queue: number[] = [];
  for (let g = 0; g < n; g++) if (riverWidth[g]! > 0 && (WATER === 'any' || !lake[g])) [dist[g], near[g]] = [0, g], queue.push(g);
  // Chamfer passes (forward and back, twice for wrapping worlds): close enough to straight-line distance.
  const D1 = STEP_M, D2 = STEP_M * Math.SQRT2;
  const relax = (g: number, c: number, r: number, w: number) => {
    const o = idx(c, r);
    if (o >= 0 && dist[o]! + w < dist[g]!) [dist[g], near[g]] = [dist[o]! + w, near[o]!];
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const g = c + cols * r;
      relax(g, c - 1, r, D1); relax(g, c, r - 1, D1); relax(g, c - 1, r - 1, D2); relax(g, c + 1, r - 1, D2);
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const g = c + cols * r;
      relax(g, c + 1, r, D1); relax(g, c, r + 1, D1); relax(g, c + 1, r + 1, D2); relax(g, c - 1, r + 1, D2);
    }
  }
}

// ---- Score every cell in the height band.
t0 = performance.now();
const DIRS = Array.from({ length: 16 }, (_, k) => [Math.sin((k * Math.PI) / 8), -Math.cos((k * Math.PI) / 8)] as const); // k=0 north
const at = (c: number, r: number) => {
  const g = idx(Math.round(c), Math.round(r));
  return g < 0 ? NaN : H[g]!;
};
interface Site {
  c: number; r: number; score: number; height: number;
  steepSides: number; approach: string | null; drop160: number; drop320: number; flat: number;
  waterM: number; waterWidthM: number; waterDir: string; waterKind: 'river' | 'lake';
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const scored: Site[] = [];
const R160 = 160 / STEP_M, R320 = 320 / STEP_M;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const g = c + cols * r, h0 = H[g]!;
    if (wet[g] || h0 < MIN_M || h0 > MAX_M || dist[g]! > RIVER_M) continue;
    // Flat top: everything within 32 m within FLAT_M.
    let flatTop = true;
    for (let b = -2; b <= 2 && flatTop; b++) for (let a = -2; a <= 2; a++) {
      if (a * a + b * b > 4) continue;
      const v = at(c + a, r + b);
      if (!(Math.abs(v - h0) <= FLAT_M)) { flatTop = false; break; }
    }
    if (!flatTop) continue;
    // Sides: how far the ground falls 160 m and 320 m out, each of 16 ways.
    let steep = 0, sum160 = 0, sum320 = 0, approach = -1, approachDrop = Infinity, higher = false;
    for (let k = 0; k < 16; k++) {
      const [dx, dz] = DIRS[k]!;
      const d1 = h0 - at(c + dx * R160, r + dz * R160), d2 = h0 - at(c + dx * R320, r + dz * R320);
      if (!Number.isFinite(d1) || !Number.isFinite(d2)) { higher = true; break; }
      if (d1 < -5 || d2 < -10) higher = true; // overlooked from close by: not a hilltop
      if (d1 >= STEEP_DROP_M) steep++;
      if (d1 >= 0 && d1 <= GENTLE_DROP_M && d1 < approachDrop) [approach, approachDrop] = [k, d1];
      sum160 += d1; sum320 += d2;
    }
    if (higher || steep < 6 || sum320 / 16 < MIN_DROP320_M) continue;
    // How much of a 48 m circle is flat top.
    let flatCount = 0, total = 0;
    for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
      if (a * a + b * b > 9) continue;
      total++;
      if (Math.abs(at(c + a, r + b) - h0) <= FLAT_M) flatCount++;
    }
    const waterM = dist[g]!;
    // The river's width: its channel's, near the nearest water (a wide river's banks are water too).
    let w = lake[near[g]!] ? 20 : 0;
    if (!w) {
      const nc0 = near[g]! % cols, nr0 = (near[g]! - nc0) / cols;
      for (let b = -4; b <= 4; b++) for (let a = -4; a <= 4; a++) {
        const o = idx(nc0 + a, nr0 + b);
        if (o >= 0) w = Math.max(w, segmentWidth[o]!);
      }
    }
    const sRiver = waterM <= 250 ? 1 : Math.max(0, 1 - (waterM - 250) / (RIVER_M - 250));
    const score = 3 * (steep / 16) + 2 * Math.min(1, sum320 / 16 / 80) + 2 * sRiver + 1.5 * (flatCount / total) + 0.5 * (approach >= 0 ? 1 : 0) + 0.5 * Math.min(1, w / 20);
    // Which way the water is.
    const ng = near[g]!, nc = ng % cols, nr = (ng - nc) / cols;
    let ddx = nc - c;
    if (wrap) ddx -= Math.round(ddx / cols) * cols;
    const ang = Math.atan2(ddx, -(nr - r));
    scored.push({
      c, r, score, height: h0, steepSides: steep, approach: approach >= 0 ? COMPASS[approach]! : null,
      drop160: sum160 / 16, drop320: sum320 / 16, flat: flatCount / total,
      waterM, waterWidthM: w, waterKind: lake[near[g]!] ? 'lake' : 'river', waterDir: COMPASS[((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16]!,
    });
  }
}
console.log(`${scored.length} candidate cells scored in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// ---- The best, spaced apart.
scored.sort((a, b) => b.score - a.score);
const picked: Site[] = [];
const spacing = SPACING_M / STEP_M;
for (const s of scored) {
  if (picked.length >= COUNT) break;
  if (picked.some((q) => {
    let dc = q.c - s.c;
    if (wrap) dc -= Math.round(dc / cols) * cols;
    return Math.hypot(dc, q.r - s.r) < spacing;
  })) continue;
  picked.push(s);
}

// ---- Details at each site: ground, biome, trees on top.
const sites = picked.map((s, i) => {
  const x = (s.c + 0.5) * S, z = (s.r + 0.5) * S;
  const h = p.heights(x, z, 1, 1);
  const mat = p.materials(x, z, 1, 1, 1, h)[0]!;
  const biome = p.biomes(x, z, 1, 1, 1, h)?.[0];
  const trees = p.trees(x - 48 * M, z - 48 * M, x + 48 * M, z + 48 * M).filter((t) => Math.hypot(t.x - x, t.z - z) <= 48 * M).length;
  return {
    rank: i + 1,
    x: Math.round(x / M), z: Math.round(z / M), y: Math.round((h[0]! - sea) / M),
    score: +s.score.toFixed(2),
    steepSides: `${s.steepSides}/16`,
    approachFrom: s.approach,
    meanDrop160m: Math.round(s.drop160), meanDrop320m: Math.round(s.drop320),
    flatTop: `${Math.round(s.flat * 100)}% of a 96 m circle`,
    water: { kind: s.waterKind, metres: Math.round(s.waterM), direction: s.waterDir, ...(s.waterKind === 'river' ? { widthM: Math.round(s.waterWidthM) } : {}) },
    ground: Object.entries(Material).find(([, v]) => v === mat)?.[0] ?? String(mat),
    biome: biome !== undefined ? BIOME_NAMES[biome as BiomeId] : null,
    treesWithin48m: trees,
  };
});

// ---- Pictures.
mkdirSync(OUT, { recursive: true });
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const COLOR = new Map<number, [number, number, number]>([
  [Material.Grass, [96, 150, 70]], [Material.Meadow, [120, 165, 80]], [Material.DryGrass, [170, 160, 90]],
  [Material.JungleFloor, [60, 110, 50]], [Material.TaigaFloor, [80, 110, 75]], [Material.Tundra, [140, 135, 110]],
  [Material.Sand, [215, 200, 150]], [Material.Stone, [135, 135, 135]], [Material.Snow, [240, 242, 246]], [Material.Ice, [200, 225, 240]],
  [Material.Dirt, [120, 90, 60]],
]);
/** w x d samples `step` units apart around (cx, cz): ground colour, hill shading, contours, water. */
function picture(cx: number, cz: number, w: number, d: number, step: number, contourM: number, ring: { x: number; z: number; r: number } | null): Buffer {
  const x0 = cx - (w / 2) * step, z0 = cz - (d / 2) * step;
  const h = p.heights(x0, z0, w, d, step), mat = p.materials(x0, z0, w, d, step, h), water = p.water(x0, z0, w, d, step);
  const can = p.canopy(x0, z0, w, d, step, h, mat);
  const rgb = new Uint8Array(w * d * 3);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const k = i + w * j;
      let col: [number, number, number];
      if (h[k]! <= sea) col = [52, 92, 140];
      else if (water && water[k] !== NO_WATER && water[k]! > h[k]!) col = [60, 110, 170];
      else {
        col = [...(COLOR.get(mat[k]!) ?? [110, 140, 90])] as [number, number, number];
        if (can && can.top[k]! > h[k]!) col = [col[0] * 0.55, col[1] * 0.75, col[2] * 0.55];
        // Light from the north-west.
        const e = h[Math.min(w - 1, i + 1) + w * j]! - h[Math.max(0, i - 1) + w * j]!;
        const s = h[i + w * Math.min(d - 1, j + 1)]! - h[i + w * Math.max(0, j - 1)]!;
        const shade = Math.max(0.45, Math.min(1.35, 1 - ((e + s) / (2 * step)) * 1.2));
        col = col.map((v) => v * shade) as [number, number, number];
        // Contours.
        const band = (v: number) => Math.floor((v - sea) / M / contourM);
        if (i > 0 && j > 0 && (band(h[k]!) !== band(h[k - 1]!) || band(h[k]!) !== band(h[k - w]!))) col = col.map((v) => v * 0.7) as [number, number, number];
      }
      if (ring) {
        let dx = x0 + i * step - ring.x;
        if (wrap) dx -= Math.round(dx / world.widthUnits) * world.widthUnits;
        const rr = Math.hypot(dx, z0 + j * step - ring.z);
        if (Math.abs(rr - ring.r) < step * 1.2) col = [230, 30, 30];
      }
      rgb.set(col.map((v) => Math.max(0, Math.min(255, Math.round(v)))), k * 3);
    }
  }
  return png(w, d, rgb);
}
t0 = performance.now();
const OW = 1000, ostep = world.widthUnits / OW, OD = Math.round(world.depthUnits / ostep);
const overview = picture(world.widthUnits / 2, world.depthUnits / 2, OW, OD, ostep, 100, null);
writeFileSync(join(OUT, 'overview.png'), overview);
sites.forEach((s) => {
  writeFileSync(join(OUT, `site-${s.rank}.png`), picture(s.x * M, s.z * M, 400, 400, 8 * M, 20, { x: s.x * M, z: s.z * M, r: 70 * M }));
});
writeFileSync(join(OUT, 'sites.json'), JSON.stringify({ world: WORLD, widthM: world.widthUnits / M, depthM: world.depthUnits / M, overview: { width: OW, height: OD, metresPerPixel: ostep / M }, sites }, null, 2));
console.log(`pictures in ${((performance.now() - t0) / 1000).toFixed(1)} s; written to ${OUT}`);
for (const s of sites) {
  console.log(`#${s.rank} x ${s.x} z ${s.z} (${s.y} m up) score ${s.score} · steep ${s.steepSides}, road in from ${s.approachFrom ?? '—'} · drops ${s.meanDrop160m}/${s.meanDrop320m} m at 160/320 m · ${s.flatTop} · ${s.water.kind} ${s.water.metres} m ${s.water.direction}${s.water.kind === 'river' ? ` (${s.water.widthM} m wide)` : ''} · ${s.ground}, ${s.biome}, ${s.treesWithin48m} trees`);
}
