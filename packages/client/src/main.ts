import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { unitsToMeters } from '@super-vox/shared';
import { connect } from './connection.js';

const statusEl = document.getElementById('status')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a9c9);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 5000);
camera.position.set(12, 10, 12);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xdfefff, 0x3a3326, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(30, 50, 20);
scene.add(sun);

// Placeholder ground: a 1 m grid until chunk meshing exists.
scene.add(new THREE.GridHelper(64, 64, 0x2b3a2b, 0x4f6b4f));

// One voxel of each size, 1/16 m to 1 m, to sanity-check scale.
const material = new THREE.MeshStandardMaterial({ color: 0xb08a5a });
let x = -8;
for (let size = 1; size <= 16; size++) {
  const m = unitsToMeters(size);
  const box = new THREE.Mesh(new THREE.BoxGeometry(m, m, m), material);
  box.position.set(x + m / 2, m / 2, 0);
  scene.add(box);
  x += m + 0.25;
}

connect(
  (msg) => {
    if (msg.type === 'welcome') {
      const w = msg.world;
      statusEl.textContent =
        `connected (protocol ${msg.protocolVersion})\n` +
        `world ${unitsToMeters(w.widthUnits) / 1000} x ${unitsToMeters(w.depthUnits) / 1000} km` +
        (w.wrapX ? ', wraps east-west' : '');
    } else if (msg.type === 'error') {
      statusEl.textContent = `server error: ${msg.code}`;
    }
  },
  () => {
    statusEl.textContent = 'disconnected';
  },
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
