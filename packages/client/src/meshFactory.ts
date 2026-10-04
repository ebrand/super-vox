import * as THREE from 'three';
import { UNITS_PER_METER } from '@super-vox/shared';
import { BYTES_PER_QUAD, quadIndices, type MeshBuffers } from './mesher.js';

/** One index buffer shared by every mesh; replaced by a larger one when needed. */
let sharedIndex = new THREE.BufferAttribute(quadIndices(16_384), 1);
/** No shade (see MeshBuffers.shade), for every mesh without its own; replaced by a larger one when needed. */
const noDarks = new WeakSet<object>();
let sharedNoDark = new THREE.BufferAttribute(new Uint8Array(16_384 * 8), 2, true);
noDarks.add(sharedNoDark);

/** onUpload callback: frees an attribute's JS array after it reaches the GPU. */
function releaseArray(this: { array: unknown }): void {
  this.array = null;
}

/**
 * Builds a mesh from packed buffers whose positions are in units relative to
 * `origin` (world units). The JS-side vertex arrays are released after upload.
 */
export function createPackedMesh(
  buffers: MeshBuffers,
  origin: { x: number; y: number; z: number },
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  if (sharedIndex.count < buffers.quadCount * 6) {
    // Meshes built earlier keep the old, smaller buffer.
    sharedIndex = new THREE.BufferAttribute(quadIndices(Math.ceil(buffers.quadCount * 1.5)), 1);
  }
  if (!buffers.shade && sharedNoDark.count < buffers.quadCount * 4) {
    sharedNoDark = new THREE.BufferAttribute(new Uint8Array(Math.ceil(buffers.quadCount * 1.5) * 8), 2, true);
    noDarks.add(sharedNoDark);
  }
  const position = new THREE.BufferAttribute(buffers.positions, 3);
  const face = new THREE.BufferAttribute(buffers.faces, 4);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', position);
  geom.setAttribute('face', face);
  // Shade underground and torchlight (see MeshBuffers.shade): meshes without it are lit throughout, by the sky only.
  const shade = buffers.shade && new THREE.BufferAttribute(buffers.shade, 2, true);
  geom.setAttribute('shade', shade ?? sharedNoDark);
  geom.setIndex(sharedIndex);
  geom.setDrawRange(0, buffers.quadCount * 6);
  geom.computeBoundingSphere();
  for (const attr of [position, face, ...(shade ? [shade] : [])]) attr.onUpload(releaseArray);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(origin.x / UNITS_PER_METER, origin.y / UNITS_PER_METER, origin.z / UNITS_PER_METER);
  mesh.scale.setScalar(1 / UNITS_PER_METER);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = name;
  mesh.userData.quads = buffers.quadCount;
  return mesh;
}

/** Packed meshes, or groups of them: quads in all of them. */
export function meshQuads(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => (n += (o.userData.quads as number | undefined) ?? 0));
  return n;
}

export function meshGpuBytes(obj: THREE.Object3D): number {
  return meshQuads(obj) * BYTES_PER_QUAD;
}

/** Frees a packed mesh's (or a group of them's) GPU buffers without freeing the shared index. */
export function disposePackedMesh(obj: THREE.Object3D): void {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.setIndex(null);
    // (Shared buffers stay.)
    if (noDarks.has(o.geometry.getAttribute('shade'))) o.geometry.deleteAttribute('shade');
    o.geometry.dispose();
  });
}
