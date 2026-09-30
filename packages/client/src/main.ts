import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { unitsToMeters } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import { connect } from './connection.js';
import { createVoxelMaterial } from './voxelMaterial.js';

const statusEl = document.getElementById('status')!;
const params = new URLSearchParams(location.search);
const radius = Math.max(1, Math.min(32, Number(params.get('radius') ?? 8)));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const sky = new THREE.Color(0x87a9c9);
const scene = new THREE.Scene();
scene.background = sky;
const viewDistance = radius * 16;
scene.fog = new THREE.Fog(sky, viewDistance * 0.5, viewDistance);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, viewDistance * 2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI * 0.49;
controls.listenToKeyEvents(window);
controls.keyPanSpeed = 30;

const material = createVoxelMaterial();
let chunks: ChunkManager | null = null;
let connection: ReturnType<typeof connect> | null = null;
let worldLine = '';

connection = connect({
  onMessage: (msg) => {
    if (msg.type === 'welcome') {
      const w = msg.world;
      worldLine =
        `world ${unitsToMeters(w.widthUnits) / 1000} x ${unitsToMeters(w.depthUnits) / 1000} km` +
        (w.wrapX ? ', wraps east-west' : '');
      if (!chunks) {
        // Start at the middle of the world, just above the ground.
        const cx = unitsToMeters(w.widthUnits) / 2;
        const cz = unitsToMeters(w.depthUnits) / 2;
        controls.target.set(cx, 0, cz);
        camera.position.set(cx + 12, 10, cz + 12);
        controls.update();
        chunks = new ChunkManager(w, scene, material, (m) => connection?.send(m), {
          radius,
          verticalRadius: 2,
          maxInFlight: 64,
        });
        (window as unknown as { superVox: unknown }).superVox = { chunks, camera, controls };
      }
    } else if (msg.type === 'chunkUnavailable') {
      chunks?.onChunkUnavailable(msg);
    } else if (msg.type === 'error') {
      console.error(`[super-vox] server error ${msg.code}: ${msg.message}`);
    }
  },
  onChunk: (bytes) => chunks?.onChunkBytes(bytes),
  onClose: () => {
    worldLine = 'disconnected';
    chunks?.resetRequests();
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

renderer.setAnimationLoop(() => {
  controls.update();
  chunks?.update(controls.target);
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    fps = (frames * 1000) / (now - lastFpsTime);
    frames = 0;
    lastFpsTime = now;
    const s = chunks?.stats;
    const t = controls.target;
    statusEl.textContent =
      `${worldLine || 'connecting…'}\n` +
      `focus ${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)} m\n` +
      (s
        ? `chunks ${s.loaded} loaded, ${s.inFlight} in flight, ${s.queued} queued\n` +
          `meshes ${s.meshed} (${s.meshing} pending), ${s.triangles} tris` +
          (s.errors ? `, ${s.errors} errors` : '') +
          '\n'
        : '') +
      `${fps.toFixed(0)} fps`;
  }
});
