import * as THREE from 'three';
import { CHUNK_SIZE, UNITS_PER_METER, isValidTolerance, unitsToMeters, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { EditTool } from './editTool.js';
import { FlyControls } from './flyControls.js';
import { selectLod } from './lod.js';
import { TileManager } from './tileManager.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { PLAYER, moveAabb, playerBox } from './physics.js';
import { loadSettings } from './settings.js';
import { MeshWorkerPool } from './workerPool.js';
import { WorldMapOverlay } from './worldMap.js';
import { solidAtFor } from './worldQuery.js';

const statusEl = document.getElementById('status')!;
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
// Development: ?tolerance=N (integer 1/16 m units, 0..16) asks the server for
// terrain voxelized with that tolerance.
const toleranceParam = params.get('tolerance') ?? (settings.tolerance !== null ? String(settings.tolerance) : null);
const requestedTolerance = toleranceParam === null ? undefined : Number(toleranceParam);
const toleranceWarning =
  requestedTolerance !== undefined && !isValidTolerance(requestedTolerance)
    ? `ignoring tolerance ${toleranceParam} (use an integer 0..16)`
    : '';
/** ?world=name: which of the server's worlds to join (its default when omitted). */
const worldName = params.get('world') ?? undefined;
let joinError = '';

// A logarithmic depth buffer: with a 5 cm near plane and views of several km, a normal 24-bit
// buffer can only tell surfaces ~0.4 m apart at 600 m, so shallow coasts fought with the sea.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const sky = new THREE.Color(0x87a9c9);
const scene = new THREE.Scene();
scene.background = sky;
scene.fog = new THREE.Fog(sky, view * 0.4, view);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, view * 1.5);
const controls = new FlyControls(camera, renderer.domElement);

const material = createVoxelMaterial();
let world: WorldConfig | null = null;
let pool: MeshWorkerPool | null = null;
let chunks: ChunkManager | null = null;
let tiles: TileManager | null = null;
let editTool: EditTool | null = null;
let worldMap: WorldMapOverlay | null = null;
let connection: ReturnType<typeof connect> | null = null;
let worldLine = '';

/** Translucent sea surface at sea level, kept centred under the camera. */
let sea: THREE.Mesh | null = null;
function addSea(seaLevelUnits: number): void {
  sea = new THREE.Mesh(
    new THREE.PlaneGeometry(view * 2.5, view * 2.5),
    new THREE.MeshBasicMaterial({ color: 0x2f6d9c, transparent: true, opacity: 0.6, depthWrite: false, fog: true, side: THREE.DoubleSide }),
  );
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

function updateLod(force = false): void {
  if (!world || !chunks || !tiles) return;
  // Stream terrain around the camera.
  const fx = camera.position.x * UNITS_PER_METER;
  const fz = camera.position.z * UNITS_PER_METER;
  const column = `${Math.floor(fx / CHUNK_SIZE)},${Math.floor(fz / CHUNK_SIZE)}`;
  if (!force && column === lodColumn) return;
  lodColumn = column;
  const sel = selectLod(world, fx, fz, detail, view * UNITS_PER_METER);
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
          `\ndetail ${detail} chunks, view ${view} m`;
        if (!chunks) {
          world = w;
          if (msg.seaLevel !== null) addSea(msg.seaLevel);
          // Start above and behind the spawn point, looking at it.
          const spawn = new THREE.Vector3(unitsToMeters(msg.spawn.x), unitsToMeters(msg.spawn.y), unitsToMeters(msg.spawn.z));
          camera.position.set(spawn.x, spawn.y + 12, spawn.z + 24);
          controls.lookAt(spawn);
          controls.minY = unitsToMeters(w.minYUnits) + 1;
          const send = (m: Parameters<NonNullable<typeof connection>['send']>[0]) => connection?.send(m);
          pool = new MeshWorkerPool();
          chunks = new ChunkManager(w, scene, material, send, pool, 64, onProgress);
          tiles = new TileManager(scene, material, send, pool, 32, onProgress);
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
          worldMap = new WorldMapOverlay(
            { width: w.widthUnits, depth: w.depthUnits },
            () => ({ x: camera.position.x * UNITS_PER_METER, z: camera.position.z * UNITS_PER_METER, yaw: controls.yaw }),
            { x: msg.spawn.x, z: msg.spawn.z },
            (x, z, surfaceY) => {
              // Land on the ground there (a little above it; walking settles onto it).
              const ground = Math.max(surfaceY, msg.seaLevel ?? surfaceY);
              camera.position.set(x / UNITS_PER_METER, ground / UNITS_PER_METER + PLAYER.eye / UNITS_PER_METER + 2, z / UNITS_PER_METER);
              updateLod();
            },
            `/api/world/map?width=1024${worldName !== undefined ? `&world=${encodeURIComponent(worldName)}` : ''}`,
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
          editTool = new EditTool(scene, camera, chunks, send, () => (controls.collide ? playerBox(eyeUnits()) : null));
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
          (window as unknown as { superVox: unknown }).superVox = { chunks, tiles, pool, camera, controls, renderer, scene, updateLod, editTool };
          // Start loading now rather than on the first frame (frames pause in hidden tabs).
          updateLod(true);
        }
        updateHud();
        break;
      }
      case 'column':
        chunks?.onColumn(msg);
        break;
      case 'chunkUnavailable':
        chunks?.onChunkUnavailable(msg);
        break;
      case 'tileUnavailable':
        tiles?.onTileUnavailable(msg);
        break;
      case 'editResult':
        editTool?.onServerMessage(msg);
        break;
      case 'error':
        console.error(`[super-vox] server error ${msg.code}: ${msg.message}`);
        // Refused at hello (e.g. no such world), or the world was replaced or deleted while
        // playing: the server closes the connection, so keep the reason on screen.
        if (!chunks && (msg.code === 'unknown_world' || msg.code === 'bad_message')) {
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
    worldLine = joinError || 'disconnected';
    updateHud();
    chunks?.resetRequests();
    tiles?.resetRequests();
  },
});

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
    `camera ${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)} m, speed ${controls.speed.toFixed(0)} m/s\n` +
    (controls.pointerLocked ? 'mouse: look · Esc: release mouse' : 'click: capture mouse (or drag to look)') +
    (controls.walking
      ? ' · walking: WASD move · Space: jump'
      : ' · flying: WASD move · Space/E: up · Q/C: down') +
    ' · Shift: 5x · wheel: speed (⌘+wheel: voxel size)' +
    ` · F: ${controls.walking ? 'fly' : 'walk'} · N: no-clip (${controls.collide ? 'off' : 'on'}) · M: map\n` +
    (editTool ? `${editTool.hudLines()}\n` : '') +
    (c && t
      ? `chunks ${c.loaded} loaded (${c.columns} columns), ${c.inFlight} in flight, ${c.queued} queued, ${c.meshing} meshing\n` +
        `tiles ${t.loaded}/${t.tiles}, ${t.inFlight} in flight, ${t.queued} queued, ${t.meshing} meshing\n` +
        `tris ${c.triangles} near + ${t.triangles} far, ~${mb(c.gpuBytes + t.gpuBytes)} MB GPU` +
        (c.errors + t.errors ? `, ${c.errors + t.errors} errors` : '') +
        (settledMs !== null ? `\nsettled in ${(settledMs / 1000).toFixed(2)} s` : '') +
        '\n'
      : '') +
    `${fps.toFixed(0)} fps`;
}

let lastFrame = performance.now();

renderer.setAnimationLoop(() => {
  const frameStart = performance.now();
  // Movement and editing pause while the map is open.
  if (!worldMap?.isOpen) controls.update((frameStart - lastFrame) / 1000);
  lastFrame = frameStart;
  updateLod();
  if (!worldMap?.isOpen) editTool?.update();
  worldMap?.update();
  if (sea) sea.position.set(camera.position.x, sea.position.y, camera.position.z);
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    fps = (frames * 1000) / (now - lastFpsTime);
    frames = 0;
    lastFpsTime = now;
    updateHud();
  }
});
