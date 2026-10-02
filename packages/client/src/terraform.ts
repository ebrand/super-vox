import { UNITS_PER_METER, WORLD_SHAPES, decodeClimate, isWorldShape, type VoxelizeConfig, type WorldShape } from '@super-vox/shared';
import { Diorama } from './diorama.js';
import { DEFAULT_DIORAMA_LIGHT, parseDioramaLight, type DioramaLight } from './dioramaLight.js';
import type { TerraformRequest, TerraformResponse } from './terraform.worker.js';
import { climateTintColors } from './tintColors.js';
import { decodeWorldMap } from './worldMap.js';
import { WorldRelief } from './worldRelief.js';

/**
 * The Terraformer: a world in 3D (as the in-game 3D map shows it), where a square follows the
 * middle of the view; "Terraform this area" opens that square at full voxel detail as a diorama
 * (made in this browser from the world's settings, see terraform.worker.ts), and "Back to the
 * world" returns. Viewing only for now.
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
const HINT_DIORAMA = 'drag: move · right-drag: turn and tilt · wheel: zoom';

let worlds: WorldInfo[] = [];
let relief: WorldRelief | null = null;
let diorama: Diorama | null = null;
let showing: 'overview' | 'diorama' = 'overview';
/** The world being shown (its name), and whether the worker has built it (with its climate and sea level). */
let current = '';
let ready: { climate: Uint8Array | null; seaLevel: number | null } | null = null;
let areaId = 0;

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
  const shape = shapeOf(info);
  const world = WORLD_SHAPES[shape];
  status(`loading ${name}…`);
  // The worker rebuilds the world meanwhile (a few seconds for a big one).
  send({ type: 'world', key: name, shape, plates: info.spec.plates, voxelize: info.spec.voxelize ?? { minVoxelSize: 1, tolerance: 4 } });
  try {
    const q = `world=${encodeURIComponent(name)}`;
    const [mapRes, climateRes] = await Promise.all([fetch(`/api/world/map?width=1024&${q}`), fetch(`/api/world/climate?${q}`)]);
    if (!mapRes.ok) throw new Error(`the map request failed: ${mapRes.status}`);
    const map = decodeWorldMap(await mapRes.arrayBuffer());
    if (climateRes.status === 200) map.colors = climateTintColors(map, decodeClimate(new Uint8Array(await climateRes.arrayBuffer())));
    if (current !== name) return;
    const middle = { x: world.widthUnits / 2, z: world.depthUnits / 2 };
    relief = new WorldRelief(map, { width: world.widthUnits, depth: world.depthUnits, wrapX: world.wrapX }, () => middle, middle, false);
    showChoice();
    stage.prepend(relief.canvas);
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
  } else if (res.type === 'area') {
    if (res.id !== areaId) return;
    showArea(res);
  } else {
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
  send({ type: 'area', id: ++areaId, x0, z0, size, step, depth: BASE_DEPTH });
}

function showArea(area: Extract<TerraformResponse, { type: 'area' }>): void {
  const info = worlds.find((w) => w.name === current)!;
  if (!diorama) {
    diorama = new Diorama(ready!.climate, WORLD_SHAPES[shapeOf(info)].wrapX, ready!.seaLevel);
    diorama.miniature = miniatureEl.checked;
    diorama.setLight(light);
    stage.prepend(diorama.canvas);
  }
  showing = 'diorama';
  relief!.canvas.hidden = true;
  diorama.canvas.hidden = false;
  overviewControls.hidden = true;
  dioramaControls.hidden = false;
  hintEl.textContent = HINT_DIORAMA;
  const t0 = performance.now();
  diorama.show(area.parts, area);
  status(`made in ${(area.ms / 1000).toFixed(1)} s (${Math.round(area.quads / 1000)}k faces), shown in ${Math.round(performance.now() - t0)} ms`);
  enterEl.disabled = false;
}

function showOverview(): void {
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
    const body = (await res.json()) as { default: string; worlds: WorldInfo[] };
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
void start();
