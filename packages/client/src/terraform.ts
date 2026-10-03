import { STROKE_KINDS, UNITS_PER_METER, WORLD_SHAPES, decodeClimate, isWorldShape, strokesOverColumns, type ProtectedColumn, type StrokeKind, type TerrainStroke, type VoxelizeConfig, type WorldShape } from '@super-vox/shared';
import { Diorama } from './diorama.js';
import { DEFAULT_DIORAMA_LIGHT, parseDioramaLight, type DioramaLight } from './dioramaLight.js';
import type { TerraformRequest, TerraformResponse } from './terraform.worker.js';
import { TerraformDraft, changedBox, dabsAlong, unionBox, type Box } from './terraformDraft.js';
import { climateTintColors } from './tintColors.js';
import { decodeWorldMap } from './worldMap.js';
import { WorldRelief } from './worldRelief.js';

/**
 * The Terraformer: a world in 3D (as the in-game 3D map shows it), where a square follows the
 * middle of the view; "Terraform this area" opens that square at full voxel detail as a diorama
 * (made in this browser from the world's settings, see terraform.worker.ts), and "Back to the
 * world" returns. In the diorama, ⌘-drag (Ctrl-drag) shapes the ground with the chosen brush:
 * the strokes are a draft (kept in this browser, per world, with undo and redo) that the diorama
 * and the overview show, on top of the strokes already applied to the world. Admins apply the
 * draft to the world (the server remakes it; its players reload), keeping clear of where players
 * have built.
 */

interface WorldInfo {
  name: string;
  spec: { generator: string; shape?: string; plates?: unknown; voxelize?: VoxelizeConfig };
}

/** How deep an area's base goes below its lowest ground (units). */
const BASE_DEPTH = 16 * UNITS_PER_METER;

const worldEl = document.getElementById('world') as HTMLSelectElement;
const enterEl = document.getElementById('enter') as HTMLButtonElement;
const leaveEl = document.getElementById('leave') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const stage = document.getElementById('stage')!;
const hintEl = document.getElementById('hint')!;
const overviewControls = document.getElementById('overview-controls')!;
const dioramaControls = document.getElementById('diorama-controls')!;
const areaAbout = document.getElementById('area-about')!;
const sizeEl = document.getElementById('size') as HTMLSelectElement;
const detailEl = document.getElementById('detail') as HTMLSelectElement;
const detailAbout = document.getElementById('detail-about')!;
const miniatureEl = document.getElementById('miniature') as HTMLInputElement;
miniatureEl.addEventListener('change', () => {
  if (diorama) diorama.miniature = miniatureEl.checked;
});
const birdsEl = document.getElementById('birds') as HTMLInputElement;
birdsEl.addEventListener('change', () => {
  if (diorama) diorama.birdsOn = birdsEl.checked;
});

// ---- Measuring up close: the map grid (remembered in this browser) and the measuring line.
const GRID_KEY = 'super-vox-terraform-grid';
const gridEl = document.getElementById('grid') as HTMLInputElement;
const measureEl = document.getElementById('measure') as HTMLButtonElement;
try {
  gridEl.checked = localStorage.getItem(GRID_KEY) === '1';
} catch {
  // Not remembered: off.
}
function setGrid(on: boolean): void {
  gridEl.checked = on;
  if (diorama) diorama.grid = on;
  try {
    localStorage.setItem(GRID_KEY, on ? '1' : '0');
  } catch {
    // (No storage: not remembered.)
  }
}
gridEl.addEventListener('change', () => setGrid(gridEl.checked));
function setMeasuring(on: boolean): void {
  measureEl.setAttribute('aria-pressed', String(on));
  if (!diorama) return;
  diorama.measuring = on;
  diorama.canvas.classList.toggle('measuring', on);
  hintEl.textContent = on ? 'measuring: drag from one point to another · Esc: clear · M: stop measuring · middle-drag: move · right-drag: turn · wheel: zoom' : HINT_DIORAMA;
}
measureEl.addEventListener('click', () => setMeasuring(!diorama?.measuring));
window.addEventListener('keydown', (e) => {
  if (showing !== 'diorama' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'checkbox') return;
  if (e.code === 'KeyG') setGrid(!gridEl.checked);
  else if (e.code === 'KeyM') setMeasuring(!diorama?.measuring);
  else if (e.code === 'Escape') diorama?.clearMeasure();
});

// ---- The diorama's light (remembered in this browser).
const LIGHT_KEY = 'super-vox-terraform-light';
let light: DioramaLight = DEFAULT_DIORAMA_LIGHT;
try {
  light = parseDioramaLight(JSON.parse(localStorage.getItem(LIGHT_KEY) ?? '{}'));
} catch {
  // Not remembered: the default.
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const lightShown: Record<keyof DioramaLight, (v: number) => string> = {
  height: (v) => `${v}°`,
  from: (v) => COMPASS[Math.round(v / 45) % 8]!,
  warmth: (v) => v.toFixed(2),
  shade: (v) => v.toFixed(2),
};
function showLight(): void {
  for (const k of Object.keys(lightShown) as (keyof DioramaLight)[]) {
    (document.getElementById(`l-${k}`) as HTMLInputElement).value = String(light[k]);
    document.getElementById(`l-${k}-v`)!.textContent = lightShown[k](light[k]);
  }
  diorama?.setLight(light);
}
function setLight(next: DioramaLight): void {
  light = next;
  showLight();
  try {
    localStorage.setItem(LIGHT_KEY, JSON.stringify(light));
  } catch {
    // Can't remember it: fine.
  }
}
for (const k of Object.keys(lightShown) as (keyof DioramaLight)[]) {
  document.getElementById(`l-${k}`)!.addEventListener('input', (e) => setLight({ ...light, [k]: Number((e.target as HTMLInputElement).value) }));
}
document.getElementById('l-reset')!.addEventListener('click', () => setLight(DEFAULT_DIORAMA_LIGHT));

/**
 * The area to frame: its size (m), and samples across it (detail): the samples set the cost, so a
 * bigger area is sampled further apart (standard: 512 across, about 1.2 million faces; fine:
 * 1024 across, about 4.5 million).
 */
function areaChoice(): { sizeM: number; stepM: number } {
  const sizeM = Number(sizeEl.value), across = Number(detailEl.value);
  return { sizeM, stepM: sizeM / across };
}

function showChoice(): void {
  const { sizeM, stepM } = areaChoice();
  detailAbout.textContent = `a sample every ${stepM} m`;
  relief?.setFrame(sizeM);
}
sizeEl.addEventListener('change', showChoice);
detailEl.addEventListener('change', showChoice);

const HINT_OVERVIEW = 'drag: move · right-drag: turn and tilt · wheel: zoom';
// As on the 3D map; ⌘-press (Ctrl-press elsewhere) and drag shapes.
const HINT_DIORAMA = 'drag or middle-drag: move · ⌘-drag: shape · right-drag: turn and tilt · wheel: zoom · ⌘Z: undo';

// ---- The brush (remembered in this browser).
interface Brush {
  kind: StrokeKind;
  radius: number;
  /** Strength per kind, 0..1 on the slider: raise and lower, metres per dab (see BRUSH_METRES); smooth, its strength. */
  strength: Record<StrokeKind, number>;
  softness: number;
}
const BRUSH_KEY = 'super-vox-terraform-brush';
const DEFAULT_BRUSH: Brush = { kind: 'raise', radius: 40, strength: { raise: 0.3, lower: 0.3, level: 1, smooth: 0.6, plant: 0.3, clear: 0.6 }, softness: 0.6 };
/** Raise and lower: metres per dab, from the strength slider (0..1), finer at the low end. */
const BRUSH_METRES = (v: number) => Math.round((0.25 + 19.75 * v * v) * 100) / 100;
const BRUSH_COLORS: Record<StrokeKind, number> = { raise: 0x7ee787, lower: 0xff7b72, level: 0xffd34d, smooth: 0x6cb6ff, plant: 0x3fb950, clear: 0xd2a8ff };
const TOOL_ABOUT: Record<StrokeKind, string> = {
  raise: 'Raises the ground under the brush.',
  lower: 'Lowers the ground under the brush (a closed hollow becomes a lake).',
  level: 'Levels the ground to the height where the stroke starts.',
  smooth: 'Smooths out bumps and crags, keeping the land\'s broad shape.',
  plant: '⌘-drag plants trees of the kinds the land\'s climate grows (not on sand, rock or snow); ⌘-right-drag uproots them. Strength: how much each dab changes the forest.',
  clear: 'Uproots trees.',
};
let brush: Brush = DEFAULT_BRUSH;
try {
  const b = JSON.parse(localStorage.getItem(BRUSH_KEY) ?? 'null') as Partial<Brush> | null;
  // (Uproot is now planting's right button.)
  if (b && STROKE_KINDS.includes(b.kind as StrokeKind)) brush = { ...DEFAULT_BRUSH, ...b, kind: b.kind === 'clear' ? 'plant' : b.kind!, strength: { ...DEFAULT_BRUSH.strength, ...b.strength } };
} catch {
  // Not remembered: the default.
}
const radiusEl = document.getElementById('b-radius') as HTMLInputElement;
const amountEl = document.getElementById('b-amount') as HTMLInputElement;
const softnessEl = document.getElementById('b-softness') as HTMLInputElement;
function showBrush(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.setAttribute('aria-pressed', String(b.dataset.kind === brush.kind));
  radiusEl.value = String(brush.radius);
  document.getElementById('b-radius-v')!.textContent = `${brush.radius} m`;
  const v = brush.strength[brush.kind];
  amountEl.value = String(v);
  amountEl.disabled = brush.kind === 'level';
  document.getElementById('b-amount-v')!.textContent = brush.kind === 'level' ? '—' : brush.kind === 'raise' || brush.kind === 'lower' ? `${BRUSH_METRES(v)} m` : v.toFixed(2);
  softnessEl.value = String(brush.softness);
  document.getElementById('b-softness-v')!.textContent = brush.softness.toFixed(2);
  document.getElementById('tool-about')!.textContent = TOOL_ABOUT[brush.kind];
  diorama?.setBrush(brush.radius, BRUSH_COLORS[brush.kind]);
  if (diorama) diorama.paintsAlt = brush.kind === 'plant';
  try {
    localStorage.setItem(BRUSH_KEY, JSON.stringify(brush));
  } catch {
    // Can't remember it: fine.
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.addEventListener('click', () => ((brush = { ...brush, kind: b.dataset.kind as StrokeKind }), showBrush()));
radiusEl.addEventListener('input', () => ((brush = { ...brush, radius: Number(radiusEl.value) }), showBrush()));
amountEl.addEventListener('input', () => ((brush = { ...brush, strength: { ...brush.strength, [brush.kind]: Number(amountEl.value) } }), showBrush()));
softnessEl.addEventListener('input', () => ((brush = { ...brush, softness: Number(softnessEl.value) }), showBrush()));

// ---- The world's own terraforming (applied), and where players have built (kept clear of).
let applied: TerrainStroke[] = [];
let protectedCols: ProtectedColumn[] = [];
let chunkMetres = 16;
/** Whether whoever's here may apply drafts (an admin, or anyone on a development server). */
let canTerraform = false;
/** The world's strokes and then the draft's: what the worker shapes the land with. */
const allStrokes = () => [...applied, ...draft.strokes];

// ---- The draft (per world, kept in this browser).
const draftKey = (world: string) => `super-vox-terraform-draft:${world}`;
let draft = new TerraformDraft();
/** Whether the draft changed since the overview was last drawn. */
let overviewStale = false;
function loadDraft(world: string): void {
  try {
    draft = TerraformDraft.parse(JSON.parse(localStorage.getItem(draftKey(world)) ?? '[]'));
  } catch {
    draft = new TerraformDraft();
  }
  overviewStale = draft.count > 0;
  showDraft();
}
function saveDraft(): void {
  try {
    localStorage.setItem(draftKey(current), JSON.stringify(draft));
  } catch {
    status('The draft is too big to keep in this browser: it lasts until you leave the page.', true);
  }
}
function showDraft(): void {
  document.getElementById('draft-count')!.textContent = draft.count === 0 ? 'no strokes' : `${draft.count} stroke${draft.count === 1 ? '' : 's'}`;
  (document.getElementById('undo') as HTMLButtonElement).disabled = !draft.canUndo;
  (document.getElementById('redo') as HTMLButtonElement).disabled = !draft.canRedo;
  (document.getElementById('clear') as HTMLButtonElement).disabled = draft.count === 0;
  showApply();
}

// ---- Applying the draft to the world.
const applyEl = document.getElementById('apply') as HTMLButtonElement;
const applyConfirm = document.getElementById('apply-confirm')!;
/** The draft's strokes that reach where players have built (their places in it). */
function overBuilds(): number[] {
  const info = worlds.find((w) => w.name === current);
  if (!info) return [];
  const world = WORLD_SHAPES[shapeOf(info)];
  return strokesOverColumns(draft.strokes, protectedCols, chunkMetres, world.wrapX ? world.widthUnits / UNITS_PER_METER : null);
}
function showApply(): void {
  const over = overBuilds();
  document.getElementById('builds')!.hidden = over.length === 0;
  document.getElementById('builds-about')!.textContent = `${over.length} stroke${over.length === 1 ? ' reaches' : 's reach'} where players have built`;
  document.getElementById('applied-about')!.textContent = applied.length === 0 ? 'The world has no terraforming yet.' : `The world has ${applied.length} stroke${applied.length === 1 ? '' : 's'} applied (shown under the draft).`;
  applyEl.hidden = !canTerraform;
  applyEl.disabled = draft.count === 0 || over.length > 0 || applyConfirm.hidden === false;
  document.getElementById('apply-note')!.textContent = canTerraform ? '' : 'Only admins can apply a draft to the world.';
  if (draft.count === 0 || over.length > 0) applyConfirm.hidden = true;
}
document.getElementById('drop-builds')!.addEventListener('click', () => {
  draft.remove(overBuilds());
  draftChanged();
});
applyEl.addEventListener('click', () => {
  document.getElementById('apply-about')!.textContent = `Apply ${draft.count} stroke${draft.count === 1 ? '' : 's'} to "${current}"? The server remakes the world with them, and everyone in it reloads. They can't be taken back here.`;
  applyConfirm.hidden = false;
  showApply();
});
document.getElementById('apply-no')!.addEventListener('click', () => {
  applyConfirm.hidden = true;
  showApply();
});
document.getElementById('apply-yes')!.addEventListener('click', () => void applyDraft());
async function applyDraft(): Promise<void> {
  const name = current, adding = draft.strokes;
  applyConfirm.hidden = true;
  applyEl.disabled = true;
  status(`applying ${adding.length} strokes to ${name}…`);
  try {
    const res = await fetch(`/api/worlds/${encodeURIComponent(name)}/strokes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: applied.length, strokes: adding }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; strokes?: number | number[]; stale?: boolean };
    if (current !== name) return;
    if (!res.ok) {
      // Built on since we looked: see where now.
      if (Array.isArray(body.strokes)) await loadApplied(name);
      status(`Not applied: ${body.error ?? `the server said ${res.status}`}`, true);
      return;
    }
    // The world has them now: the draft starts again on top (nothing to redraw: the same strokes).
    applied = [...applied, ...adding];
    draft = new TerraformDraft();
    shownStrokes = allStrokes();
    saveDraft();
    showDraft();
    status(`Applied: ${name} now has ${String(body.strokes)} stroke${body.strokes === 1 ? '' : 's'}; players there reload it.`);
  } catch (err) {
    status(`Not applied: ${(err as Error).message}`, true);
  } finally {
    showApply();
  }
}

/** The world's applied strokes and where players have built (none, if the server can't say). */
async function loadApplied(name: string): Promise<void> {
  const res = await fetch(`/api/worlds/${encodeURIComponent(name)}/strokes`);
  if (!res.ok) throw new Error(`the terraforming request failed: ${res.status}`);
  const body = (await res.json()) as { strokes: TerrainStroke[]; protected: ProtectedColumn[]; chunkMetres: number };
  if (current !== name) return;
  applied = body.strokes;
  protectedCols = body.protected;
  chunkMetres = body.chunkMetres;
  showProtected();
  showApply();
}

/** The protected columns in the area showing, outlined in the diorama. */
function showProtected(): void {
  if (!diorama || !area) return;
  const info = worlds.find((w) => w.name === current)!;
  const world = WORLD_SHAPES[shapeOf(info)];
  const m = UNITS_PER_METER, W = world.widthUnits / m;
  const ax0 = area.x0 / m, az0 = area.z0 / m, size = area.size / m;
  const squares: { x0: number; z0: number; size: number }[] = [];
  for (const c of protectedCols) {
    let x = c.cx * chunkMetres;
    const z = c.cz * chunkMetres;
    // (Round worlds: the copy nearest the area.)
    if (world.wrapX) x += Math.round((ax0 + size / 2 - (x + chunkMetres / 2)) / W) * W;
    if (x + chunkMetres > ax0 && x < ax0 + size && z + chunkMetres > az0 && z < az0 + size) squares.push({ x0: x, z0: z, size: chunkMetres });
  }
  diorama.setProtected(squares);
}
/** The draft's strokes as last shown, to work out where each change is. */
let shownStrokes: TerrainStroke[] = [];
/** The draft changed: keep it, show it, reshape the area where it changed (quickly). */
function draftChanged(): void {
  overviewStale = true;
  saveDraft();
  showDraft();
  const now = allStrokes();
  const box = changedBox(shownStrokes, now);
  shownStrokes = now;
  // (Changed from the overview, say by Undo or Remove them: redraw it.)
  if (showing === 'overview') refreshOverview();
  else if (box) patchArea(box);
}
document.getElementById('undo')!.addEventListener('click', () => draft.undo() && draftChanged());
document.getElementById('redo')!.addEventListener('click', () => draft.redo() && draftChanged());
document.getElementById('clear')!.addEventListener('click', () => (draft.clear(), draftChanged()));
window.addEventListener('keydown', (e) => {
  if (showing !== 'diorama' || !(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ') return;
  e.preventDefault();
  if (e.shiftKey ? draft.redo() : draft.undo()) draftChanged();
});

/**
 * A stroke of the brush at (x, z) metres; `levelTo` (metres above the sea) for level. `uproot`:
 * the plant brush's other way (as strong as planting).
 */
function strokeAt(x: number, z: number, levelTo: number, uproot = false): TerrainStroke {
  const info = worlds.find((w) => w.name === current)!;
  const world = WORLD_SHAPES[shapeOf(info)];
  const W = world.widthUnits / UNITS_PER_METER;
  const v = brush.strength[brush.kind], k: StrokeKind = uproot ? 'clear' : brush.kind;
  return {
    kind: k,
    x: world.wrapX ? ((x % W) + W) % W : x,
    z,
    radius: brush.radius,
    amount: k === 'level' ? Math.round(levelTo * 100) / 100 : k === 'raise' || k === 'lower' ? BRUSH_METRES(v) : v,
    softness: brush.softness,
  };
}

let worlds: WorldInfo[] = [];
let relief: WorldRelief | null = null;
let diorama: Diorama | null = null;
let showing: 'overview' | 'diorama' = 'overview';
/** The world being shown (its name), and whether the worker has built it (with its climate and sea level). */
let current = '';
let ready: { climate: Uint8Array | null; seaLevel: number | null } | null = null;
let areaId = 0;
/** The area showing (as last asked of the worker); whether a redraw is on its way, and whether the draft changed since it was asked for. */
let area: Omit<Extract<TerraformRequest, { type: 'area' }>, 'id' | 'strokes' | 'type'> | null = null;
/** The latest whole-area request: older whole-area replies are out of date. */
let lastAreaId = 0;
let mapId = 0;

function status(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.className = bad ? 'bad' : '';
}

const worker = new Worker(new URL('./terraform.worker.ts', import.meta.url), { type: 'module' });
const send = (req: TerraformRequest) => worker.postMessage(req);

const shapeOf = (w: WorldInfo): WorldShape => (w.spec.shape && isWorldShape(w.spec.shape) ? w.spec.shape : 'flat-16x16');

async function openWorld(name: string): Promise<void> {
  const info = worlds.find((w) => w.name === name);
  if (!info) return;
  current = name;
  ready = null;
  enterEl.disabled = true;
  showOverview();
  relief?.canvas.remove();
  relief?.dispose();
  relief = null;
  diorama?.canvas.remove();
  diorama?.dispose();
  diorama = null;
  history.replaceState(null, '', `#world=${encodeURIComponent(name)}`);
  area = null;
  applied = [];
  protectedCols = [];
  loadDraft(name);
  const shape = shapeOf(info);
  const world = WORLD_SHAPES[shape];
  status(`loading ${name}…`);
  // The worker rebuilds the world meanwhile (a few seconds for a big one).
  send({ type: 'world', key: name, shape, plates: info.spec.plates, voxelize: info.spec.voxelize ?? { minVoxelSize: 1, tolerance: 4 } });
  try {
    const q = `world=${encodeURIComponent(name)}`;
    const [mapRes, climateRes] = await Promise.all([fetch(`/api/world/map?width=1024&${q}`), fetch(`/api/world/climate?${q}`), loadApplied(name)]);
    if (!mapRes.ok) throw new Error(`the map request failed: ${mapRes.status}`);
    const map = decodeWorldMap(await mapRes.arrayBuffer());
    if (climateRes.status === 200) map.colors = climateTintColors(map, decodeClimate(new Uint8Array(await climateRes.arrayBuffer())));
    if (current !== name) return;
    const middle = { x: world.widthUnits / 2, z: world.depthUnits / 2 };
    relief = new WorldRelief(map, { width: world.widthUnits, depth: world.depthUnits, wrapX: world.wrapX }, () => middle, middle, false);
    showChoice();
    stage.prepend(relief.canvas);
    // A draft from before: shown once the worker has the world.
    if (overviewStale && ready) refreshOverview();
    status(ready ? '' : `building ${name} for full detail…`);
  } catch (err) {
    status(`Couldn't load ${name}: ${(err as Error).message}`, true);
  }
}

worker.onmessage = (ev: MessageEvent<TerraformResponse>) => {
  const res = ev.data;
  if (res.type === 'ready') {
    if (res.key !== current) return;
    ready = { climate: res.climate, seaLevel: res.seaLevel };
    enterEl.disabled = false;
    if (showing === 'overview') status('');
    if (overviewStale && relief) refreshOverview();
  } else if (res.type === 'area') {
    if (res.id < lastAreaId) return;
    // (A patch can come back as a whole area: it dug below the base.)
    if (res.id !== lastAreaId) patching = false;
    showArea(res);
    if (res.id !== lastAreaId && patchBox) patchArea(patchBox);
  } else if (res.type === 'patch') {
    patching = false;
    if (diorama && area) {
      diorama.update(res.parts);
      diorama.setField(res.heights, Math.round(area.size / area.step), area.step, area.x0, area.z0);
      status(`reshaped in ${Math.round(res.ms)} ms (${res.parts.length} section${res.parts.length === 1 ? '' : 's'})`);
    }
    if (patchBox) patchArea(patchBox);
  } else if (res.type === 'map') {
    if (res.id !== mapId || !relief) return;
    const map = { cols: res.cols, rows: res.rows, step: res.step, seaLevel: res.seaLevel, heights: res.heights, materials: res.materials } as Parameters<WorldRelief['setMap']>[0];
    if (res.climate) map.colors = climateTintColors(map, decodeClimate(res.climate));
    relief.setMap(map);
    if (showing === 'overview') status(`world redrawn with the draft in ${(res.ms / 1000).toFixed(1)} s`);
  } else {
    patching = false;
    status(res.error, true);
    enterEl.disabled = !ready;
  }
};

/** Opens the framed area: the worker makes its chunks, then the diorama shows them. */
function enter(): void {
  if (!relief || !ready) return;
  const info = worlds.find((w) => w.name === current)!;
  const world = WORLD_SHAPES[shapeOf(info)];
  const f = relief.focus();
  const { sizeM, stepM } = areaChoice();
  const size = sizeM * UNITS_PER_METER, step = stepM * UNITS_PER_METER;
  // On a whole number of metres, inside the world (round worlds wrap east-west).
  let x0 = Math.round((f.x - size / 2) / UNITS_PER_METER) * UNITS_PER_METER;
  let z0 = Math.round((f.z - size / 2) / UNITS_PER_METER) * UNITS_PER_METER;
  if (!world.wrapX) x0 = Math.max(0, Math.min(world.widthUnits - size, x0));
  z0 = Math.max(0, Math.min(world.depthUnits - size, z0));
  enterEl.disabled = true;
  status('making the area…');
  areaAbout.textContent = `${sizeM} x ${sizeM} m around x ${Math.round((x0 + size / 2) / UNITS_PER_METER)}, z ${Math.round((z0 + size / 2) / UNITS_PER_METER)} m, a sample every ${stepM} m`;
  area = { x0, z0, size, step, depth: BASE_DEPTH };
  shownStrokes = allStrokes();
  lastAreaId = ++areaId;
  send({ type: 'area', id: lastAreaId, ...area, strokes: shownStrokes });
}

/**
 * Quick reshaping where the draft changed (the worker resamples and re-meshes just there, with
 * the strokes applied to the ground; rivers and lakes wait: see updateRivers). One at a time:
 * changes meanwhile are gathered into the next.
 */
let patching = false;
let patchBox: Box | null = null;
function patchArea(box: Box): void {
  if (!area || showing !== 'diorama') return;
  patchBox = unionBox(patchBox, box);
  if (patching) return;
  patching = true;
  send({ type: 'patch', id: ++areaId, strokes: allStrokes(), box: patchBox! });
  patchBox = null;
}

/**
 * The whole area again, with the world rebuilt with the draft, so rivers, lakes and climate follow
 * it (while shaping, quick patches leave them as they were). Asked for with the button; leaving
 * the diorama does the same for the overview, in the background.
 */
function updateRivers(): void {
  if (!area || showing !== 'diorama') return;
  status('rivers and lakes following the draft…');
  lastAreaId = ++areaId;
  send({ type: 'area', id: lastAreaId, ...area, strokes: allStrokes() });
}
document.getElementById('rivers')!.addEventListener('click', updateRivers);

/** Redraws the overview with the draft. */
function refreshOverview(): void {
  if (!ready) return;
  overviewStale = false;
  status('redrawing the world with the draft…');
  send({ type: 'map', id: ++mapId, width: 1024, strokes: allStrokes() });
}

function showArea(made: Extract<TerraformResponse, { type: 'area' }>): void {
  const info = worlds.find((w) => w.name === current)!;
  if (!diorama) {
    diorama = new Diorama(ready!.climate, WORLD_SHAPES[shapeOf(info)].wrapX, ready!.seaLevel);
    diorama.miniature = miniatureEl.checked;
    diorama.setLight(light);
    diorama.onPaint = paint;
    diorama.paintsAlt = brush.kind === 'plant';
    diorama.grid = gridEl.checked;
    diorama.birdsOn = birdsEl.checked;
    stage.prepend(diorama.canvas);
  }
  showing = 'diorama';
  relief!.canvas.hidden = true;
  diorama.canvas.hidden = false;
  overviewControls.hidden = true;
  dioramaControls.hidden = false;
  setMeasuring(diorama.measuring); // (and the hint for it)
  const t0 = performance.now();
  const again = diorama.canvas.dataset.area === `${made.x0},${made.z0},${made.size},${made.step}`;
  diorama.show(made.parts, made, again);
  diorama.canvas.dataset.area = `${made.x0},${made.z0},${made.size},${made.step}`;
  diorama.setField(made.heights, made.n, made.step, made.x0, made.z0);
  showProtected();
  diorama.setBrush(brush.radius, BRUSH_COLORS[brush.kind]);
  status(again ? `rivers and lakes updated in ${(made.ms / 1000).toFixed(1)} s` : `made in ${(made.ms / 1000).toFixed(1)} s (${Math.round(made.quads / 1000)}k faces), shown in ${Math.round(performance.now() - t0)} ms`);
  enterEl.disabled = false;
}

/** ⌘-dragging: a stroke where it starts, then one every third of the brush along the way. */
let painting: { last: { x: number; z: number }; carried: number; levelTo: number; uproot: boolean } | null = null;
function paint(phase: 'start' | 'move' | 'end', at: { x: number; y: number; z: number } | null, alt: boolean): void {
  if (phase === 'end') {
    painting = null;
    diorama?.setBrush(brush.radius, BRUSH_COLORS[brush.kind]);
    return;
  }
  if (!at) return;
  const sea = (ready?.seaLevel ?? 0) / UNITS_PER_METER;
  if (phase === 'start') {
    // (A right-drag with the plant brush uproots, its ring showing so.)
    const uproot = alt && brush.kind === 'plant';
    painting = { last: at, carried: 0, levelTo: at.y - sea, uproot };
    if (uproot) diorama?.setBrush(brush.radius, BRUSH_COLORS.clear);
    draft.begin([strokeAt(at.x, at.z, painting.levelTo, uproot)]);
    draftChanged();
    return;
  }
  if (!painting) return;
  const { points, carried } = dabsAlong(painting.last, at, Math.max(1, brush.radius / 3), painting.carried);
  painting.last = at;
  painting.carried = carried;
  if (points.length === 0) return;
  draft.extend(points.map((p) => strokeAt(p.x, p.z, painting!.levelTo, painting!.uproot)));
  draftChanged();
}

function showOverview(): void {
  if (showing === 'diorama' && overviewStale) refreshOverview();
  showing = 'overview';
  if (relief) relief.canvas.hidden = false;
  if (diorama) diorama.canvas.hidden = true;
  overviewControls.hidden = false;
  dioramaControls.hidden = true;
  hintEl.textContent = HINT_OVERVIEW;
  status('');
}

enterEl.addEventListener('click', enter);
leaveEl.addEventListener('click', showOverview);
worldEl.addEventListener('change', () => void openWorld(worldEl.value));

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
    const body = (await res.json()) as { default: string; canTerraform?: boolean; worlds: WorldInfo[] };
    canTerraform = body.canTerraform === true;
    worlds = body.worlds.filter((w) => w.spec.generator === 'plates');
    if (worlds.length === 0) {
      status('No plate worlds to terraform.', true);
      return;
    }
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
showLight();
showBrush();
void start();
