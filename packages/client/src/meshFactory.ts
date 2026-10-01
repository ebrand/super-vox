import * as THREE from 'three';
import { UNITS_PER_METER } from '@super-vox/shared';
import { BYTES_PER_QUAD, quadIndices, type MeshBuffers } from './mesher.js';

/** One index buffer shared by every mesh; replaced by a larger one when needed. */
let sharedIndex = new THREE.BufferAttribute(quadIndices(16_384), 1);

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
  const position = new THREE.BufferAttribute(buffers.positions, 3);
  const face = new THREE.BufferAttribute(buffers.faces, 4);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', position);
  geom.setAttribute('face', face);
  geom.setIndex(sharedIndex);
  geom.setDrawRange(0, buffers.quadCount * 6);
  geom.computeBoundingSphere();
  for (const attr of [position, face]) attr.onUpload(releaseArray);
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
    o.geometry.dispose();
  });
}
