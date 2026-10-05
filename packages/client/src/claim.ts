import './fullscreen.js';
import { MAX_CLAIM_SIDE, MIN_CLAIM_SIDE, UNITS_PER_METER, WORLD_SHAPES, decodeClimate, isWorldShape, type Claim, type TerrainStroke, type VoxelizeConfig, type WorldShape } from '@super-vox/shared';
import { Diorama } from './diorama.js';
import { DEFAULT_DIORAMA_LIGHT } from './dioramaLight.js';
import type { TerraformRequest, TerraformResponse } from './terraform.worker.js';
import { SECTION_M } from './terraformArea.js';
import { climateTintColors } from './tintColors.js';
import { decodeWorldMap } from './worldMap.js';
import { WorldRelief, type ReliefRect } from './worldRelief.js';

/**
 * Claims: a world in 3D (as the terraformer shows it), where players mark out plots of land
 * (⌘-drag, up to MAX_CLAIM_SIDE a side) and claim them (kept by the server, see Claim), and open
 * a plot up close: a diorama of it and around it (made in this browser, as the terraformer's),
 * coarser the bigger it is. Planning and building on a plot come later.
 */

interface WorldInfo {
  name: string;
  spec: { generator: string; shape?: string; plates?: unknown; voxelize?: VoxelizeConfig };
}

/** A plot's corners (metres). */
interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const GOLD = 0xffd34d, MINE = 0x3fb950, OTHERS = 0xe6e6e6;
/** How deep a diorama's base goes below its lowest ground (units). */
const BASE_DEPTH = 16 * UNITS_PER_METER;

const worldEl = document.getElementById('world') as HTMLSelectElement;
const enterEl = document.getElementById('enter') as HTMLButtonElement;
const leaveEl = document.getElementById('leave') as HTMLButtonElement;
const giveUpEl = document.getElementById('give-up') as HTMLButtonElement;
const claimEl = document.getElementById('claim') as HTMLButtonElement;
const discardEl = document.getElementById('discard') as HTMLButtonElement;
const nameEl = document.getElementById('claim-name') as HTMLInputElement;
const formEl = document.getElementById('claim-form')!;
const noteEl = document.getElementById('claim-note')!;
const selectionEl = document.getElementById('selection')!;
const claimsEl = document.getElementById('claims')!;
const enterAbout = document.getElementById('enter-about')!;
const statusEl = document.getElementById('status')!;
const stage = document.getElementById('stage')!;
const hintEl = document.getElementById('hint')!;
const overviewControls = document.getElementById('overview-controls')!;
const dioramaControls = document.getElementById('diorama-controls')!;
const areaAbout = document.getElementById('area-about')!;
const miniatureEl = document.getElementById('miniature') as HTMLInputElement;
const birdsEl = document.getElementById('birds') as HTMLInputElement;
const seeThroughEl = document.getElementById('see-through') as HTMLInputElement;
const gridEl = document.getElementById('grid') as HTMLInputElement;
miniatureEl.addEventListener('change', () => diorama && (diorama.miniature = miniatureEl.checked));
birdsEl.addEventListener('change', () => diorama && (diorama.birdsOn = birdsEl.checked));
seeThroughEl.addEventListener('change', () => diorama && (diorama.seeThroughTrees = seeThroughEl.checked));
gridEl.addEventListener('change', () => diorama && (diorama.grid = gridEl.checked));

// The panel folds away (as the terraformer's).
const foldEl = document.getElementById('fold') as HTMLButtonElement;
foldEl.addEventListener('click', () => {
  const folded = document.body.classList.toggle('no-panel');
  foldEl.textContent = folded ? '›' : '‹';
  foldEl.title = folded ? 'Show the panel' : 'Hide the panel';
});

const HINT_OVERVIEW = '⌘-drag: mark out a plot · drag: move · right-drag: turn and tilt · wheel: zoom';
const HINT_DIORAMA = 'drag or middle-drag: move · right-drag: turn and tilt · wheel: zoom';

let worlds: WorldInfo[] = [];
let current = '';
let relief: WorldRelief | null = null;
let diorama: Diorama | null = null;
let showing: 'overview' | 'diorama' = 'overview';
/** The worker has the world built (its climate and sea level), and the terraforming applied to it. */
let ready: { climate: Uint8Array | null; seaLevel: number | null } | null = null;
let applied: TerrainStroke[] = [];
/** Claims here, who's asking (their account id), and whether they may claim. */
let claims: Claim[] = [];
let you: string | null = null;
let canClaim = false;
/** The plot being marked out (metres), or the claim chosen from the list. */
let selection: Rect | null = null;
let chosen: string | null = null;
let areaId = 0;
let lastAreaId = 0;
/** The plot showing up close, and the area made around it (units: corner, size, step, base). */
let opened: Rect | null = null;
let shownArea: { x0: number; z0: number; size: number; step: number; base: number } | null = null;

/**
 * The 1 m work area: in a plot shown coarser than a sample a metre, a DETAIL_M square around
 * where the view looks is made again a sample every metre (see AreaMaker.makeDetail), following
 * the view as it moves, once it's close enough to see the difference.
 */
const DETAIL_M = 512;
let detailAt: { x0: number; z0: number } | null = null;
let detailAsked: { x0: number; z0: number } | null = null;
let detailId = 0;

function followDetail(): void {
  const a = shownArea;
  if (!diorama || !a || showing !== 'diorama' || a.step <= UNITS_PER_METER || detailAsked) return;
  const t = diorama.target;
  if (t.distance > DETAIL_M * 1.5) return;
  const ax0 = a.x0 / UNITS_PER_METER, az0 = a.z0 / UNITS_PER_METER, size = a.size / UNITS_PER_METER;
  if (size < DETAIL_M) return;
  // Lined up with the area's sections, inside it, around where the view looks.
  const place = (c: number, a0: number) => a0 + Math.max(0, Math.min(size - DETAIL_M, Math.round((c - DETAIL_M / 2 - a0) / SECTION_M) * SECTION_M));
  const at = { x0: place(t.x, ax0), z0: place(t.z, az0) };
  if (detailAt && detailAt.x0 === at.x0 && detailAt.z0 === at.z0) return;
  detailAsked = at;
  send({ type: 'detail', id: ++detailId, x0: at.x0 * UNITS_PER_METER, z0: at.z0 * UNITS_PER_METER, size: DETAIL_M * UNITS_PER_METER, step: UNITS_PER_METER, base: a.base, strokes: applied });
}
setInterval(followDetail, 400);

function dropDetail(): void {
  detailAt = detailAsked = null;
  detailId++;
  diorama?.showDetail(null, null);
}

function status(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.className = bad ? 'bad' : '';
}

const shapeOf = (w: WorldInfo): WorldShape => (w.spec.shape && isWorldShape(w.spec.shape) ? w.spec.shape : 'flat-16x16');
const worldOf = () => WORLD_SHAPES[shapeOf(worlds.find((w) => w.name === current)!)];
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 2 : 0)} km` : `${m} m`);
const sizeOf = (r: Rect) => `${km(r.x1 - r.x0)} × ${km(r.z1 - r.z0)}`;
const mine = (c: Claim) => c.owner === you && (you !== null || c.owner === null);
/** What "Open up close" opens: the plot marked out, or the claim chosen. */
const target = (): Rect | null => selection ?? claims.find((c) => c.id === chosen) ?? null;

const worker = new Worker(new URL('./terraform.worker.ts', import.meta.url), { type: 'module' });
const send = (req: TerraformRequest) => worker.postMessage(req);

/** The plots drawn: every claim (yours green, others' white), and the plot marked out or chosen (gold). */
function drawPlots(): void {
  const rects: ReliefRect[] = claims.map((c) => ({ ...c, color: c.id === chosen ? GOLD : mine(c) ? MINE : OTHERS }));
  if (selection) rects.push({ ...selection, color: GOLD });
  relief?.setRects(rects);
  if (diorama && opened) diorama.setOutlines(rects.filter((r) => r.x1 > opened!.x0 - 4096 && r.x0 < opened!.x1 + 4096));
}

function showClaims(): void {
  claimsEl.replaceChildren();
  if (!claims.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'none yet';
    claimsEl.append(li);
  }
  for (const c of claims) {
    const li = document.createElement('li');
    if (c.id === chosen) li.className = 'selected';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `#${(mine(c) ? MINE : OTHERS).toString(16).padStart(6, '0')}`;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = `${c.name} · ${mine(c) ? 'yours' : c.ownerName}`;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = sizeOf(c);
    li.append(swatch, what, size);
    li.title = `${c.name}, claimed by ${c.ownerName}: ${sizeOf(c)} at x ${c.x0}..${c.x1}, z ${c.z0}..${c.z1} m`;
    li.addEventListener('click', () => {
      chosen = c.id;
      selection = null;
      relief?.lookAt(((c.x0 + c.x1) / 2) * UNITS_PER_METER, ((c.z0 + c.z1) / 2) * UNITS_PER_METER);
      showSelection();
    });
    claimsEl.append(li);
  }
}

function showSelection(): void {
  const t = target();
  selectionEl.textContent = selection ? `${sizeOf(selection)} at x ${selection.x0}, z ${selection.z0} m` : '';
  formEl.hidden = !selection || !canClaim;
  noteEl.textContent = selection && !canClaim ? 'Sign in (on the menu page) to claim it. You can still open it up close.' : '';
  const c = claims.find((x) => x.id === chosen);
  giveUpEl.hidden = !c || selection !== null || !mine(c);
  if (givingUp !== chosen) {
    givingUp = null;
    giveUpEl.textContent = 'Give it up';
  }
  enterEl.disabled = !t || !ready;
  enterAbout.textContent = t ? `${selection ? 'The plot marked out' : `"${c!.name}"`}: ${sizeOf(t)}, shown ${detailOf(t).stepM === 1 ? 'a sample every metre' : `a sample every ${detailOf(t).stepM} m (big plots are shown coarser)`}.` : 'Mark out a plot, or choose a claim.';
  showClaims();
  drawPlots();
}

/** The area to show around a plot (a square with some of its surroundings, metres) and how finely. */
function detailOf(r: Rect): { sizeM: number; stepM: number } {
  const side = Math.max(r.x1 - r.x0, r.z1 - r.z0);
  const sizeM = Math.ceil((side + Math.max(64, side * 0.15)) / 64) * 64;
  // (At most about 1.6 million samples: what the terraformer's 2 km view makes.)
  return { sizeM, stepM: sizeM <= 1280 ? 1 : sizeM <= 2560 ? 2 : 4 };
}

async function loadClaims(name: string): Promise<void> {
  const res = await fetch(`/api/worlds/${encodeURIComponent(name)}/claims`);
  if (!res.ok) throw new Error(`the claims request failed: ${res.status}`);
  const body = (await res.json()) as { claims: Claim[]; you: string | null; canClaim: boolean };
  if (current !== name) return;
  ({ claims, you, canClaim } = body);
  if (chosen && !claims.some((c) => c.id === chosen)) chosen = null;
  showSelection();
}

async function openWorld(name: string): Promise<void> {
  const info = worlds.find((w) => w.name === name);
  if (!info) return;
  current = name;
  ready = null;
  selection = null;
  chosen = null;
  showOverview();
  relief?.canvas.remove();
  relief?.dispose();
  relief = null;
  diorama?.canvas.remove();
  diorama?.dispose();
  diorama = null;
  history.replaceState(null, '', `#world=${encodeURIComponent(name)}`);
  const shape = shapeOf(info);
  const world = WORLD_SHAPES[shape];
  status(`loading ${name}…`);
  // The worker builds the world meanwhile (a few seconds for a big one), for opening plots.
  send({ type: 'world', key: name, shape, plates: info.spec.plates, voxelize: info.spec.voxelize ?? { minVoxelSize: 1, tolerance: 4 } });
  try {
    const q = `world=${encodeURIComponent(name)}`;
    const [mapRes, climateRes, strokesRes] = await Promise.all([fetch(`/api/world/map?width=1024&${q}`), fetch(`/api/world/climate?${q}`), fetch(`/api/worlds/${encodeURIComponent(name)}/strokes`), loadClaims(name)]);
    if (!mapRes.ok) throw new Error(`the map request failed: ${mapRes.status}`);
    const map = decodeWorldMap(await mapRes.arrayBuffer());
    if (climateRes.status === 200) map.colors = climateTintColors(map, decodeClimate(new Uint8Array(await climateRes.arrayBuffer())));
    applied = strokesRes.ok ? ((await strokesRes.json()) as { strokes: TerrainStroke[] }).strokes : [];
    if (current !== name) return;
    const middle = { x: world.widthUnits / 2, z: world.depthUnits / 2 };
    relief = new WorldRelief(map, { width: world.widthUnits, depth: world.depthUnits, wrapX: world.wrapX }, () => middle, middle, false);
    stage.prepend(relief.canvas);
    showSelection();
    status(ready ? '' : `building ${name} for opening plots up close…`);
  } catch (err) {
    status(`Couldn't load ${name}: ${(err as Error).message}`, true);
  }
}

// ⌘-drag (Ctrl-drag) marks out a plot, from the corner where it starts (the view stays put).
let marking: { x: number; z: number } | null = null;
stage.addEventListener(
  'pointerdown',
  (e) => {
    if (showing !== 'overview' || !relief || e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
    const at = groundUnder(e);
    if (!at) return;
    relief.panning = false;
    marking = at;
    chosen = null;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  },
  { capture: true },
);
stage.addEventListener('pointermove', (e) => {
  if (!marking) return;
  const at = groundUnder(e);
  if (!at) return;
  selection = plotBetween(marking, at);
  showSelection();
});
const endMarking = () => {
  if (!marking) return;
  marking = null;
  if (relief) relief.panning = true;
  if (selection && (selection.x1 - selection.x0 < MIN_CLAIM_SIDE || selection.z1 - selection.z0 < MIN_CLAIM_SIDE)) selection = null;
  showSelection();
  if (selection) nameEl.focus();
};
stage.addEventListener('pointerup', endMarking);
stage.addEventListener('pointercancel', endMarking);

/** The ground (metres) under the pointer, or null for the sky. */
function groundUnder(e: PointerEvent): { x: number; z: number } | null {
  const r = relief!.canvas.getBoundingClientRect();
  const p = relief!.pick(e.clientX - r.left, e.clientY - r.top);
  return p ? { x: p.hitX / UNITS_PER_METER, z: p.hitZ / UNITS_PER_METER } : null;
}

/** The plot from corner `a` toward `b` (metres): whole metres, at most MAX_CLAIM_SIDE a side (from `a`), within the world. */
function plotBetween(a: { x: number; z: number }, b: { x: number; z: number }): Rect {
  const w = worldOf(), W = w.widthUnits / UNITS_PER_METER, D = w.depthUnits / UNITS_PER_METER;
  const along = (from: number, to: number, size: number): [number, number] => {
    const lo = Math.round(Math.min(from, Math.max(to, from - MAX_CLAIM_SIDE))), hi = Math.round(Math.max(from, Math.min(to, from + MAX_CLAIM_SIDE)));
    return [Math.max(0, lo), Math.min(size, hi)];
  };
  const [x0, x1] = along(a.x, b.x, W), [z0, z1] = along(a.z, b.z, D);
  return { x0, z0, x1, z1 };
}

claimEl.addEventListener('click', async () => {
  if (!selection) return;
  const name = nameEl.value.trim();
  if (!name) {
    nameEl.focus();
    return status('give it a name first', true);
  }
  claimEl.disabled = true;
  try {
    const res = await fetch(`/api/worlds/${encodeURIComponent(current)}/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...selection }) });
    const body = (await res.json()) as { claim?: Claim; error?: string };
    if (!res.ok || !body.claim) return status(body.error ?? `claiming failed: ${res.status}`, true);
    selection = null;
    chosen = body.claim.id;
    nameEl.value = '';
    status(`claimed "${body.claim.name}"`);
    await loadClaims(current);
  } finally {
    claimEl.disabled = false;
  }
});
discardEl.addEventListener('click', () => {
  selection = null;
  showSelection();
});
giveUpEl.addEventListener('click', async () => {
  const c = claims.find((x) => x.id === chosen);
  if (!c || !confirmGiveUp(c)) return;
  const res = await fetch(`/api/worlds/${encodeURIComponent(current)}/claims/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
  if (!res.ok) return status(((await res.json()) as { error?: string }).error ?? `giving it up failed: ${res.status}`, true);
  chosen = null;
  status(`gave up "${c.name}"`);
  await loadClaims(current);
});
/** Asked in the panel (no browser dialog): the button asks again before giving it up. */
let givingUp: string | null = null;
function confirmGiveUp(c: Claim): boolean {
  if (givingUp === c.id) {
    givingUp = null;
    giveUpEl.textContent = 'Give it up';
    return true;
  }
  givingUp = c.id;
  giveUpEl.textContent = `Really give up "${c.name}"?`;
  return false;
}

worker.onmessage = (ev: MessageEvent<TerraformResponse>) => {
  const res = ev.data;
  if (res.type === 'ready') {
    if (res.key !== current) return;
    ready = { climate: res.climate, seaLevel: res.seaLevel };
    if (showing === 'overview') status('');
    showSelection();
  } else if (res.type === 'area') {
    if (res.id !== lastAreaId) return;
    showArea(res);
  } else if (res.type === 'detail') {
    const asked = detailAsked;
    detailAsked = null;
    if (res.id !== detailId || !diorama || showing !== 'diorama' || !asked) return;
    detailAt = asked;
    diorama.showDetail(res.parts, { x0: res.x0 / UNITS_PER_METER, z0: res.z0 / UNITS_PER_METER, size: res.size / UNITS_PER_METER });
    status(`a sample every metre around where you look (${DETAIL_M} m), made in ${Math.round(res.ms)} ms`);
    followDetail();
  } else if (res.type === 'error') {
    status(res.error, true);
    showSelection();
  }
};

/** Opens the plot up close: the worker makes the area around it, then the diorama shows it. */
function enter(): void {
  const t = target();
  if (!relief || !ready || !t) return;
  const world = worldOf();
  const { sizeM, stepM } = detailOf(t);
  const size = sizeM * UNITS_PER_METER, step = stepM * UNITS_PER_METER;
  // Centred on the plot, inside the world (round worlds wrap east-west).
  let x0 = Math.round((t.x0 + t.x1) / 2 - sizeM / 2) * UNITS_PER_METER;
  let z0 = Math.round((t.z0 + t.z1) / 2 - sizeM / 2) * UNITS_PER_METER;
  if (!world.wrapX) x0 = Math.max(0, Math.min(world.widthUnits - size, x0));
  z0 = Math.max(0, Math.min(world.depthUnits - size, z0));
  enterEl.disabled = true;
  opened = { ...t };
  status('making the plot and around it…');
  areaAbout.textContent = `${sizeOf(t)}, shown with ${km(sizeM)} around it, a sample every ${stepM} m${stepM > 1 ? `; zoom in for a sample every metre around where you look (${DETAIL_M} m)` : ''}.`;
  lastAreaId = ++areaId;
  send({ type: 'area', id: lastAreaId, x0, z0, size, step, depth: BASE_DEPTH, strokes: applied });
}

function showArea(made: Extract<TerraformResponse, { type: 'area' }>): void {
  if (!diorama) {
    diorama = new Diorama(ready!.climate, worldOf().wrapX, ready!.seaLevel);
    diorama.setLight(DEFAULT_DIORAMA_LIGHT);
    diorama.miniature = miniatureEl.checked;
    diorama.birdsOn = birdsEl.checked;
    diorama.seeThroughTrees = seeThroughEl.checked;
    diorama.grid = gridEl.checked;
    stage.prepend(diorama.canvas);
  }
  showing = 'diorama';
  dropDetail();
  shownArea = { x0: made.x0, z0: made.z0, size: made.size, step: made.step, base: made.base };
  relief!.canvas.hidden = true;
  diorama.canvas.hidden = false;
  overviewControls.hidden = true;
  dioramaControls.hidden = false;
  hintEl.textContent = HINT_DIORAMA;
  const t0 = performance.now();
  diorama.show(made.parts, made);
  diorama.setField(made.heights, made.n, made.step, made.x0, made.z0);
  drawPlots();
  status(`made in ${(made.ms / 1000).toFixed(1)} s (${Math.round(made.quads / 1000)}k faces), shown in ${Math.round(performance.now() - t0)} ms`);
  enterEl.disabled = false;
}

function showOverview(): void {
  showing = 'overview';
  opened = null;
  shownArea = null;
  dropDetail();
  if (relief) relief.canvas.hidden = false;
  if (diorama) diorama.canvas.hidden = true;
  overviewControls.hidden = false;
  dioramaControls.hidden = true;
  hintEl.textContent = HINT_OVERVIEW;
}

enterEl.addEventListener('click', enter);
leaveEl.addEventListener('click', () => (showOverview(), status('')));
worldEl.addEventListener('change', () => void openWorld(worldEl.value));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  if (e.code === 'KeyG' && diorama && showing === 'diorama') {
    gridEl.checked = !gridEl.checked;
    diorama.grid = gridEl.checked;
  }
  if (e.code === 'Escape' && showing === 'overview' && selection) {
    selection = null;
    showSelection();
  }
});

function frame(): void {
  if (showing === 'overview') relief?.render();
  else diorama?.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function start(): Promise<void> {
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) throw new Error(`the server said ${res.status}`);
    const body = (await res.json()) as { default: string; worlds: WorldInfo[] };
    // (Plots open up close the terraformer's way: plate worlds.)
    worlds = body.worlds.filter((w) => w.spec.generator === 'plates');
    if (worlds.length === 0) return status('No plate worlds here.', true);
    worldEl.replaceChildren(...worlds.map((w) => new Option(w.name, w.name)));
    const asked = new URLSearchParams(location.hash.slice(1)).get('world');
    const pick = [asked, body.default].find((n) => n && worlds.some((w) => w.name === n)) ?? worlds[0]!.name;
    worldEl.value = pick;
    worldEl.disabled = false;
    await openWorld(pick);
  } catch (err) {
    status(`Couldn't list the worlds: ${(err as Error).message}`, true);
  }
}
hintEl.textContent = HINT_OVERVIEW;
void start();
