/**
 * Castle site finder (command line): hilltops near a river, ranked, for a world on the live
 * server (or any server). It reads the world's settings from <server>/api/worlds and rebuilds its
 * terrain here with the same generator the server runs (nothing else is asked of the server),
 * then searches it as the site finder page does (findSites in packages/shared/src/sites.ts).
 *
 *   npx tsx tools/castle-sites.ts [--world cartesian] [--server https://voxel.ericbrandcode.com]
 *     [--min 60] [--max 225] [--river 1500] [--water river|any] [--steep 20] [--count 12]
 *     [--spacing 1500] [--out data/castle-sites]
 *
 * Writes sites.json, overview.png (the world) and site-N.png (3.2 km around each site: ground
 * colours, hill shading, 20 m contours, water, the site ringed in red) to --out/<world>.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  DEFAULT_SITE_SEARCH,
  PlateHeights,
  WORLD_SHAPES,
  findSites,
  migratePlateTerrain,
  sitePicture,
  type SiteSearch,
  type WorldShape,
} from '../packages/shared/src/index.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const arg = (k: string, d: string | number) => args.get(k) ?? String(d);
const SERVER = arg('server', 'https://voxel.ericbrandcode.com');
const WORLD = arg('world', 'cartesian');
const OUT = join(arg('out', 'data/castle-sites'), WORLD);
const D = DEFAULT_SITE_SEARCH;
const search: SiteSearch = {
  minHeight: Number(arg('min', D.minHeight)),
  maxHeight: Number(arg('max', D.maxHeight)),
  waterWithin: Number(arg('river', D.waterWithin)),
  water: arg('water', D.water) === 'any' ? 'any' : 'river',
  steepDrop: Number(arg('steep', D.steepDrop)),
  count: Number(arg('count', D.count)),
  spacing: Number(arg('spacing', D.spacing)),
};
const M = 16;

const res = await fetch(`${SERVER}/api/worlds`);
if (!res.ok) throw new Error(`${SERVER}/api/worlds: ${res.status}`);
const list = (await res.json()) as { worlds: { name: string; spec: { generator: string; plates?: unknown; shape?: WorldShape } }[] };
const entry = list.worlds.find((w) => w.name === WORLD);
if (!entry) throw new Error(`no world "${WORLD}" (there are: ${list.worlds.map((w) => w.name).join(', ')})`);
if (entry.spec.generator !== 'plates') throw new Error(`"${WORLD}" isn't a plate world`);
// (Worlds made before shapes are flat 16 x 16 km, as on the server.)
const world = WORLD_SHAPES[entry.spec.shape ?? 'flat-16x16'];
let t0 = performance.now();
const p = new PlateHeights(world, migratePlateTerrain(entry.spec.plates));
console.log(`${WORLD}: ${world.widthUnits / M / 1000} x ${world.depthUnits / M / 1000} km, built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
t0 = performance.now();
const sites = findSites(p, world, search);
console.log(`searched in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

/** An RGB PNG from RGBA pixels. */
function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = rgba[(x + w * y) * 4 + c]!;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(OUT, { recursive: true });
const OW = 1000, ostep = world.widthUnits / OW, OD = Math.round(world.depthUnits / ostep);
writeFileSync(join(OUT, 'overview.png'), png(OW, OD, sitePicture(p, world, world.widthUnits / 2, world.depthUnits / 2, OW, OD, ostep, 100)));
for (const s of sites) writeFileSync(join(OUT, `site-${s.rank}.png`), png(400, 400, sitePicture(p, world, s.x * M, s.z * M, 400, 400, 8 * M, 20, { x: s.x * M, z: s.z * M, r: 70 * M })));
writeFileSync(join(OUT, 'sites.json'), JSON.stringify({ world: WORLD, widthM: world.widthUnits / M, depthM: world.depthUnits / M, search, overview: { width: OW, height: OD, metresPerPixel: ostep / M }, sites }, null, 2));
console.log(`written to ${OUT}`);
for (const s of sites) {
  const w = s.water;
  console.log(
    `#${s.rank} x ${s.x} z ${s.z} (${s.y} m up) score ${s.score} · steep ${s.steepSides}/16, road in from ${s.approachFrom ?? '—'} · drops ${s.drop160}/${s.drop320} m at 160/320 m · ` +
      `flat ${Math.round(s.flatTop * 100)}% · ${w.kind} ${w.metres} m ${w.direction}${w.widthM !== null ? ` (${w.widthM} m wide)` : ''} · ${s.ground}, ${s.biome}, ${s.trees} trees`,
  );
}
