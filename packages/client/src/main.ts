import * as THREE from 'three';
import { CHUNK_SIZE, UNITS_PER_METER, clockHours, decodeClimate, formatHours, isValidTolerance, normalizeX, unitsToMeters, type DayClock, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { EditTool } from './editTool.js';
import { FlyControls } from './flyControls.js';
import { DETAIL_SPEEDS, SpeedDetail, focusLead, selectLod } from './lod.js';
import { TileManager } from './tileManager.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { createAtmosphere, createSky } from './atmosphere.js';
import { WATER_LAYER, WaterRenderer, createSeaMaterial, createVoxelWaterMaterial } from './water.js';
import { createTint } from './tint.js';
import { applyLighting, loadLighting, saveLighting } from './lighting.js';
import { LightingPanel } from './lightingPanel.js';
import { PLAYER, moveAabb, playerBox } from './physics.js';
import { loadSettings } from './settings.js';
import { MeshWorkerPool } from './workerPool.js';
import { WorldMapOverlay } from './worldMap.js';
import { InventoryUi } from './inventory.js';
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
/** ?workers=N: mesh workers (1..16) instead of the default (up to 4, leaving a core free). */
const workers = params.has('workers') ? Math.round(numberParam('workers', 4, 1, 16)) : undefined;
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
/** Hotbar and inventory screen (E); the server keeps what's in them (see InventoryUi). */
const inventoryUi = new InventoryUi(
  document.body,
  (hotbar) => connection?.send({ type: 'setHotbar', hotbar }),
  (recipe) => connection?.send({ type: 'craft', recipe }),
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
let worldMap: WorldMapOverlay | null = null;
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
  // chunks (more 1 m tiles) the faster we go.
  chunkRadius = speedDetail.update(Math.hypot(velocity.x, velocity.z) / UNITS_PER_METER, performance.now());
  const lead = focusLead(velocity.x, velocity.z, chunkRadius);
  const fx = camera.position.x * UNITS_PER_METER + lead.dx;
  const fz = camera.position.z * UNITS_PER_METER + lead.dz;
  const column = `${Math.floor(fx / CHUNK_SIZE)},${Math.floor(fz / CHUNK_SIZE)},${chunkRadius}`;
  if (!force && column === lodColumn) return;
  lodColumn = column;
  const sel = selectLod(world, fx, fz, detail, view * UNITS_PER_METER, chunkRadius);
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
          // Start above and behind the spawn point, looking at it.
          const spawn = new THREE.Vector3(unitsToMeters(msg.spawn.x), unitsToMeters(msg.spawn.y), unitsToMeters(msg.spawn.z));
          camera.position.set(spawn.x, spawn.y + 12, spawn.z + 24);
          controls.lookAt(spawn);
          controls.minY = unitsToMeters(w.minYUnits) + 1;
          const send = (m: Parameters<NonNullable<typeof connection>['send']>[0]) => connection?.send(m);
          pool = workers === undefined ? new MeshWorkerPool() : new MeshWorkerPool(workers);
          chunks = new ChunkManager(w, scene, material, voxelWater, send, pool, 64, onProgress);
          const waterAt = waterAtFor(chunks);
          inWaterAt = (x, y, z) => waterAt(x * UNITS_PER_METER, y * UNITS_PER_METER, z * UNITS_PER_METER) ?? y < atmosphere.uniforms.waterLevel.value;
          controls.inWater = (x, y, z) => inWaterAt(x, y, z);
          tiles = new TileManager(scene, material, voxelWater, send, pool, 32, onProgress);
          const solidAt = solidAtFor(chunks);
          const eyeUnits = () => [camera.position.x * UNITS_PER_METER, camera.position.y * UNITS_PER_METER, camera.position.z * UNITS_PER_METER] as const;
          const collide = (d: [number, number, number]) => {
            const r = moveAabb(playerBox(eyeUnits()), [d[0] * UNITS_PER_METER, d[1] * UNITS_PER_METER, d[2] * UNITS_PER_METER], solidAt);
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
            const at = (uy: number) => chunks!.chunkAt({ cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(uy / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) });
            return at(feet) !== undefined && at(feet - CHUNK_SIZE) !== undefined;
          };
          const worldParam = worldName !== undefined ? `&world=${encodeURIComponent(worldName)}` : '';
          worldMap = new WorldMapOverlay(
            { width: w.widthUnits, depth: w.depthUnits, wrapX: w.wrapX },
            // (On a round world, where you are in it: past the seam counts from the other side.)
            () => ({ x: normalizeX(w, camera.position.x * UNITS_PER_METER), z: camera.position.z * UNITS_PER_METER, yaw: controls.yaw }),
            { x: msg.spawn.x, z: msg.spawn.z },
            (x, z, surfaceY) => {
              // Land on the ground there (a little above it; walking settles onto it).
              const ground = Math.max(surfaceY, msg.seaLevel ?? surfaceY);
              // On a round world, go to the copy of that spot nearest where we are.
              const here = camera.position.x * UNITS_PER_METER;
              const vx = w.wrapX ? x + Math.round((here - x) / w.widthUnits) * w.widthUnits : x;
              camera.position.set(vx / UNITS_PER_METER, ground / UNITS_PER_METER + PLAYER.eye / UNITS_PER_METER + 2, z / UNITS_PER_METER);
              updateLod();
            },
            `/api/world/map?width=1024${worldParam}`,
            (a) => `/api/world/map/area?x0=${a.x0}&z0=${a.z0}&step=${a.step}&cols=${a.cols}&rows=${a.rows}${worldParam}`,
          );
          window.addEventListener('keydown', (e) => {
            if (e.repeat || e.metaKey || e.ctrlKey) return;
            if (e.code === 'KeyM' || (e.code === 'Escape' && worldMap?.isOpen)) {
              if (e.code === 'KeyM' && !worldMap!.isOpen && controls.pointerLocked) document.exitPointerLock();
              if (e.code === 'Escape') worldMap!.close();
              else worldMap!.toggle();
              return;
            }
            if (worldMap?.isOpen) return;
            // Inventory: E opens and closes it (freeing the mouse to click), Esc closes it; 1-9 pick a hotbar slot.
            if (e.code === 'KeyE' || (e.code === 'Escape' && inventoryUi.isOpen)) {
              if (e.code === 'KeyE' && !inventoryUi.isOpen && controls.pointerLocked) document.exitPointerLock();
              const closing = inventoryUi.isOpen;
              if (e.code === 'Escape') inventoryUi.close();
              else inventoryUi.toggle();
              // Closed with E (a key press may capture the mouse; Esc may not): straight back to playing.
              if (closing && e.code === 'KeyE' && !inventoryUi.isOpen) controls.requestPointerLock();
              return;
            }
            if (/^Digit[1-9]$/.test(e.code)) {
              inventoryUi.select(Number(e.code.slice(5)) - 1);
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
          const modeTag = document.getElementById('mode')!;
          editTool.onModeChange = (mode) => {
            modeTag.textContent = mode.toUpperCase();
            modeTag.dataset.mode = mode;
            updateHud();
          };
          editTool.onModeChange(editTool.mode);
          controls.onClick = (button, mods) => editTool?.click(button, mods);
          controls.onModifiedWheel = (deltaY) => {
            editTool?.scrollSize(deltaY);
            updateHud();
          };
          controls.onPointerLockChange = (_locked, error) => {
            if (error) editTool?.say(error);
            updateHud();
          };
          (window as unknown as { superVox: unknown }).superVox = { chunks, tiles, pool, camera, controls, renderer, scene, updateLod, editTool, water, compassRose, inventoryUi };
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
      case 'inventory':
        inventoryUi.update(msg);
        updateHud();
        break;
      case 'editResult':
        editTool?.onServerMessage(msg);
        break;
      case 'error':
        if (msg.code === 'craft') {
          inventoryUi.say(msg.message);
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
    ` · F: ${controls.walking ? 'fly' : 'walk'} · N: no-clip (${controls.collide ? 'off' : 'on'}) · M: map · L: lighting · I: hide info\n` +
    (editTool ? `${editTool.hudLines()}\n` : '') +
    (c && t
      ? (chunkRadius < detail ? `moving fast: ${chunkRadius < 0 ? 'no voxel chunks, 1 m tiles only' : `voxel chunks within ${chunkRadius} of ${detail}`}\n` : '') +
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

// Tell the server where we are (for its dashboard), twice a second when we've moved. A timer, not
// the render loop: frames stop in background tabs.
let lastPose = '';
setInterval(() => {
  if (!world) return;
  const p = camera.position;
  const pose = { type: 'pose' as const, x: Math.round(p.x * UNITS_PER_METER), y: Math.round(p.y * UNITS_PER_METER), z: Math.round(p.z * UNITS_PER_METER), yaw: Math.round(controls.yaw * 1000) / 1000 };
  const key = `${pose.x},${pose.y},${pose.z},${pose.yaw}`;
  if (key === lastPose) return;
  connection?.send(pose);
  lastPose = key;
}, 500);

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
  worldMap?.update();
  if (sea) sea.position.set(camera.position.x, sea.position.y, camera.position.z);
  applyLighting(lighting, worldHours(), atmosphere, lightingUniforms, view);
  lightingPanel.updateTime();
  atmosphere.uniforms.underwater.value = inWaterAt(camera.position.x, camera.position.y, camera.position.z) ? 1 : 0;
  water.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    fps = (frames * 1000) / (now - lastFpsTime);
    frames = 0;
    lastFpsTime = now;
    updateHud();
  }
});
