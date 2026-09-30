import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CHUNK_SIZE, UNITS_PER_METER, isValidTolerance, unitsToMeters, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { selectLod } from './lod.js';
import { TileManager } from './tileManager.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { MeshWorkerPool } from './workerPool.js';

const statusEl = document.getElementById('status')!;
const params = new URLSearchParams(location.search);
/** Numeric URL parameter clamped to [min, max]; missing or non-numeric values use the default. */
function numberParam(name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
/** ?detail=N: radius, in chunks, of full-detail voxel terrain around the focus. */
const detail = Math.round(numberParam('detail', 4, 1, 32));
/** ?view=M: view distance in metres; low-detail tiles cover everything beyond `detail` out to here. */
const view = Math.max(detail * 16 + 16, numberParam('view', 2048, 64, 16_000));
// Development: ?tolerance=N (integer 1/16 m units, 0..16) asks the server for
// terrain voxelized with that tolerance.
const toleranceParam = params.get('tolerance');
const requestedTolerance = toleranceParam === null ? undefined : Number(toleranceParam);
const toleranceWarning =
  requestedTolerance !== undefined && !isValidTolerance(requestedTolerance)
    ? `ignoring ?tolerance=${toleranceParam} (use an integer 0..16)`
    : '';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const sky = new THREE.Color(0x87a9c9);
const scene = new THREE.Scene();
scene.background = sky;
scene.fog = new THREE.Fog(sky, view * 0.4, view);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, view * 1.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI * 0.49;
controls.listenToKeyEvents(window);
controls.keyPanSpeed = 30;

const material = createVoxelMaterial();
let world: WorldConfig | null = null;
let pool: MeshWorkerPool | null = null;
let chunks: ChunkManager | null = null;
let tiles: TileManager | null = null;
let connection: ReturnType<typeof connect> | null = null;
let worldLine = '';

/** Chunk column of the last LOD selection; reselect when the focus leaves it. */
let lodColumn = '';
let lodChangedAt = 0;
let settledMs: number | null = null;

function updateLod(force = false): void {
  if (!world || !chunks || !tiles) return;
  const fx = controls.target.x * UNITS_PER_METER;
  const fz = controls.target.z * UNITS_PER_METER;
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
  ...(requestedTolerance !== undefined && !toleranceWarning ? { hello: { tolerance: requestedTolerance } } : {}),
  onMessage: (msg) => {
    switch (msg.type) {
      case 'welcome': {
        const w = msg.world;
        worldLine =
          `world ${unitsToMeters(w.widthUnits) / 1000} x ${unitsToMeters(w.depthUnits) / 1000} km` +
          (w.wrapX ? ', wraps east-west' : '') +
          (msg.tolerance !== null ? `\ntolerance ${msg.tolerance}/16 m` : '') +
          (requestedTolerance !== undefined && !toleranceWarning && msg.tolerance !== requestedTolerance
            ? ` (server ignored ?tolerance=${requestedTolerance})`
            : '') +
          (toleranceWarning ? `\n${toleranceWarning}` : '') +
          `\ndetail ${detail} chunks, view ${view} m`;
        if (!chunks) {
          world = w;
          // Start at the server's spawn point, looking at the ground.
          const sx = unitsToMeters(msg.spawn.x);
          const sy = unitsToMeters(msg.spawn.y);
          const sz = unitsToMeters(msg.spawn.z);
          controls.target.set(sx, sy, sz);
          camera.position.set(sx + 12, sy + 10, sz + 12);
          controls.update();
          const send = (m: Parameters<NonNullable<typeof connection>['send']>[0]) => connection?.send(m);
          pool = new MeshWorkerPool();
          chunks = new ChunkManager(w, scene, material, send, pool, 64, onProgress);
          tiles = new TileManager(scene, material, send, pool, 32, onProgress);
          (window as unknown as { superVox: unknown }).superVox = { chunks, tiles, pool, camera, controls, renderer, scene, updateLod };
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
      case 'error':
        console.error(`[super-vox] server error ${msg.code}: ${msg.message}`);
        break;
    }
  },
  onChunk: (bytes) => chunks?.onChunkBytes(bytes),
  onTile: (bytes) => tiles?.onTileBytes(bytes),
  onClose: () => {
    worldLine = 'disconnected';
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
  const f = controls.target;
  const mb = (b: number) => (b / 2 ** 20).toFixed(0);
  statusEl.textContent =
    `${worldLine || 'connecting…'}\n` +
    `focus ${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)} m\n` +
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

renderer.setAnimationLoop(() => {
  controls.update();
  updateLod();
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
