import './fullscreen.js';
import { DEFAULT_SITE_SEARCH, SITE_LIMITS, WORLD_SHAPES, isWorldShape, validateSiteSearch, type CastleSite, type SiteSearch, type WorldShape } from '@super-vox/shared';
import type { SitesRequest, SitesResponse } from './sites.worker.js';

/**
 * The castle site finder page: pick a world and what makes a good site; a worker rebuilds the
 * world's terrain and ranks hilltops near water (findSites); each result links into the game.
 * The settings live in the URL's hash, so a search can be bookmarked or shared.
 */

interface WorldInfo {
  name: string;
  spec: { generator: string; shape?: string; plates?: unknown };
}

const form = document.getElementById('form') as HTMLFormElement;
const worldEl = document.getElementById('world') as HTMLSelectElement;
const findEl = document.getElementById('find') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const mapEl = document.getElementById('world-map')!;
const overviewEl = document.getElementById('overview') as HTMLCanvasElement;
const pinsEl = document.getElementById('pins')!;
const emptyEl = document.getElementById('empty')!;
const sitesEl = document.getElementById('sites')!;

const NUMBER_FIELDS = ['minHeight', 'maxHeight', 'steepDrop', 'waterWithin', 'count', 'spacing'] as const;
const LIMITS: Record<(typeof NUMBER_FIELDS)[number], readonly [number, number]> = {
  minHeight: SITE_LIMITS.height, maxHeight: SITE_LIMITS.height, steepDrop: SITE_LIMITS.steepDrop,
  waterWithin: SITE_LIMITS.waterWithin, count: SITE_LIMITS.count, spacing: SITE_LIMITS.spacing,
};
const input = (k: string) => document.getElementById(k) as HTMLInputElement | HTMLSelectElement;
for (const k of NUMBER_FIELDS) Object.assign(input(k), { min: String(LIMITS[k][0]), max: String(LIMITS[k][1]) });

let worlds: WorldInfo[] = [];

/** A world's shape; worlds made before shapes are flat 16 x 16 km, as on the server. */
const worldShape = (w: WorldInfo): WorldShape => (w.spec.shape && isWorldShape(w.spec.shape) ? w.spec.shape : 'flat-16x16');

function status(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.className = bad ? 'bad' : '';
}

function showSearch(s: SiteSearch): void {
  for (const k of NUMBER_FIELDS) input(k).value = String(s[k]);
  input('water').value = s.water;
}

function readSearch(): SiteSearch {
  const s = { ...DEFAULT_SITE_SEARCH, water: input('water').value === 'any' ? 'any' : 'river' } as SiteSearch;
  for (const k of NUMBER_FIELDS) s[k] = Number(input(k).value);
  return s;
}

/** The search and world in the URL's hash (#world=…&minHeight=…), falling back to the defaults. */
function fromHash(): { world: string | null; search: SiteSearch } {
  const h = new URLSearchParams(location.hash.slice(1));
  const s = { ...DEFAULT_SITE_SEARCH };
  for (const k of NUMBER_FIELDS) {
    const v = Number(h.get(k));
    if (h.has(k) && Number.isFinite(v)) s[k] = v;
  }
  if (h.get('water') === 'any' || h.get('water') === 'river') s.water = h.get('water') as SiteSearch['water'];
  return { world: h.get('world'), search: s };
}

function toHash(world: string, s: SiteSearch): void {
  const h = new URLSearchParams([['world', world], ...NUMBER_FIELDS.map((k) => [k, String(s[k])]), ['water', s.water]]);
  history.replaceState(null, '', `#${h}`);
}

// ---- Searching, in a worker; only the newest search's answer counts.
const worker = new Worker(new URL('./sites.worker.ts', import.meta.url), { type: 'module' });
let sentId = 0;
let sentWorld = '';
/** The overview shown, and which world it's of. */
let overviewOf = '';

function find(): void {
  const world = worlds.find((w) => w.name === worldEl.value);
  if (!world) return;
  const search = readSearch();
  try {
    validateSiteSearch(search);
  } catch (err) {
    status((err as Error).message, true);
    return;
  }
  toHash(world.name, search);
  const req: SitesRequest = { id: ++sentId, world: world.name, shape: worldShape(world), plates: world.spec.plates, search };
  sentWorld = world.name;
  findEl.disabled = true;
  mapEl.classList.add('busy');
  status('starting…');
  worker.postMessage(req);
}

worker.onmessage = (ev: MessageEvent<SitesResponse>) => {
  const res = ev.data;
  if (res.id !== sentId) return;
  if (res.type === 'progress') {
    status(res.text);
    return;
  }
  findEl.disabled = false;
  mapEl.classList.remove('busy');
  if (res.type === 'error') {
    status(res.error, true);
    return;
  }
  const world = worlds.find((w) => w.name === sentWorld)!;
  if (res.overview) {
    overviewEl.width = res.overview.width;
    overviewEl.height = res.overview.height;
    overviewEl.getContext('2d')!.putImageData(new ImageData(res.overview.pixels as Uint8ClampedArray<ArrayBuffer>, res.overview.width, res.overview.height), 0, 0);
    overviewOf = sentWorld;
  }
  mapEl.hidden = overviewOf !== sentWorld;
  showSites(world, res.sites, res.crops, res.cropSize, res.cropMetres);
  status(res.sites.length ? `${res.sites.length} site${res.sites.length === 1 ? '' : 's'} found.` : '');
};
worker.onerror = (e) => {
  findEl.disabled = false;
  mapEl.classList.remove('busy');
  status(`search failed: ${e.message}`, true);
};

/** "JungleFloor" → "jungle floor". */
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function showSites(world: WorldInfo, sites: CastleSite[], crops: Uint8ClampedArray[], size: number, metres: number): void {
  const dims = WORLD_SHAPES[worldShape(world)];
  const widthM = dims.widthUnits / 16, depthM = dims.depthUnits / 16;
  pinsEl.replaceChildren();
  sitesEl.replaceChildren();
  emptyEl.hidden = sites.length > 0;
  if (sites.length === 0) emptyEl.textContent = 'No sites match. Try a wider height band, water further away, or a smaller steep side.';
  sites.forEach((s, i) => {
    const pin = document.createElement('a');
    pin.className = 'pin';
    pin.href = `#site-${s.rank}`;
    pin.style.left = `${(s.x / widthM) * 100}%`;
    pin.style.top = `${(s.z / depthM) * 100}%`;
    pin.setAttribute('aria-label', `Site ${s.rank}`);
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(`site-${s.rank}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const label = document.createElement('span');
    label.textContent = String(s.rank);
    pin.append(label);
    pinsEl.append(pin);

    const card = document.createElement('article');
    card.className = 'site';
    card.id = `site-${s.rank}`;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.title = `${(size * metres) / 1000} km square, 20 m contours, north up`;
    canvas.getContext('2d')!.putImageData(new ImageData(crops[i]! as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    const facts = document.createElement('div');
    facts.className = 'facts';
    const head = document.createElement('header');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(s.rank);
    const title = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = `${s.biome ? s.biome[0]!.toUpperCase() + s.biome.slice(1) + ' hill' : 'Hill'}, ${s.y} m`;
    const coords = document.createElement('div');
    coords.className = 'coords';
    coords.textContent = `x ${s.x}  z ${s.z}`;
    title.append(h3, coords);
    const go = document.createElement('a');
    go.className = 'go';
    go.href = `/play.html?world=${encodeURIComponent(world.name)}&x=${s.x}&z=${s.z}`;
    go.textContent = 'Go there';
    head.append(rank, title, go);
    const tags = document.createElement('div');
    tags.className = 'tags';
    const tag = (text: string, kind = '') => {
      const t = document.createElement('span');
      t.className = `tag ${kind}`;
      t.textContent = text;
      tags.append(t);
    };
    if (s.ground === 'Snow') tag('snow on top', 'cold');
    else if (s.biome === 'tundra' || s.biome === 'ice') tag('cold', 'cold');
    if (s.water.metres <= 800) tag(`${s.water.kind} close`, 'good');
    if (s.trees > 60) tag('clear trees first');
    const dl = document.createElement('dl');
    const row = (k: string, v: string) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    };
    row('Steep sides', `${s.steepSides} of 16`);
    row('Falls away', `${s.drop160} m within 160 m, ${s.drop320} m within 320 m`);
    row('Flat top', `${Math.round(s.flatTop * 100)}% of a 96 m circle`);
    row('Road in from', s.approachFrom ?? 'no gentle side');
    row('Water', `${s.water.kind} ${s.water.metres} m ${s.water.direction}${s.water.widthM !== null ? `, ${s.water.widthM} m wide` : ''}`);
    row('Ground', `${words(s.ground)}, ${s.trees} trees within 48 m`);
    row('Score', s.score.toFixed(2));
    facts.append(head, tags, dl);
    card.append(canvas, facts);
    sitesEl.append(card);
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  find();
});
document.getElementById('reset')!.addEventListener('click', () => showSearch(DEFAULT_SITE_SEARCH));

async function start(): Promise<void> {
  const initial = fromHash();
  showSearch(initial.search);
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) throw new Error(`the server said ${res.status}`);
    const body = (await res.json()) as { default: string; worlds: WorldInfo[] };
    worlds = body.worlds.filter((w) => w.spec.generator === 'plates');
    worldEl.replaceChildren(...worlds.map((w) => new Option(w.name, w.name)));
    if (worlds.length === 0) {
      status('No plate worlds to search.', true);
      return;
    }
    const pick = [initial.world, body.default].find((n) => n && worlds.some((w) => w.name === n)) ?? worlds[0]!.name;
    worldEl.value = pick;
    worldEl.disabled = false;
    findEl.disabled = false;
    find();
  } catch (err) {
    status(`Couldn't list the worlds: ${(err as Error).message}`, true);
  }
}
void start();
