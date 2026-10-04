import './fullscreen.js';
import './envBadge.js';
import * as THREE from 'three';
import { BLOCK_SIZE, CHUNK_SIZE, MAX_AIR, MAX_FOOD, Material, REGEN_FOOD, TABLE_REACH, UNITS_PER_METER, materialNearIn, clockHours, decodeClimate, lightAt, fallDamage, formatHours, isValidTolerance, normalizeX, unitsToMeters, setDesigns, stationAmong, type DayClock, type PlacedObject, type DeathCause, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { EditTool, sizeLabel } from './editTool.js';
import { FlyControls } from './flyControls.js';
import { ExplosionView } from './explosions.js';
import { sampleBlast } from './blastCloud.js';
import type { CloudRequest, CloudResponse } from './blastCloud.worker.js';
import { DETAIL_SPEEDS, SpeedDetail, focusLead, selectLod } from './lod.js';
import { TileManager } from './tileManager.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { createAtmosphere, createSky } from './atmosphere.js';
import { WATER_LAYER, WaterRenderer, createSeaMaterial, createVoxelWaterMaterial } from './water.js';
import { createTint } from './tint.js';
import { applyLighting, loadLighting, saveLighting } from './lighting.js';
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
import { solidAtFor, waterAtFor } from './worldQuery.js';

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

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, view * 1.5);
const controls = new FlyControls(camera, renderer.domElement);
const explosions = new ExplosionView(scene, camera);
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
              if (e.code === 'KeyM' && !worldMap!.isOpen && controls.pointerLocked) document.exitPointerLock();
              if (e.code === 'Escape') worldMap!.close();
              else worldMap!.toggle();
              return;
            }
            if (worldMap?.isOpen) return;
            // Inventory: E opens and closes it (freeing the mouse to click), Esc closes it; 1-9 and 0 pick a hotbar slot.
            if (e.code === 'KeyE' || (e.code === 'Escape' && inventoryUi.isOpen)) {
              if (e.code === 'KeyE' && !inventoryUi.isOpen && controls.pointerLocked) document.exitPointerLock();
              const closing = inventoryUi.isOpen;
              if (e.code === 'Escape') inventoryUi.close();
              else inventoryUi.toggle();
              // Closed with E (a key press may capture the mouse; Esc may not): straight back to playing.
              if (closing && e.code === 'KeyE' && !inventoryUi.isOpen) controls.requestPointerLock();
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
              if (!lightingPanel.isOpen && controls.pointerLocked) document.exitPointerLock();
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
          controls.onLand = (speed) => {
            if (survivalMovement && fallDamage(speed) > 0) send({ type: 'fell', speed });
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
        if (msg.state && !inventoryUi.isOpen && controls.pointerLocked) document.exitPointerLock();
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
    '\n' +
    (controls.pointerLocked ? 'mouse: look · Esc: release mouse' : 'click: capture mouse (or drag to look)') +
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
  if (!paused) controls.update((frameStart - lastFrame) / 1000);
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
  lightingPanel.updateTime();
  atmosphere.uniforms.underwater.value = inWaterAt(camera.position.x, camera.position.y, camera.position.z) ? 1 : 0;
  explosions.frame();
  // (Not behind the 3D map, which draws itself: the last frame stays on screen.) A blast nearby
  // shakes the view, for this frame only.
  const shake = explosions.shake();
  camera.position.add(shake);
  if (!worldMap?.showing3d) water.render(scene, camera);
  camera.position.sub(shake);

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    fps = (frames * 1000) / (now - lastFpsTime);
    frames = 0;
    lastFpsTime = now;
    updateHud();
  }
});
