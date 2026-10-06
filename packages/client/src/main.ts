import './envBadge.js';
import * as THREE from 'three';
import { BLOCK_SIZE, CHUNK_SIZE, MAX_AIR, MAX_FOOD, Material, REGEN_FOOD, TABLE_REACH, UNITS_PER_METER, materialNearIn, clockHours, decodeClimate, weatherTime, lightAt, fallDamage, formatHours, isValidTolerance, normalizeX, unitsToMeters, setDesigns, stationAmong, type DayClock, type PlacedObject, type DeathCause, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { EditTool, sizeLabel } from './editTool.js';
import { FlyControls } from './flyControls.js';
import { ExplosionView } from './explosions.js';
import { BODY_BELOW_EYE, Knockdown, knockdownFor } from './knockdown.js';
import { sampleBlast } from './blastCloud.js';
import type { CloudRequest, CloudResponse } from './blastCloud.worker.js';
import { DETAIL_SPEEDS, SpeedDetail, focusLead, selectLod } from './lod.js';
import { TileManager } from './tileManager.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { createAtmosphere, createSky } from './atmosphere.js';
import { WATER_LAYER, WaterRenderer, createSeaMaterial, createVoxelWaterMaterial } from './water.js';
import { createTint } from './tint.js';
import { applyLighting, loadLighting, saveLighting } from './lighting.js';
import { FORCED_WEATHER, WeatherView, type ForcedWeather } from './weatherView.js';
import { LightingPanel } from './lightingPanel.js';
import { PLAYER, intersectsSolid, liftOut, moveAabb, playerBox, type SolidAt } from './physics.js';
import { farDetailFor, loadSettings, workersFor } from './settings.js';
import { MeshWorkerPool } from './workerPool.js';
import { WorldMapOverlay, decodeWorldMap } from './worldMap.js';
import { rememberReturn, startFromParams, takeReturn } from './startAt.js';
import { InventoryUi } from './inventory.js';
import { EntityView } from './entities.js';
import type { Footprint } from './coverage.js';
import { createCompassRose } from './compassRose.js';
import { coveredAboveFor, materialAtFor, solidAtFor, waterAtFor } from './worldQuery.js';
import { FootstepSound, FootstepWeather, StepCounter, surfaceOf, underSnow, type Surface } from './footsteps.js';

const statusEl = document.getElementById('status')!;

/** I: shows or hides the info panel (remembered in this browser). */
const INFO_KEY = 'super-vox.infoHidden';
function setInfoVisible(visible: boolean): void {
  statusEl.hidden = !visible;
  try {
    localStorage.setItem(INFO_KEY, visible ? '0' : '1');
  } catch {
    // Not remembered (e.g. storage blocked).
  }
}
// Hidden until I shows it (and then as it was last left).
statusEl.hidden = true;
try {
  statusEl.hidden = localStorage.getItem(INFO_KEY) !== '0';
} catch {
  // Not remembered: hidden.
}
const params = new URLSearchParams(location.search);
/** Numeric URL parameter clamped to [min, max]; missing or non-numeric values use the default. */
function numberParam(name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
// Saved settings (see the entry page), each overridable for one visit by a URL parameter.
const settings = loadSettings();
/** ?detail=N: radius, in chunks, of full-detail voxel terrain around the focus. */
const detail = Math.round(numberParam('detail', settings.detail, 1, 32));
/** ?view=M: view distance in metres; low-detail tiles cover everything beyond `detail` out to here. */
const view = Math.max(detail * 16 + 16, numberParam('view', settings.view, 64, 16_000));
/**
 * ?fullDetailBelow=A&noDetailAbove=B (m/s): voxel chunks give way to 1 m tiles while flying fast
 * (see SpeedDetail); noDetailAbove=0 keeps full detail at any speed.
 */
const detailSpeeds = {
  full: numberParam('fullDetailBelow', DETAIL_SPEEDS.full, 0, 10_000),
  none: numberParam('noDetailAbove', DETAIL_SPEEDS.none, 0, 10_000),
};
const speedDetail = new SpeedDetail(detail, detailSpeeds.none > detailSpeeds.full ? detailSpeeds : { full: Infinity, none: Infinity });
/** Voxel-chunk radius in use (below `detail` while moving fast; -1 for none). */
let chunkRadius = detail;
// Development: ?tolerance=N (integer 1/16 m units, 0..16) asks the server for
// terrain voxelized with that tolerance.
const toleranceParam = params.get('tolerance') ?? (settings.tolerance !== null ? String(settings.tolerance) : null);
const requestedTolerance = toleranceParam === null ? undefined : Number(toleranceParam);
const toleranceWarning =
  requestedTolerance !== undefined && !isValidTolerance(requestedTolerance)
    ? `ignoring tolerance ${toleranceParam} (use an integer 0..16)`
    : '';
/** How fine distant terrain is: ?farDetail=N (1..16) for one visit, else the Performance setting's (see selectLod). */
const farDetail = Math.round(numberParam('farDetail', farDetailFor(settings.performance), 1, 16));
/** Mesh workers: ?workers=N (1..64) for one visit, else the Performance setting's. */
const workers = Math.round(numberParam('workers', workersFor(settings.performance, navigator.hardwareConcurrency || 0), 1, 64));
/** ?world=name: which of the server's worlds to join (its default when omitted). */
const worldName = params.get('world') ?? undefined;
let joinError = '';

// A logarithmic depth buffer: with a 5 cm near plane and views of several km, a normal 24-bit
// buffer can only tell surfaces ~0.4 m apart at 600 m, so shallow coasts fought with the sea.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const atmosphere = createAtmosphere(view);
const scene = new THREE.Scene();
scene.background = atmosphere.uniforms.horizonColor.value;
scene.add(createSky(atmosphere));
/** The weather (see weatherView.ts), once the world says what its weather is. */
const weatherView = new WeatherView(atmosphere);
scene.add(weatherView.group);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, view * 1.5);
const controls = new FlyControls(camera, renderer.domElement);
const explosions = new ExplosionView(scene, camera);
/**
 * Knocked down by a blast near enough (see knockdown.ts): only walking (not flying or swimming), and
 * only playing (survival, or the hybrid tool: not while building with dig or place).
 */
const knockdown = new Knockdown();
/** Footsteps (see footsteps.ts): a step each stride walked, of what's underfoot, wet after rain, crunching in snow. */
const footsteps = new FootstepSound();
const stepCounter = new StepCounter();
const footWeather = new FootstepWeather();
const lastFeet = new THREE.Vector3();
document.addEventListener('visibilitychange', () => footsteps.pause(document.hidden));
/** The eye's height above the feet (m). */
const EYE_HEIGHT = 1.62;
/** What's underfoot (see Surface): wading, water; else what the feet stand on (null: nothing known). */
function surfaceUnderfoot(): Surface | null {
  if (!chunks) return null;
  const p = camera.position, feet = p.y - EYE_HEIGHT;
  if (inWaterAt(p.x, feet + 0.15, p.z)) return 'water';
  const at = materialAtFor(chunks);
  // (Just under the feet; or a little lower, standing on something smaller than a block.)
  for (const below of [0.05, 0.3]) {
    const m = at(Math.floor(p.x * UNITS_PER_METER), Math.floor((feet - below) * UNITS_PER_METER), Math.floor(p.z * UNITS_PER_METER));
    if (m) return underSnow(surfaceOf(m), footWeather.snowCover);
  }
  return null;
}
/** Steps walked since the last frame (and the weather on the ground), `dt` s. */
function walkSounds(dt: number): void {
  const w = weatherView.now;
  footWeather.update(w ? w.precipitation * (1 - w.snow) : 0, w ? w.precipitation * w.snow : 0, dt);
  const p = camera.position;
  // (Only walking on the ground, on our own feet: not flying, swimming, thrown, or moved somewhere.)
  const walked = Math.hypot(p.x - lastFeet.x, p.z - lastFeet.z);
  lastFeet.copy(p);
  const onFoot = controls.grounded && !controls.swimming && !knockdown.active && walked < 3;
  if (!stepCounter.update(onFoot ? walked : 0, controls.sprinting)) return;
  const surface = surfaceUnderfoot();
  if (surface) footsteps.step(surface, footWeather.wet, controls.sprinting ? 0.6 : 0.4);
}
explosions.onBlast = (center, radius) => {
  if (!controls.walking || controls.swimming || !(survivalMovement || editTool?.mode === 'hybrid')) return;
  const body = camera.position.clone().setY(camera.position.y - BODY_BELOW_EYE);
  const k = knockdownFor(body.distanceTo(center), radius, { x: center.x - body.x, z: center.z - body.z });
  if (k) knockdown.begin(k);
};
const compassRose = createCompassRose(document.body);

const material = createVoxelMaterial(atmosphere);
/** Draws water over the rest of the scene, shading it from what lies behind. */
const water = new WaterRenderer(renderer, atmosphere);
const voxelWater = createVoxelWaterMaterial(water.uniforms);
/** Whether a point (metres) is in water: from the loaded chunks, else below the sea. */
let inWaterAt: (x: number, y: number, z: number) => boolean = (_x, y) => y < atmosphere.uniforms.waterLevel.value;
const lightingUniforms = { aoStrength: material.uniforms.aoStrength!, exposure: material.uniforms.exposure! };
let lighting = loadLighting();
/** The world's clock (from the server), and the server's clock minus ours (ms). */
let clock: DayClock | null = null;
let serverOffset = 0;
const worldHours = () => (clock ? clockHours(clock, Date.now() + serverOffset) : 10);
applyLighting(lighting, worldHours(), atmosphere, lightingUniforms, view);
/** L: sliders for the lighting (saved in this browser), and the world's time. */
/** Whether a key went to a text field (typing, not playing). */
export function typingIn(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/** Hotbar and inventory screen (E); the server keeps what's in them (see InventoryUi). */
const inventoryUi = new InventoryUi(
  document.body,
  (hotbar) => connection?.send({ type: 'setHotbar', hotbar }),
  (recipe) => connection?.send({ type: 'craft', recipe }),
  (item, amount) => connection?.send({ type: 'discard', item, amount }),
  // (A crafting table placed near: from the chunks here, as the server works it out.)
  () => {
    if (!chunks) return false;
    const p = camera.position;
    const [x, y, z] = [p.x * UNITS_PER_METER, p.y * UNITS_PER_METER, p.z * UNITS_PER_METER];
    // (The design that's the crafting table is of ordinary materials: known from where designs are placed.)
    const wrap = world?.wrapX ? world.widthUnits / BLOCK_SIZE : null;
    return stationAmong(placedObjects, 'crafting-table', x, y, z, TABLE_REACH, wrap) || materialNearIn((cx, cy, cz) => chunks!.chunkAt({ cx, cy, cz }), x, y, z, TABLE_REACH, Material.CraftingTable);
  },
  // The furnace or stove open (see stations.ts).
  (act, at) => {
    if (act === 'close') connection?.send({ type: 'stationClose' });
    else if ('take' in act) connection?.send({ type: 'stationTake', ...at, slot: act.take, ...(act.amount !== undefined ? { amount: act.amount } : {}) });
    else connection?.send({ type: 'stationPut', ...at, slot: act.put, item: act.item, amount: act.amount });
  },
  (item) => connection?.send({ type: 'eat', item }),
);
// The wheel steps through the hotbar (while it's there: players who can build).
controls.onWheel = (deltaY) => {
  if (!inventoryUi.enabled) return false;
  inventoryUi.scroll(deltaY);
  return true;
};
// Clicking back into the world (capturing the mouse) closes it.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) inventoryUi.close();
});

// --- Leaving the world: the connection closed properly, so the server lets go of the player at once
// (and their world can close when it's idle). Esc asks: the browser takes the first Esc for itself
// (it frees the mouse, and the page never hears the key), so the mouse being freed by anything but
// the game (E, M, L, a furnace) or another window taking over asks; with the mouse already free,
// Esc does. Leaving the page any way at all leaves too (closing the tab, going elsewhere, or the
// browser keeping the page to come back to: then it starts afresh).
const leaveDialog = document.getElementById('leave') as HTMLDialogElement;
/** The game itself is freeing the mouse (not the browser's Esc): no asking. */
let freeingMouse = false;
function freeMouse(): void {
  freeingMouse = true;
  document.exitPointerLock();
}
/** When the mouse was last freed: the Esc that freed it isn't a second Esc. */
let freedAt = 0;
function askToLeave(): void {
  if (leaveDialog.open || inventoryUi.isOpen || worldMap?.isOpen) return;
  (document.getElementById('leave-world') as HTMLElement).textContent = worldName ?? 'this world';
  leaveDialog.showModal();
}
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  freedAt = performance.now();
  const ours = freeingMouse;
  freeingMouse = false;
  // (Switching to another window frees it too: then the page has lost the focus by the time this looks.)
  if (!ours) setTimeout(() => document.hasFocus() && document.visibilityState === 'visible' && askToLeave(), 50);
});
function leaveWorld(): void {
  connection?.close();
  weatherView.stop();
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || e.repeat || typingIn(e) || controls.pointerLocked || leaveDialog.open) return;
  if (performance.now() - freedAt < 400) return;
  askToLeave();
});
document.getElementById('leave-go')!.addEventListener('click', () => {
  leaveWorld();
  location.href = '/';
});
document.getElementById('leave-stay')!.addEventListener('click', () => {
  leaveDialog.close();
  // (Straight back in: the click lets the mouse be captured again, and full-screen too.)
  goFullscreen();
  controls.requestPointerLock();
});
/**
 * Full-screen, with the setting on (see Settings.fullscreen): only on a click or key (browsers
 * allow it then), so as the mouse is captured. Esc leaves it (and asks to leave the world).
 */
function goFullscreen(): void {
  if (!settings.fullscreen || document.fullscreenElement || !document.fullscreenEnabled) return;
  void document.documentElement.requestFullscreen().catch(() => {});
}
renderer.domElement.addEventListener('click', goFullscreen);
window.addEventListener('pagehide', leaveWorld);
window.addEventListener('pageshow', (e) => {
  // (Back to a page the browser kept: its connection was closed on the way out, so start again.)
  if (e.persisted) location.reload();
});

const lightingPanel = new LightingPanel(
  lighting,
  (l) => {
    lighting = l;
    saveLighting(l);
  },
  {
    read: () => (clock ? { hours: worldHours(), clock } : null),
    change: async (c) => {
      try {
        const name = worldName ?? ((await (await fetch('/api/worlds')).json()) as { default: string }).default;
        const res = await fetch(`/api/worlds/${encodeURIComponent(name)}/clock`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(c),
        });
        if (!res.ok) return ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `failed (${res.status})`;
        return null;
      } catch (err) {
        return String(err);
      }
    },
  },
);
document.body.append(lightingPanel.root);

/** The world's weather: its seed (from the server) and its climate (none: temperate everywhere). */
async function startWeather(seed: number, seaLevel: number): Promise<void> {
  let climate: ReturnType<typeof decodeClimate> | null = null;
  try {
    const res = await fetch(`/api/world/climate?for=weather${worldName !== undefined ? `&world=${encodeURIComponent(worldName)}` : ''}`);
    if (res.status === 200) climate = decodeClimate(new Uint8Array(await res.arrayBuffer()));
  } catch {
    // (No climate: temperate weather.)
  }
  weatherView.setWorld(seed, climate, seaLevel);
  weatherView.groundAt = (x, z) => {
    const g = tiles?.groundAt(x * UNITS_PER_METER, z * UNITS_PER_METER);
    return g === undefined ? null : g / UNITS_PER_METER;
  };
}
let weatherFrame = performance.now();
/** Whether (x, z) (m) is sea (undefined: not known), once there's a world with a sea. */
let seaAt: ((x: number, z: number) => boolean | undefined) | null = null;
const SHORE_REACH = 300;
let shoreAt = 0;
/**
 * How loud the surf is here (0..1): from how near the nearest place the sea meets land is (within
 * SHORE_REACH m, either side of it), and how low (it fades going up). Worked out every half second.
 */
function surfHere(now: number): number {
  if (now - shoreAt < 500) return weatherView.surf;
  shoreAt = now;
  const p = camera.position;
  if (!sea || !seaAt) return 0;
  const here = seaAt(p.x, p.z) ?? false;
  let nearest = Infinity;
  for (const r of [8, 20, 40, 70, 110, 160, 230, SHORE_REACH]) {
    for (let k = 0; k < 16 && nearest === Infinity; k++) {
      const a = (k / 16) * Math.PI * 2, s = seaAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
      if (s !== undefined && s !== here) nearest = r;
    }
    if (nearest !== Infinity) break;
  }
  shoreNear = nearest === Infinity ? null : { distance: nearest, onSea: here };
  if (nearest === Infinity) return 0;
  const above = Math.max(0, p.y - atmosphere.uniforms.seaLevelM.value);
  return (1 - nearest / (SHORE_REACH * 1.15)) ** 2 * Math.exp(-above / 150);
}
/** Where the shore was found last (see surfHere), for the info panel: how far, and whether we're over the sea. */
let shoreNear: { distance: number; onSea: boolean } | null = null;
/** The surf, for the info panel: ", surf 40% (shore 70 m)". */
function surfLine(): string {
  if (!shoreNear || weatherView.surf < 0.01) return '';
  return `, surf ${Math.round(weatherView.surf * 100)}% (${shoreNear.onSea ? 'land' : 'sea'} ${shoreNear.distance} m)`;
}
/** How far up something keeps the rain off (units): the tallest trees and then some. */
const COVER_REACH = 128 * UNITS_PER_METER;
/** The ground under a point (world units) where chunks are loaded (the tiles leave it to them): the top of the first solid block below, within 64 m. */
function groundUnder(p: THREE.Vector3): number | undefined {
  if (!chunks) return undefined;
  const lw = chunks.lightWorld(), block = BLOCK_SIZE / UNITS_PER_METER;
  const bx = Math.floor(p.x / block), bz = Math.floor(p.z / block), top = Math.floor(p.y / block);
  for (let by = top; by > top - 64 / block; by--) if (lw.opaque(bx, by, bz)) return (by + 1) * BLOCK_SIZE;
  return undefined;
}
/** ?weatherShift=S: the weather S seconds later (or earlier, negative) than now, to see what's coming. */
const weatherShift = numberParam('weatherShift', 0, -1e7, 1e7);
/** ?weather=rain (clear, cloudy, rain, storm, snow, fog): that weather wherever the camera is, for testing (this player only). */
{
  const forced = params.get('weather');
  if (forced && forced in FORCED_WEATHER) weatherView.forced = forced as ForcedWeather;
}
/** The weather, for the info panel: ", overcast 80%, rain 40%, 12°C". */
function weatherLine(): string {
  const w = weatherView.now;
  if (!w) return '';
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const falling = w.precipitation > 0.02 ? `, ${w.snow > 0.5 ? 'snow' : 'rain'} ${pct(w.precipitation)}` : '';
  return `\nweather: cloud ${pct(w.cover)}${falling}${w.storm > 0.02 ? `, storm ${pct(w.storm)}` : ''}${w.fog > 0.05 ? `, fog ${pct(w.fog)}` : ''}, ${Math.round(w.temperature)}°C` + (weatherShift ? ` (${weatherShift} s ahead)` : '') + (weatherView.forced ? ` (forced: ${weatherView.forced})` : '');
}

/** Biome colours blend where the world's climate says so (no data: plain material colours). */
async function loadTint(wrapX: boolean): Promise<void> {
  try {
    const res = await fetch(`/api/world/climate${worldName !== undefined ? `?world=${encodeURIComponent(worldName)}` : ''}`);
    if (res.status !== 200) return;
    const climate = decodeClimate(new Uint8Array(await res.arrayBuffer()));
    material.setTint(createTint(climate, wrapX));
    worldMap?.setClimate(climate);
  } catch (err) {
    console.warn('[super-vox] no biome colour blending:', err);
  }
}
let world: WorldConfig | null = null;
let pool: MeshWorkerPool | null = null;
let chunks: ChunkManager | null = null;
let tiles: TileManager | null = null;
let editTool: EditTool | null = null;
/** Designed objects placed in the world (see the `objects` message), for the edit tool. */
let placedObjects: PlacedObject[] = [];
let worldMap: WorldMapOverlay | null = null;
/**
 * Playing survival (signed in, or anyone where the server has no accounts): no flying, no-clip
 * or travel by map or link; you walk. Visitors who can't build look around as they like.
 */
let survivalMovement = false;
const sessionStore = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

/** Mobs and other players (see EntityView). */
let entities: EntityView | null = null;

/** Blasts' dust, flown in a worker (see blastCloud): when each blast was. */
let cloudWorker: Worker | null = null;
let cloudsAsked = 0;
const cloudStarts = new Map<number, number>();
function newCloudWorker(): Worker {
  const w = new Worker(new URL('./blastCloud.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<CloudResponse>) => {
    const startedAt = cloudStarts.get(ev.data.id);
    cloudStarts.delete(ev.data.id);
    if (startedAt !== undefined) explosions.cloud(ev.data.cloud, startedAt);
  };
  return w;
}

/** Survival: hearts and food above the hotbar (breath too, under water), a red flash when hurt. */
const healthEl = document.createElement('div');
healthEl.id = 'health';
healthEl.hidden = true;
const hurtEl = document.createElement('div');
hurtEl.id = 'hurt';
document.body.append(healthEl, hurtEl);
let health: number | null = null;
/** What to say when we died, by how. */
const RESPAWNED = { here: 'back at your bed', gone: 'your bed is gone, so back at the spawn point', blocked: 'your bed is built over, so back at the spawn point', none: 'back at the spawn point' } as const;
const DEATHS: Record<DeathCause, string> = { fell: 'you fell to your death', drowned: 'you drowned', starved: 'you starved', mob: 'you were killed', blast: 'you were blown up' };
function showHealth(h: number, max: number, food: number, air: number): void {
  if (health !== null && h < health) {
    hurtEl.classList.remove('flash');
    void hurtEl.offsetWidth; // restart the animation
    hurtEl.classList.add('flash');
  }
  health = h;
  healthEl.hidden = false;
  // Two points a symbol: full, half, empty.
  const row = (value: number, of: number, full: string, half: string, empty: string) =>
    Array.from({ length: of / 2 }, (_, i) => (value >= (i + 1) * 2 ? full : value >= i * 2 + 1 ? half : empty)).join('');
  const hearts = document.createElement('span'), meal = document.createElement('span'), breath = document.createElement('span');
  hearts.className = 'hearts';
  hearts.textContent = row(h, max, '♥', '❥', '♡');
  hearts.title = `health ${h} / ${max}`;
  meal.className = 'food';
  meal.textContent = row(food, MAX_FOOD, '●', '◐', '○');
  meal.title = `food ${food} / ${MAX_FOOD}${food === 0 ? ': starving' : food < REGEN_FOOD ? ": hungry (you don't heal)" : ''}`;
  breath.className = 'air';
  breath.textContent = air < MAX_AIR ? '◯'.repeat(air) : '';
  breath.title = `breath ${air} / ${MAX_AIR}`;
  healthEl.replaceChildren(breath, hearts, meal);
}
let connection: ReturnType<typeof connect> | null = null;
/** Reconnection attempts since the last welcome (for backing off). */
let reconnects = 0;
const RELOAD_KEY = 'super-vox.reloadedForUpdate';
let worldLine = '';

/** Translucent sea surface at sea level, kept centred under the camera. */
let sea: THREE.Mesh | null = null;
let seaMaterial: ReturnType<typeof createSeaMaterial> | null = null;
function addSea(seaLevelUnits: number): void {
  atmosphere.uniforms.seaLevelM.value = seaLevelUnits / UNITS_PER_METER;
  atmosphere.uniforms.waterLevel.value = seaLevelUnits / UNITS_PER_METER;
  seaMaterial = createSeaMaterial(water.uniforms);
  sea = new THREE.Mesh(new THREE.PlaneGeometry(view * 2.5, view * 2.5), seaMaterial);
  sea.layers.set(WATER_LAYER);
  sea.rotation.x = -Math.PI / 2;
  // Half a smallest voxel below sea level: ground whose voxel tops sit exactly at sea level would
  // otherwise be coplanar with the water, and no depth buffer can settle a tie.
  sea.position.y = (seaLevelUnits - 0.5) / UNITS_PER_METER;
  sea.renderOrder = 5;
  sea.name = 'sea';
  scene.add(sea);
}

/** Chunk column of the last LOD selection; reselect when the focus leaves it. */
let lodColumn = '';
let lodChangedAt = 0;
let settledMs: number | null = null;

/** Horizontal velocity (units per second), smoothed over a fraction of a second. */
const velocity = { x: 0, z: 0 };
const lastPosition = new THREE.Vector3();
let velocityAt = 0;

function trackVelocity(now: number): void {
  const dt = (now - velocityAt) / 1000;
  velocityAt = now;
  const p = camera.position;
  const dx = (p.x - lastPosition.x) * UNITS_PER_METER, dz = (p.z - lastPosition.z) * UNITS_PER_METER;
  lastPosition.copy(p);
  // A jump (teleport, or the first frame) isn't travel.
  if (!(dt > 0) || dt > 1 || Math.hypot(dx, dz) > 200 * UNITS_PER_METER) {
    velocity.x = velocity.z = 0;
    return;
  }
  const k = 1 - Math.exp(-dt / 0.25);
  velocity.x += (dx / dt - velocity.x) * k;
  velocity.z += (dz / dt - velocity.z) * k;
}

function updateLod(force = false): void {
  if (!world || !chunks || !tiles) return;
  // Stream terrain around the camera, centred a little ahead of it while moving; fewer voxel
  // chunks (more 1 m tiles) the faster we go, and flying, none until we stop (see SpeedDetail).
  chunkRadius = speedDetail.update(Math.hypot(velocity.x, velocity.z) / UNITS_PER_METER, performance.now(), !controls.walking);
  const lead = focusLead(velocity.x, velocity.z, chunkRadius);
  const fx = camera.position.x * UNITS_PER_METER + lead.dx;
  const fz = camera.position.z * UNITS_PER_METER + lead.dz;
  const column = `${Math.floor(fx / CHUNK_SIZE)},${Math.floor(fz / CHUNK_SIZE)},${chunkRadius}`;
  if (!force && column === lodColumn) return;
  lodColumn = column;
  // (Moving fast: no more voxel chunks, but those already drawn stay; see selectLod.)
  const keep = chunkRadius < detail ? (cx: number, cz: number) => chunks!.drawnColumn(cx, cz) : undefined;
  const sel = selectLod(world, fx, fz, detail, view * UNITS_PER_METER, chunkRadius, farDetail, keep);
  // Everything within `chunkRadius` chunks (Chebyshev) of the focus is voxel chunks; one chunk in
  // from that, they were loaded from the last position too.
  seaMaterial?.setNear(fx / UNITS_PER_METER, fz / UNITS_PER_METER, (Math.max(0, chunkRadius - 1) * CHUNK_SIZE) / UNITS_PER_METER);
  lodChangedAt = performance.now();
  settledMs = null;
  chunks.setRegion(sel.columns, fx, fz);
  tiles.setTiles(sel.tiles, fx, fz);
  onProgress();
}

/** Called whenever loading or meshing advances. */
function onProgress(): void {
  if (!chunks || !tiles || !chunks.idle || !tiles.idle) return;
  // Everything selected is in place: drop meshes kept only to avoid holes.
  chunks.retireStale();
  tiles.retireStale();
  if (settledMs === null) {
    settledMs = performance.now() - lodChangedAt;
    updateHud();
  }
}

function openConnection(): void {
connection = connect({
  hello: {
    ...(requestedTolerance !== undefined && !toleranceWarning ? { tolerance: requestedTolerance } : {}),
    ...(worldName !== undefined ? { world: worldName } : {}),
  },
  onMessage: (msg) => {
    switch (msg.type) {
      case 'welcome': {
        const w = msg.world;
        worldLine =
          `world ${worldName ?? '(default)'}, ${unitsToMeters(w.widthUnits) / 1000} x ${unitsToMeters(w.depthUnits) / 1000} km` +
          (w.wrapX ? ', wraps east-west' : '') +
          (msg.tolerance !== null ? `\ntolerance ${msg.tolerance}/16 m` : '') +
          (requestedTolerance !== undefined && !toleranceWarning && msg.tolerance !== requestedTolerance
            ? ` (server ignored the requested tolerance ${requestedTolerance}: development servers only)`
            : '') +
          (toleranceWarning ? `\n${toleranceWarning}` : '') +
          `\ndetail ${detail} chunks, view ${view} m` +
          (msg.player ? `\nsigned in as ${msg.player.name}${msg.player.admin ? ' (admin)' : ''}` : '') +
          (msg.canEdit ? '' : '\nnot signed in: look around, or sign in on the menu (/) to build');
        clock = msg.clock;
        serverOffset = msg.serverTime - Date.now();
        inventoryUi.enabled = msg.canEdit;
        if (msg.weather) void startWeather(msg.weather.seed, msg.seaLevel === null ? 0 : msg.seaLevel / UNITS_PER_METER);
        if (!chunks) {
          world = w;
          if (msg.seaLevel !== null) addSea(msg.seaLevel);
          void loadTint(w.wrapX);
          // Start above and behind the spawn point, looking at it; in survival (no flying down: a fall
          // that far would hurt), standing on it, looking ahead.
          const spawn = new THREE.Vector3(unitsToMeters(msg.spawn.x), unitsToMeters(msg.spawn.y), unitsToMeters(msg.spawn.z));
          if (msg.mode === 'survival' && msg.canEdit) {
            camera.position.set(spawn.x, spawn.y + PLAYER.eye / UNITS_PER_METER + 0.5, spawn.z);
            controls.lookAt(new THREE.Vector3(spawn.x, camera.position.y, spawn.z - 10));
          } else {
            camera.position.set(spawn.x, spawn.y + 12, spawn.z + 24);
            controls.lookAt(spawn);
          }
          controls.minY = unitsToMeters(w.minYUnits) + 1;
          const send = (m: Parameters<NonNullable<typeof connection>['send']>[0]) => connection?.send(m);
          pool = new MeshWorkerPool(workers);
          chunks = new ChunkManager(w, scene, material, voxelWater, send, pool, 64, onProgress);
          const waterAt = waterAtFor(chunks);
          // (Sea at (x, z) m: the chunks' water just under sea level, open to the sky (not a flooded
          // cave under the land), else the tiles' ground below sea level.)
          seaAt = (x, z) => {
            const seaM = atmosphere.uniforms.seaLevelM.value;
            const w = waterAt(x * UNITS_PER_METER, (seaM - 0.3) * UNITS_PER_METER, z * UNITS_PER_METER);
            if (w === false) return false;
            if (w === true) {
              const block = BLOCK_SIZE / UNITS_PER_METER;
              return chunks!.lightWorld().skyOpen(Math.floor(x / block), Math.floor((seaM - 0.3) / block), Math.floor(z / block));
            }
            const g = tiles?.groundAt(x * UNITS_PER_METER, z * UNITS_PER_METER);
            return g === undefined ? undefined : g < seaM * UNITS_PER_METER;
          };
          inWaterAt = (x, y, z) => waterAt(x * UNITS_PER_METER, y * UNITS_PER_METER, z * UNITS_PER_METER) ?? y < atmosphere.uniforms.waterLevel.value;
          controls.inWater = (x, y, z) => inWaterAt(x, y, z);
          tiles = new TileManager(scene, material, voxelWater, send, pool, 32, onProgress);
          const solidAt = solidAtFor(chunks);
          // What we bump into: voxels where their chunks are here; elsewhere (flying fast, or ahead of
          // loading) the ground as the tiles have it, so the ground's solid at any speed.
          const solidOrGround: SolidAt = (x, y, z) => {
            const s = solidAt(x, y, z);
            if (s !== undefined) return s;
            const ground = tiles!.groundAt(x, z);
            return ground !== undefined && y < ground;
          };
          const eyeUnits = () => [camera.position.x * UNITS_PER_METER, camera.position.y * UNITS_PER_METER, camera.position.z * UNITS_PER_METER] as const;
          const collide = (d: [number, number, number]) => {
            // Inside something (the voxels came after we'd stopped on the tiles' ground, which can be a
            // little lower; or it was built around us): up out of it, not free to move through it.
            const box = playerBox(eyeUnits());
            if (intersectsSolid(box, solidOrGround)) {
              const up = liftOut(box, solidOrGround);
              if (up !== null) return { delta: [0, up / UNITS_PER_METER, 0] as [number, number, number], blocked: [false, false, false] as [boolean, boolean, boolean] };
            }
            const r = moveAabb(box, [d[0] * UNITS_PER_METER, d[1] * UNITS_PER_METER, d[2] * UNITS_PER_METER], solidOrGround);
            return {
              delta: [r.delta[0] / UNITS_PER_METER, r.delta[1] / UNITS_PER_METER, r.delta[2] / UNITS_PER_METER] as [number, number, number],
              blocked: r.blocked,
            };
          };
          controls.collide = collide;
          controls.walking = true;
          // Gravity waits until the chunks under the player's feet (and the layer below) have loaded.
          controls.groundLoaded = () => {
            const [x, y, z] = eyeUnits();
            const feet = y - PLAYER.eye;
            // (Known: arrived, or empty air above the ground there; so walking off a cliff falls.)
            const known = (uy: number) => chunks!.known({ cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(uy / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) });
            return known(feet) && known(feet - CHUNK_SIZE);
          };
          const worldParam = worldName !== undefined ? `&world=${encodeURIComponent(worldName)}` : '';
          /** Goes to (x, z) (units), landing a little above `surfaceY` (walking settles onto it). */
          const landAt = (x: number, z: number, surfaceY: number) => {
            const ground = Math.max(surfaceY, msg.seaLevel ?? surfaceY);
            // On a round world, go to the copy of that spot nearest where we are.
            const here = camera.position.x * UNITS_PER_METER;
            const vx = w.wrapX ? x + Math.round((here - x) / w.widthUnits) * w.widthUnits : x;
            camera.position.set(vx / UNITS_PER_METER, ground / UNITS_PER_METER + PLAYER.eye / UNITS_PER_METER + 2, z / UNITS_PER_METER);
            updateLod();
          };
          worldMap = new WorldMapOverlay(
            { width: w.widthUnits, depth: w.depthUnits, wrapX: w.wrapX },
            // (On a round world, where you are in it: past the seam counts from the other side.)
            () => ({ x: normalizeX(w, camera.position.x * UNITS_PER_METER), z: camera.position.z * UNITS_PER_METER, yaw: controls.yaw }),
            { x: msg.spawn.x, z: msg.spawn.z },
            landAt,
            `/api/world/map?width=1024${worldParam}`,
            (a) => `/api/world/map/area?x0=${a.x0}&z0=${a.z0}&step=${a.step}&cols=${a.cols}&rows=${a.rows}${worldParam}`,
          );
          // Survival: you walk (see survivalMovement); the map can't take you anywhere.
          survivalMovement = msg.mode === 'survival' && msg.canEdit;
          worldMap.canTravel = !survivalMovement;
          // Back where we were before a reload the server asked for; else ?x=…&z=… (metres), not in
          // survival: start there instead of at the spawn point, on the surface as the world map
          // shows it (looked up the same way), or at &y= if given.
          const back = takeReturn(sessionStore(), worldName);
          const start = back ? startFromParams(new URLSearchParams({ x: String(back.x), z: String(back.z) }), w) : survivalMovement ? null : startFromParams(params, w);
          if (!back && survivalMovement && params.has('x')) setTimeout(() => editTool?.say(`survival: links can't move you; walk to x ${params.get('x')}, z ${params.get('z')} m`), 2000);
          if (start) {
            if (start.y !== null) landAt(start.x, start.z, start.y);
            else {
              void fetch(`/api/world/map/area?x0=${start.x}&z0=${start.z}&step=16&cols=1&rows=1${worldParam}`)
                .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`map ${r.status}`))))
                .then((buf) => landAt(start.x, start.z, decodeWorldMap(buf).heights[0]!))
                .catch((err: unknown) => editTool?.say(`couldn't go to x ${start.x / UNITS_PER_METER}, z ${start.z / UNITS_PER_METER}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          window.addEventListener('keydown', (e) => {
            if (e.repeat || e.metaKey || e.ctrlKey) return;
            // Typing (the inventory's search box): only Esc, to close it.
            if (typingIn(e) && e.code !== 'Escape') return;
            if (e.code === 'KeyM' || (e.code === 'Escape' && worldMap?.isOpen)) {
              if (e.code === 'KeyM' && !worldMap!.isOpen && controls.pointerLocked) freeMouse();
              if (e.code === 'Escape') worldMap!.close();
              else worldMap!.toggle();
              return;
            }
            if (worldMap?.isOpen) return;
            // Inventory: E opens and closes it (freeing the mouse to click), Esc closes it; 1-9 and 0 pick a hotbar slot.
            if (e.code === 'KeyE' || (e.code === 'Escape' && inventoryUi.isOpen)) {
              if (e.code === 'KeyE' && !inventoryUi.isOpen && controls.pointerLocked) freeMouse();
              const closing = inventoryUi.isOpen;
              if (e.code === 'Escape') inventoryUi.close();
              else inventoryUi.toggle();
              // Closed with E (a key press may capture the mouse; Esc may not): straight back to playing.
              if (closing && e.code === 'KeyE' && !inventoryUi.isOpen) {
                goFullscreen();
                controls.requestPointerLock();
              }
              return;
            }
            if (/^Digit[0-9]$/.test(e.code)) {
              inventoryUi.select((Number(e.code.slice(5)) + 9) % 10); // (1 is the first slot, 0 the tenth)
              return;
            }
            if (e.code === 'KeyI') {
              setInfoVisible(statusEl.hidden === true);
              return;
            }
            if (e.code === 'KeyL') {
              if (!lightingPanel.isOpen && controls.pointerLocked) freeMouse();
              lightingPanel.toggle();
              return;
            }
            if ((e.code === 'KeyN' || e.code === 'KeyF') && survivalMovement) {
              editTool?.say("survival: you can't fly or pass through the ground");
              return;
            }
            if (e.code === 'KeyN') {
              // No-clip: fly through terrain (walking needs collision, so it flies).
              controls.collide = controls.collide ? null : collide;
              if (!controls.collide) controls.walking = false;
            } else if (e.code === 'KeyF') {
              controls.walking = !controls.walking;
              if (controls.walking) controls.collide = collide;
            } else return;
            updateHud();
          });
          editTool = new EditTool(scene, camera, chunks, send, () => inventoryUi.material, () => (controls.collide ? playerBox(eyeUnits()) : null));
          // Right-clicking a furnace or stove opens it (the server answers with what's in it).
          editTool.onStation = (o) => send({ type: 'stationOpen', x: o.x, y: o.y, z: o.z });
          // Survival: removing is mining, held for as long as the material takes (a ring shows how far along).
          editTool.survival = survivalMovement;
          // Creative: dig and fill boxes up to 16 m (dig and place modes).
          editTool.bigBoxes = msg.mode === 'creative';
          editTool.wrapBlocks = w.wrapX ? w.widthUnits / BLOCK_SIZE : null;
          editTool.setPlacedObjects(placedObjects);
          const miningRing = document.getElementById('mining')!;
          editTool.onMiningProgress = (f) => {
            miningRing.hidden = f === null;
            if (f !== null) miningRing.style.setProperty('--p', String(f));
          };
          entities = new EntityView(
            scene,
            w,
            () => camera.position.x * UNITS_PER_METER,
            (x, y, z) => (chunks ? lightAt(chunks.lightWorld(), Math.floor(x / BLOCK_SIZE), Math.floor(y / BLOCK_SIZE), Math.floor(z / BLOCK_SIZE)) : null),
            // (Stars come out as daylight goes: the night's light is a sliver of the day's.)
            () => 1 - 0.85 * atmosphere.uniforms.stars.value,
          );
          editTool.pickEntity = (origin, dir, maxDist) => entities!.pick(origin, dir, maxDist);
          const modeTag = document.getElementById('mode')!;
          // The mode, and the size chosen (dig, place; hybrid while ⌘ is held: else it matches what's aimed at).
          const showMode = () => {
            const size = editTool!.chosenSize;
            modeTag.textContent = editTool!.mode.toUpperCase() + (size !== null ? ` · ${sizeLabel(size)}` : '');
            modeTag.dataset.mode = editTool!.mode;
          };
          editTool.onModeChange = () => {
            showMode();
            updateHud();
          };
          editTool.onModeChange(editTool.mode);
          // A size chosen: shown big under the crosshair (a square as big as it, near enough), for a moment.
          const sizeBadge = document.getElementById('size-badge')!;
          let sizeBadgeTimer: ReturnType<typeof setTimeout> | undefined;
          editTool.onSizeChange = (size) => {
            showMode();
            updateHud();
            clearTimeout(sizeBadgeTimer);
            if (size === null) {
              sizeBadge.classList.remove('shown');
              return;
            }
            const box = sizeBadge.firstElementChild as HTMLElement, label = sizeBadge.lastElementChild as HTMLElement;
            // 1/16 m: 4 px; 1 m: 24 px; more for big boxes (by halves), at most 44 px.
            const px = Math.min(44, 4 + 5 * Math.log2(size));
            box.style.width = box.style.height = `${px}px`;
            label.textContent = sizeLabel(size);
            sizeBadge.classList.add('shown');
            // (In hybrid it's shown while ⌘ is held: it goes when ⌘ does. Otherwise, for a moment.)
            if (editTool!.mode !== 'hybrid') sizeBadgeTimer = setTimeout(() => sizeBadge.classList.remove('shown'), 1200);
          };
          controls.onClick = (button, mods) => editTool?.click(button, mods);
          controls.onRelease = (button) => editTool?.release(button);
          // Survival: a hard landing hurts (the server works out how much).
          editTool.onTap = () => footsteps.tap();
          controls.onLand = (speed) => {
            if (survivalMovement && fallDamage(speed) > 0) send({ type: 'fell', speed });
            // A landing: a step, harder the faster.
            const surface = speed > 2.5 ? surfaceUnderfoot() : null;
            if (surface) footsteps.step(surface, footWeather.wet, Math.min(1, 0.5 + speed / 15));
          };
          controls.onModifiedWheel = (deltaY) => {
            editTool?.scrollSize(deltaY);
            updateHud();
          };
          controls.onPointerLockChange = (locked, error) => {
            if (!locked) editTool?.release(0); // (the button's let go unseen once the mouse is free)
            if (error) editTool?.say(error);
            updateHud();
          };
          (window as unknown as { superVox: unknown }).superVox = { chunks, tiles, pool, camera, controls, renderer, scene, updateLod, editTool, water, compassRose, inventoryUi, entities, explosions };
          // Start loading now rather than on the first frame (frames pause in hidden tabs).
          updateLod(true);
        } else {
          // Back after a reconnect: ask again for whatever is still missing.
          lodColumn = '';
          updateLod(true);
        }
        reconnects = 0;
        updateHud();
        break;
      }
      case 'column':
        chunks?.onColumn(msg);
        break;
      case 'clock':
        clock = msg.clock;
        serverOffset = msg.serverTime - Date.now();
        break;
      case 'chunkUnavailable':
        chunks?.onChunkUnavailable(msg);
        break;
      case 'tileUnavailable':
        tiles?.onTileUnavailable(msg);
        break;
      case 'entities':
        entities?.update(msg.entities);
        break;
      case 'health':
        showHealth(msg.health, msg.max, msg.food, msg.air);
        break;
      case 'fuse':
        explosions.fuse(msg.x, msg.y, msg.z, msg.size, msg.ms);
        break;
      case 'explosion': {
        // Its dust, from the world as it is now (the crater's chunks come next); on a round world,
        // at the copy of the blast nearest us.
        const here = camera.position.x * UNITS_PER_METER;
        const x = world?.wrapX ? msg.x + Math.round((here - msg.x) / world.widthUnits) * world.widthUnits : msg.x;
        explosions.explode(x, msg.y, msg.z, msg.radius);
        if (chunks) {
          // (Its crater shaped from its seed, as the server's: see craterShape.)
          const sample = sampleBlast((cx, cy, cz) => chunks!.chunkAt({ cx, cy, cz }), x, msg.y, msg.z, msg.radius, msg.seed, undefined, msg.open, msg.seed);
          if (sample.picked.length) {
            // Flown in a worker (the arithmetic of a big blast's would hold up a few frames).
            const id = ++cloudsAsked;
            cloudStarts.set(id, performance.now());
            cloudWorker ??= newCloudWorker();
            cloudWorker.postMessage({ id, sample } satisfies CloudRequest, [sample.picked.buffer, sample.ground.buffer]);
          }
        }
        break;
      }
      case 'debris':
        explosions.debris(msg.pieces);
        break;
      case 'returnTo':
        // Signed in, back in a world: where we were when we left it (as we looked then, level).
        camera.position.set(unitsToMeters(msg.x), unitsToMeters(msg.y), unitsToMeters(msg.z));
        controls.yaw = msg.yaw;
        controls.pitch = 0;
        controls.stopFalling();
        updateLod(true);
        editTool?.say('back where you left off');
        break;
      case 'respawn':
        // Died: back at our bed or the spawn point (standing on it).
        camera.position.set(unitsToMeters(msg.x), unitsToMeters(msg.y) + PLAYER.eye / UNITS_PER_METER + 0.5, unitsToMeters(msg.z));
        controls.stopFalling(); // (no falling on from where we died)
        updateLod(true);
        editTool?.say(`${DEATHS[msg.cause ?? 'mob']}: ${RESPAWNED[msg.bed ?? 'none']}`);
        break;
      case 'inventory':
        inventoryUi.update(msg);
        updateHud();
        break;
      case 'designs':
        // (Their items and recipes become known: see setDesigns.)
        setDesigns(msg.designs);
        inventoryUi.refresh();
        updateHud();
        break;
      case 'objects':
        placedObjects = msg.objects;
        editTool?.setPlacedObjects(placedObjects);
        break;
      case 'editResult':
        editTool?.onServerMessage(msg);
        break;
      case 'station':
        // Opened (the mouse let go of, as for the inventory), or what's in it now.
        if (msg.state && !inventoryUi.isOpen && controls.pointerLocked) freeMouse();
        inventoryUi.showStation(msg);
        break;
      case 'error':
        if (msg.code === 'craft') {
          inventoryUi.say(msg.message);
          break;
        }
        if (msg.code === 'station') {
          if (inventoryUi.isOpen) inventoryUi.say(msg.message);
          else editTool?.say(msg.message);
          break;
        }
        if (msg.code === 'eat') {
          if (inventoryUi.isOpen) inventoryUi.say(msg.message);
          else editTool?.say(msg.message);
          break;
        }
        console.error(`[super-vox] server error ${msg.code}: ${msg.message}`);
        // Refused at hello (e.g. no such world), or the world was replaced or deleted while
        // playing: the server closes the connection, so keep the reason on screen.
        if (msg.code === 'protocol_mismatch') {
          // The server runs a newer version: load it (once a minute at most, in case it's the page that's stale).
          joinError = 'the game was updated: reload the page';
          let last = 0;
          try {
            last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
            if (Date.now() - last > 60_000) {
              sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
              joinError = 'the game was updated: reloading';
              setTimeout(() => location.reload(), 500);
            }
          } catch {
            // Can't remember reloading: leave it to the player.
          }
        } else if (!chunks && (msg.code === 'unknown_world' || msg.code === 'bad_message')) {
          joinError = `${msg.message}${worldName !== undefined ? ' (check ?world=)' : ''}`;
        } else if (msg.code === 'world_changed') {
          joinError = `${msg.message}: reload to play it`;
        } else if (msg.code === 'world_terraformed' || msg.code === 'world_mode_changed') {
          // The land was reshaped (builds kept), or the world's mode changed: load it again, here.
          joinError = `${msg.message}: reloading`;
          rememberReturn(sessionStore(), worldName, camera.position.x, camera.position.z);
          setTimeout(() => location.reload(), 1500);
        } else if (msg.code === 'world_deleted') {
          joinError = `${msg.message}: back to the Menu to pick another`;
        }
        if (joinError) {
          worldLine = joinError;
          updateHud();
        }
        break;
    }
  },
  onChunk: (bytes) => chunks?.onChunkBytes(bytes),
  onTile: (bytes) => tiles?.onTileBytes(bytes),
  onClose: () => {
    chunks?.resetRequests();
    tiles?.resetRequests();
    if (joinError) {
      worldLine = joinError;
    } else {
      // The server went away (e.g. restarting for a new version): try again, backing off.
      const delay = Math.min(10, 2 ** reconnects++);
      worldLine = `disconnected: reconnecting in ${delay} s`;
      setTimeout(openConnection, delay * 1000);
    }
    updateHud();
  },
});
}
openConnection();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let frames = 0;
let fps = 0;
let lastFpsTime = performance.now();

function updateHud(): void {
  const c = chunks?.stats;
  const t = tiles?.stats;
  const f = camera.position;
  const mb = (b: number) => (b / 2 ** 20).toFixed(0);
  statusEl.textContent =
    `${worldLine || 'connecting…'}\n` +
    `camera ${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)} m` + (controls.walking ? '' : `, flying ${controls.speed.toFixed(0)} m/s`) +
    (clock ? `, time ${formatHours(worldHours())}` : '') +
    weatherLine() +
    surfLine() +
    '\n' +
    (controls.pointerLocked ? 'mouse: look · Esc: release mouse' : 'click: capture mouse (or drag to look) · Esc: leave') +
    (controls.walking
      ? controls.swimming ? ' · swimming: WASD move · Space: up · C: down' : ' · walking: WASD move · Space: jump'
      : ' · flying: WASD move · Space: up · Q/C: down') +
    (controls.walking ? ' · Shift: sprint' : ' · Shift: 5x · ⌥+wheel: speed') +
    ' · wheel: hotbar (⌘+wheel: voxel size)' +
    (survivalMovement ? '' : ` · F: ${controls.walking ? 'fly' : 'walk'} · N: no-clip (${controls.collide ? 'off' : 'on'})`) +
    ` · M: map · L: lighting · I: hide info\n` +
    (editTool ? `${editTool.hudLines()}\n` : '') +
    (c && t
      ? (chunkRadius < detail ? `moving: ${chunkRadius < 0 ? 'no voxel chunks, 1 m tiles only' : `voxel chunks within ${chunkRadius} of ${detail}`}\n` : '') +
        `chunks ${c.loaded} loaded (${c.columns} columns), ${c.inFlight} in flight, ${c.queued} queued, ${c.meshing} meshing\n` +
        `tiles ${t.loaded}/${t.tiles}, ${t.inFlight} in flight, ${t.queued} queued, ${t.meshing} meshing\n` +
        (pool ? `meshing on ${pool.size} workers, ${pool.averageMs.toFixed(1)} ms per job\n` : '') +
        `tris ${c.triangles} near + ${t.triangles} far, ~${mb(c.gpuBytes + t.gpuBytes)} MB GPU` +
        (c.errors + t.errors ? `, ${c.errors + t.errors} errors` : '') +
        (settledMs !== null ? `\nsettled in ${(settledMs / 1000).toFixed(2)} s` : '') +
        '\n'
      : '') +
    `${fps.toFixed(0)} fps`;
}

let lastFrame = performance.now();

// Tell the server where we are (mobs chase it, the dashboard shows it), ten times a second when
// we've moved. A timer, not the render loop: frames stop in background tabs.
let lastPose = '';
setInterval(() => {
  if (!world) return;
  const p = camera.position;
  const pose = { type: 'pose' as const, x: Math.round(p.x * UNITS_PER_METER), y: Math.round(p.y * UNITS_PER_METER), z: Math.round(p.z * UNITS_PER_METER), yaw: Math.round(controls.yaw * 1000) / 1000 };
  const key = `${pose.x},${pose.y},${pose.z},${pose.yaw}`;
  if (key === lastPose) return;
  connection?.send(pose);
  lastPose = key;
}, 100);

// While moving, loading never finishes all at once (see onProgress), so a replaced mesh is
// dropped as soon as what replaced it is drawn (chunks and tiles both covering its ground), or
// after STALE_MAX_MS whatever happens (so they can't pile up).
const STALE_MAX_MS = 30_000;
setInterval(() => {
  if (!chunks || !tiles) return;
  const covered = (f: Footprint) => chunks!.covers(f) && tiles!.covers(f);
  chunks.retireCovered(covered, STALE_MAX_MS);
  tiles.retireCovered(covered, STALE_MAX_MS);
}, 500);

renderer.setAnimationLoop(() => {
  const frameStart = performance.now();
  // Movement and editing pause while the map or the inventory is open.
  const paused = worldMap?.isOpen || inventoryUi.isOpen;
  controls.stunned = knockdown.active;
  controls.held = knockdown.thrown;
  if (!paused) controls.update((frameStart - lastFrame) / 1000);
  // Knocked down: thrown, tumbling and bouncing (moved as the player is: walls stop it), and the
  // view down on the ground (drawn so for this frame only, below).
  const wasThrown = knockdown.thrown;
  const downPose = paused ? null : knockdown.update(Math.min(0.05, (frameStart - lastFrame) / 1000), controls.collide);
  if (downPose) camera.position.add(new THREE.Vector3(...downPose.moved));
  if (wasThrown && !knockdown.thrown) controls.stopFalling();
  if (!paused) walkSounds(Math.min(0.1, (frameStart - lastFrame) / 1000));
  lastFrame = frameStart;
  trackVelocity(frameStart);
  chunks?.setViewY(camera.position.y * UNITS_PER_METER);
  updateLod();
  if (!paused) editTool?.update();
  compassRose.update(controls.yaw);
  entities?.frame();
  worldMap?.update();
  if (sea) sea.position.set(camera.position.x, sea.position.y, camera.position.z);
  applyLighting(lighting, worldHours(), atmosphere, lightingUniforms, view);
  {
    const p = camera.position;
    const ground = tiles?.groundAt(p.x * UNITS_PER_METER, p.z * UNITS_PER_METER) ?? groundUnder(p);
    // (Open to the sky: nothing above the camera (leaves too), and not underwater.)
    const covered = () => !!chunks && (!chunks.lightWorld().skyOpen(Math.floor((p.x * UNITS_PER_METER) / BLOCK_SIZE), Math.floor((p.y * UNITS_PER_METER) / BLOCK_SIZE), Math.floor((p.z * UNITS_PER_METER) / BLOCK_SIZE)) || coveredAboveFor(chunks)(p.x * UNITS_PER_METER, p.y * UNITS_PER_METER, p.z * UNITS_PER_METER, COVER_REACH));
    const open = inWaterAt(p.x, p.y, p.z) || covered() ? 0 : 1;
    const pixelScale = renderer.domElement.height / Math.tan((camera.fov * Math.PI) / 360);
    weatherView.surf = surfHere(frameStart);
    weatherView.update(weatherTime(Date.now() + serverOffset) + weatherShift, worldHours(), p, ground === undefined ? null : ground / UNITS_PER_METER, view, (frameStart - weatherFrame) / 1000, open, pixelScale);
    weatherFrame = frameStart;
    weatherView.applyTo(atmosphere);
  }
  lightingPanel.updateTime();
  atmosphere.uniforms.underwater.value = inWaterAt(camera.position.x, camera.position.y, camera.position.z) ? 1 : 0;
  explosions.frame();
  // (Not behind the 3D map, which draws itself: the last frame stays on screen.) A blast nearby
  // shakes the view, for this frame only.
  const shake = explosions.shake();
  const pose = camera.quaternion.clone();
  camera.position.add(shake);
  if (downPose) {
    camera.position.y -= downPose.drop;
    // (Tumbling: turned over about the level axis across the way you're thrown; then rolled and tipped as you lie.)
    camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(downPose.axis.x, 0, downPose.axis.z), downPose.tumble));
    camera.rotateZ(downPose.roll);
    camera.rotateX(downPose.pitch);
  }
  if (!worldMap?.showing3d) water.render(scene, camera);
  camera.position.sub(shake);
  if (downPose) camera.position.y += downPose.drop;
  camera.quaternion.copy(pose);

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    fps = (frames * 1000) / (now - lastFpsTime);
    frames = 0;
    lastFpsTime = now;
    updateHud();
  }
});
