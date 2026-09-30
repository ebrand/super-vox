/// <reference lib="webworker" />
import { decodeChunk } from '@super-vox/shared';
import { materialColor } from './materials.js';
import { buildBuffers, mergeFaces, visibleFaces, type MeshBuffers } from './mesher.js';

export interface MeshRequest {
  id: number;
  center: Uint8Array;
  /** Encoded neighbors in DIRS order; null = empty / outside the world. */
  neighbors: (Uint8Array | null)[];
}

export interface MeshResponse {
  id: number;
  buffers: MeshBuffers | null;
  /** Time spent meshing in the worker. */
  ms: number;
  error?: string;
}

self.onmessage = (ev: MessageEvent<MeshRequest>) => {
  const { id, center, neighbors } = ev.data;
  const t0 = performance.now();
  try {
    const chunk = decodeChunk(center);
    const quads = mergeFaces(visibleFaces(chunk, neighbors.map((n) => (n ? decodeChunk(n) : null))));
    if (quads.length === 0) {
      self.postMessage({ id, buffers: null, ms: performance.now() - t0 } satisfies MeshResponse);
      return;
    }
    const buffers = buildBuffers(quads, materialColor);
    self.postMessage({ id, buffers, ms: performance.now() - t0 } satisfies MeshResponse, [
      buffers.positions.buffer,
      buffers.normals.buffer,
      buffers.colors.buffer,
      buffers.voxelSizes.buffer,
      buffers.indices.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, buffers: null, ms: performance.now() - t0, error: String(err) } satisfies MeshResponse);
  }
};
