import './fullscreen.js';
import { MAX_CLAIM_SIDE, MIN_CLAIM_SIDE, PLAN_LIMITS, PLAN_PIECE, UNITS_PER_METER, WORLD_SHAPES, decodeClimate, designMaterial, isWorldShape, itemName, madeOf, pieceName, planTotals, capHeight, type Claim, type ObjectDesign, type Plan, type PlanElement, type TerrainStroke, type VoxelizeConfig, type WorldShape } from '@super-vox/shared';
import { planGroup } from './planView.js';
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
const animalsEl = document.getElementById('animals') as HTMLInputElement;
animalsEl.addEventListener('change', () => diorama && (diorama.animalsOn = animalsEl.checked));
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
    diorama.showDetail(res.parts, { x0: res.x0 / UNITS_PER_METER, z0: res.z0 / UNITS_PER_METER, size: res.size / UNITS_PER_METER }, { heights: res.heights, n: res.n });
    status(`a sample every metre around where you look (${DETAIL_M} m), made in ${Math.round(res.ms)} ms`);
    // (The plan stands on the finer ground now.)
    showPlan();
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
    diorama.animalsOn = animalsEl.checked;
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
  diorama.setField(made.heights, made.n, made.step, made.x0, made.z0, made.cover);
  drawPlots();
  // A claim's plan (a plot only marked out has none yet).
  openPlan(selection ? null : (claims.find((c) => c.id === chosen) ?? null));
  status(`made in ${(made.ms / 1000).toFixed(1)} s (${Math.round(made.quads / 1000)}k faces), shown in ${Math.round(performance.now() - t0)} ms`);
  enterEl.disabled = false;
}

function showOverview(): void {
  showing = 'overview';
  opened = null;
  shownArea = null;
  dropDetail();
  if (diorama) {
    diorama.showPlan(null);
    diorama.onPaint = null;
  }
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

// --- The plan: what the owner means to build on the plot (see Plan), drawn and edited up close. ---

type PlanTool = 'look' | 'wall' | 'tower' | 'building';
const planControls = document.getElementById('plan-controls')!;
const planAbout = document.getElementById('plan-about')!;
const planToolAbout = document.getElementById('plan-tool-about')!;
const planList = document.getElementById('plan-list')!;
const planEdit = document.getElementById('plan-edit')!;
const planTotalsEl = document.getElementById('plan-totals')!;
const planSaved = document.getElementById('plan-saved')!;
const heightEl = document.getElementById('pe-height') as HTMLInputElement;
const sizeEl = document.getElementById('pe-size') as HTMLInputElement;
const sizeRow = document.getElementById('pe-size-row')!;
const sizeLabel = document.getElementById('pe-size-label')!;
const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('.plan-tools .tool')];
const designEl = document.getElementById('pe-design') as HTMLSelectElement;
const designNote = document.getElementById('pe-design-note')!;

/** The designs (see the Object designer), for what plans are made of; and the last chosen for each kind, for new ones. */
let designs: ObjectDesign[] = [];
const lastDesign: Partial<Record<PlanElement['kind'], string>> = {};
async function loadDesigns(): Promise<void> {
  try {
    const res = await fetch('/api/designs');
    if (res.ok) designs = ((await res.json()) as { designs: ObjectDesign[] }).designs;
  } catch {
    // (None: elements are drawn plain.)
  }
  showPlan();
}
const designOf = (id: string | undefined) => (id ? designs.find((d) => d.id === id) : undefined);
const TOOL_ABOUT: Record<PlanTool, string> = {
  look: 'Move about; choose something planned from the list to change it.',
  wall: '⌘-drag (Ctrl-drag) a straight run of wall. Start a drag at a wall\'s end to carry it on.',
  tower: '⌘-click (Ctrl-click) for a tower, or ⌘-drag from its middle out to its size.',
  building: '⌘-drag (Ctrl-drag) a building\'s footprint, from one corner to the other.',
};

/** The claim showing up close, if it's a claim (not a plot only marked out), its plan, and whether it's ours to change. */
let planClaim: Claim | null = null;
let plan: Plan = { elements: [] };
let planMine = false;
let tool: PlanTool = 'look';
let chosenEl: string | null = null;
/** What's being drawn (not in the plan yet). */
let drawing: PlanElement | null = null;
const undoStack: PlanElement[][] = [];
const redoStack: PlanElement[][] = [];

/** Shows the plan of the claim opened up close (or none, for a plot only marked out). */
function openPlan(claim: Claim | null): void {
  planClaim = claim;
  plan = { elements: claim?.plan?.elements.map((e) => ({ ...e })) ?? [] };
  planMine = !!claim && mine(claim);
  chosenEl = null;
  drawing = null;
  undoStack.length = redoStack.length = 0;
  if (claim) void loadDesigns();
  planControls.hidden = !claim;
  planAbout.textContent = !claim ? '' : planMine ? 'Lay out what you mean to build: walls, towers and buildings, inside the plot. Saved as you go.' : `${claim.ownerName}'s plan (only its owner changes it).`;
  for (const b of toolButtons) b.disabled = !planMine;
  setTool('look');
  showPlan();
}

function setTool(t: PlanTool): void {
  tool = planMine ? t : 'look';
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  planToolAbout.textContent = planMine ? TOOL_ABOUT[tool] : '';
  if (diorama) {
    diorama.onPaint = tool === 'look' ? null : planPaint;
    diorama.setBrush(null);
  }
}
for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool as PlanTool));

const describe = (e: PlanElement): string => {
  const d = designOf(e.design);
  // (Walls and towers are topped with their design; buildings are it.)
  const made = !e.design ? '' : !d ? ' (a design no longer there)' : e.kind === 'building' ? ` (${d.name})` : `, topped with ${d.name}`;
  return (e.kind === 'wall' ? `wall, ${Math.round(Math.hypot(e.x1 - e.x0, e.z1 - e.z0))} m long, ${e.height} m high` : e.kind === 'tower' ? (d ? `tower, ${d.size[0]} × ${d.size[2]} m, ${e.height} m high` : `tower, ${e.radius * 2} m across, ${e.height} m high`) : `building, ${e.x1 - e.x0} × ${e.z1 - e.z0} m, ${e.height} m to the eaves`) + made;
};

/** Draws the plan (and what's being drawn), lists it, and shows what's chosen. */
function showPlan(): void {
  const capOf = (e: PlanElement) => {
    const d = designOf(e.design);
    return d ? { height: capHeight(d), width: d.size[0], depth: d.size[2] } : null;
  };
  if (diorama) diorama.showPlan(planClaim ? planGroup({ elements: drawing ? [...plan.elements, drawing] : plan.elements }, (x, z) => diorama!.groundAt(x, z), chosenEl, capOf) : null);
  planList.replaceChildren();
  if (planClaim && !plan.elements.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = planMine ? 'nothing planned yet: pick a tool' : 'nothing planned';
    planList.append(li);
  }
  for (const e of plan.elements) {
    const li = document.createElement('li');
    if (e.id === chosenEl) li.className = 'selected';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = describe(e);
    li.append(what);
    li.addEventListener('click', () => {
      chosenEl = chosenEl === e.id ? null : e.id;
      editBase = null;
      showPlan();
    });
    planList.append(li);
  }
  const t = planTotals(plan);
  planTotalsEl.textContent = `${Math.round(t.wallLength)} m of wall · ${t.towers} tower${t.towers === 1 ? '' : 's'} · ${t.buildings} building${t.buildings === 1 ? '' : 's'} (${t.floorArea} m²)`;
  const chosen = plan.elements.find((e) => e.id === chosenEl);
  planEdit.hidden = !chosen || !planMine;
  if (chosen && planMine) {
    // What it's made of: the designs that are its kind of piece.
    const piece = PLAN_PIECE[chosen.kind], fits = designs.filter((d) => d.piece === piece);
    designEl.replaceChildren(new Option('nothing chosen yet (plain)', ''), ...fits.map((d) => new Option(`${d.name} (${d.size.join(' × ')} m)`, d.id)));
    if (chosen.design && !fits.some((d) => d.id === chosen.design)) designEl.append(new Option('a design no longer there', chosen.design));
    designEl.value = chosen.design ?? '';
    const made = designOf(chosen.design);
    designNote.textContent = !chosen.design
      ? fits.length ? '' : `No ${pieceName(piece)} designs yet: make one in the Object designer (as "a ${pieceName(piece)}").`
      : chosen.kind === 'wall' && made
        ? `Its top ${capHeight(made)} m is the design; below, solid ${itemName(designMaterial(made))} as high as you make it. Its thickness is the design's.`
        : chosen.kind === 'tower' && made
          ? `Its top ${capHeight(made)} m is the design; below, solid ${itemName(designMaterial(made))} as high as you make it. Its footprint (${made.size[0]} × ${made.size[2]} m) is the design's.`
        : 'Its size follows its design.';
    // (A wall's or tower's height is still yours, down to its design's; the rest follows the design.)
    heightEl.disabled = !!chosen.design && chosen.kind === 'building';
    sizeEl.disabled = !!chosen.design;
    const L = PLAN_LIMITS[chosen.kind];
    const least = chosen.kind !== 'building' && made ? Math.max(L.height[0], capHeight(made)) : L.height[0];
    setSlider(heightEl, [least, L.height[1]], chosen.height, 'pe-height-v');
    sizeRow.hidden = chosen.kind === 'building';
    if (chosen.kind === 'wall') {
      sizeLabel.textContent = 'Thickness';
      setSlider(sizeEl, PLAN_LIMITS.wall.thickness, chosen.thickness, 'pe-size-v');
    } else if (chosen.kind === 'tower') {
      sizeLabel.textContent = 'Radius';
      setSlider(sizeEl, PLAN_LIMITS.tower.radius, chosen.radius, 'pe-size-v');
    }
  }
  (document.getElementById('plan-undo') as HTMLButtonElement).disabled = !planMine || !undoStack.length;
  (document.getElementById('plan-redo') as HTMLButtonElement).disabled = !planMine || !redoStack.length;
}

function setSlider(el: HTMLInputElement, [lo, hi]: readonly number[], v: number, shown: string): void {
  el.min = String(lo);
  el.max = String(hi);
  el.value = String(v);
  document.getElementById(shown)!.textContent = `${v} m`;
}

/** A change to the plan: undoable, saved. */
function changed(before: PlanElement[]): void {
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  savePlan();
  showPlan();
}
const snapshot = () => plan.elements.map((e) => ({ ...e }));

// Sliders change the chosen element as they move; one undo step a drag.
let editBase: PlanElement[] | null = null;
function editChosen(apply: (e: PlanElement, v: number) => PlanElement | null, v: number): void {
  const i = plan.elements.findIndex((e) => e.id === chosenEl);
  if (i < 0) return;
  editBase ??= snapshot();
  const next = apply(plan.elements[i]!, v);
  if (!next) return;
  plan.elements[i] = next;
  showPlan();
}
heightEl.addEventListener('input', () => editChosen((e, v) => ({ ...e, height: v }), Number(heightEl.value)));
sizeEl.addEventListener('input', () =>
  editChosen((e, v) => {
    if (e.kind === 'wall') return { ...e, thickness: v };
    if (e.kind !== 'tower' || !opened) return null;
    // (A tower stays inside the plot: no bigger than room for it.)
    const room = Math.min(e.x - opened.x0, opened.x1 - e.x, e.z - opened.z0, opened.z1 - e.z);
    return { ...e, radius: Math.min(v, room) };
  }, Number(sizeEl.value)),
);
for (const el of [heightEl, sizeEl])
  el.addEventListener('change', () => {
    if (!editBase) return;
    const base = editBase;
    editBase = null;
    changed(base);
  });

designEl.addEventListener('change', () => {
  const i = plan.elements.findIndex((e) => e.id === chosenEl);
  if (i < 0 || !opened) return;
  const before = snapshot(), el = plan.elements[i]!;
  const next = fitIn(madeOf(el, designOf(designEl.value) ?? null));
  if (!next) {
    planSaved.textContent = "that design doesn't fit in the plot there";
    showPlan();
    return;
  }
  if (designEl.value) lastDesign[el.kind] = designEl.value;
  plan.elements[i] = next;
  changed(before);
});

/** An element moved (towers, buildings) to fit in the plot, if it can; null if it can't. */
function fitIn(e: PlanElement): PlanElement | null {
  const r = opened!;
  if (e.kind === 'tower') return fitTower(e);
  if (e.kind === 'building') {
    const w = e.x1 - e.x0, d = e.z1 - e.z0;
    if (w > r.x1 - r.x0 || d > r.z1 - r.z0) return null;
    const x0 = Math.max(r.x0, Math.min(r.x1 - w, e.x0)), z0 = Math.max(r.z0, Math.min(r.z1 - d, e.z0));
    return { ...e, x0, z0, x1: x0 + w, z1: z0 + d };
  }
  return e;
}

function deleteChosen(): void {
  if (!planMine || !chosenEl) return;
  const before = snapshot();
  plan.elements = plan.elements.filter((e) => e.id !== chosenEl);
  chosenEl = null;
  changed(before);
}
document.getElementById('pe-delete')!.addEventListener('click', deleteChosen);

function undo(): void {
  const prev = undoStack.pop();
  if (!prev || !planMine) return;
  redoStack.push(snapshot());
  plan.elements = prev;
  if (!plan.elements.some((e) => e.id === chosenEl)) chosenEl = null;
  savePlan();
  showPlan();
}
function redo(): void {
  const next = redoStack.pop();
  if (!next || !planMine) return;
  undoStack.push(snapshot());
  plan.elements = next;
  savePlan();
  showPlan();
}
document.getElementById('plan-undo')!.addEventListener('click', undo);
document.getElementById('plan-redo')!.addEventListener('click', redo);
window.addEventListener('keydown', (e) => {
  if (showing !== 'diorama' || !planMine || e.target instanceof HTMLInputElement) return;
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (e.code === 'Delete' || e.code === 'Backspace') deleteChosen();
});

/** Saved a moment after the last change (one request at a time). */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false, saveAgain = false;
function savePlan(): void {
  if (!planClaim || !planMine) return;
  planSaved.textContent = 'saving…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void sendPlan(), 600);
}
async function sendPlan(): Promise<void> {
  const claim = planClaim;
  if (!claim) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  const body: Plan = { elements: plan.elements.map((e) => ({ ...e })) };
  try {
    const res = await fetch(`/api/worlds/${encodeURIComponent(current)}/claims/${encodeURIComponent(claim.id)}/plan`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const reply = (await res.json()) as { error?: string };
    if (!res.ok) planSaved.textContent = `not saved: ${reply.error ?? res.status}`;
    else {
      claim.plan = body;
      planSaved.textContent = 'saved';
    }
  } catch (err) {
    planSaved.textContent = `not saved: ${(err as Error).message}`;
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      void sendPlan();
    }
  }
}

const newId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A point (metres) to whole metres, inside the plot. */
function snapIn(p: { x: number; z: number }): { x: number; z: number } {
  const r = opened!;
  return { x: Math.max(r.x0, Math.min(r.x1, Math.round(p.x))), z: Math.max(r.z0, Math.min(r.z1, Math.round(p.z))) };
}

/** ⌘-dragging with a plan tool: what it makes follows the drag, and goes into the plan when let go. */
let drawFrom: { x: number; z: number } | null = null;
function planPaint(phase: 'start' | 'move' | 'end', at: { x: number; y: number; z: number } | null): void {
  if (!planMine || !opened || tool === 'look') return;
  if (phase === 'end') {
    let d = drawing;
    drawing = null;
    drawFrom = null;
    // (New towers and buildings are made of the design last chosen for their kind; walls carried on, of the one before.)
    if (d && d.kind !== 'wall' && lastDesign[d.kind] && designOf(lastDesign[d.kind])) d = fitIn(madeOf(d, designOf(lastDesign[d.kind])!));
    if (d && good(d)) {
      const before = snapshot();
      plan.elements.push(d);
      chosenEl = d.id;
      changed(before);
    } else showPlan();
    return;
  }
  if (!at) return;
  const p = snapIn(at);
  if (phase === 'start') {
    drawFrom = p;
    if (tool === 'wall') {
      // Carried on from a wall's end, if it starts near one (the last one chosen's, if like it).
      const ends = plan.elements.flatMap((e) => (e.kind === 'wall' ? [{ x: e.x0, z: e.z0, w: e }, { x: e.x1, z: e.z1, w: e }] : []));
      const near = ends.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) <= 3).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      if (near) drawFrom = { x: near.x, z: near.z };
      const like = near?.w ?? (plan.elements.find((e) => e.id === chosenEl && e.kind === 'wall') as Extract<PlanElement, { kind: 'wall' }> | undefined);
      drawing = { kind: 'wall', id: newId(), x0: drawFrom.x, z0: drawFrom.z, x1: drawFrom.x, z1: drawFrom.z, thickness: like?.thickness ?? PLAN_LIMITS.wall.thickness[2], height: like?.height ?? PLAN_LIMITS.wall.height[2] };
      const made = like?.design ?? lastDesign.wall;
      if (designOf(made)) drawing = madeOf(drawing, designOf(made)!);
    } else if (tool === 'tower') {
      drawing = fitTower({ kind: 'tower', id: newId(), x: p.x, z: p.z, radius: PLAN_LIMITS.tower.radius[2], height: PLAN_LIMITS.tower.height[2] });
    } else {
      drawing = { kind: 'building', id: newId(), x0: p.x, z0: p.z, x1: p.x, z1: p.z, height: PLAN_LIMITS.building.height[2] };
    }
    showPlan();
    return;
  }
  const from = drawFrom;
  if (!drawing || !from) return;
  if (drawing.kind === 'wall') drawing = { ...drawing, x1: p.x, z1: p.z };
  else if (drawing.kind === 'tower') {
    const r = Math.round(Math.hypot(at.x - from.x, at.z - from.z));
    // (A click, or a little drag: the usual size; further, as far as the drag.)
    if (r >= PLAN_LIMITS.tower.radius[0]) drawing = fitTower({ ...drawing, radius: Math.min(PLAN_LIMITS.tower.radius[1], r) });
  } else drawing = { ...drawing, x0: Math.min(from.x, p.x), z0: Math.min(from.z, p.z), x1: Math.max(from.x, p.x), z1: Math.max(from.z, p.z) };
  showPlan();
}

/** A tower moved (and if need be shrunk) to fit inside the plot. */
function fitTower(t: Extract<PlanElement, { kind: 'tower' }>): Extract<PlanElement, { kind: 'tower' }> {
  const r = opened!;
  const radius = Math.max(PLAN_LIMITS.tower.radius[0], Math.min(t.radius, Math.floor(Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2)));
  return { ...t, radius, x: Math.max(r.x0 + radius, Math.min(r.x1 - radius, t.x)), z: Math.max(r.z0 + radius, Math.min(r.z1 - radius, t.z)) };
}

/** Whether what was drawn is something: a wall with length, a building at least 2 m a side. */
function good(e: PlanElement): boolean {
  if (e.kind === 'wall') return e.x0 !== e.x1 || e.z0 !== e.z1;
  if (e.kind === 'building') return e.x1 - e.x0 >= (e.design ? 1 : 2) && e.z1 - e.z0 >= (e.design ? 1 : 2);
  return true;
}

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
