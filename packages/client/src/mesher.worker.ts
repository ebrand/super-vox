/// <reference lib="webworker" />
import { decodeChunk, decodeTile } from '@super-vox/shared';
import { mergeFaces, packQuads, visibleFaces, type MeshBuffers } from './mesher.js';
import { meshTile } from './tileMesher.js';

export type MeshRequest =
  | {
      kind: 'chunk';
      id: number;
      center: Uint8Array;
      /** Encoded neighbors in DIRS order; null = empty / outside the world / open side. */
      neighbors: (Uint8Array | null)[];
    }
  | { kind: 'tile'; id: number; tile: Uint8Array };

export interface MeshResponse {
  id: number;
  buffers: MeshBuffers | null;
  /** Tiles only: world Y (units) of the mesh origin. */
  baseY?: number;
  /** Time spent meshing in the worker. */
  ms: number;
  error?: string;
}

self.onmessage = (ev: MessageEvent<MeshRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  const reply = (res: Omit<MeshResponse, 'id' | 'ms'>) => {
    const msg: MeshResponse = { id: req.id, ms: performance.now() - t0, ...res };
    self.postMessage(msg, res.buffers ? [res.buffers.positions.buffer, res.buffers.faces.buffer] : []);
  };
  try {
    if (req.kind === 'tile') {
      const m = meshTile(decodeTile(req.tile));
      reply(m && m.quads.length ? { buffers: packQuads(m.quads), baseY: m.baseY } : { buffers: null });
      return;
    }
    const chunk = decodeChunk(req.center);
    const quads = mergeFaces(visibleFaces(chunk, req.neighbors.map((n) => (n ? decodeChunk(n) : null))));
    reply({ buffers: quads.length ? packQuads(quads) : null });
  } catch (err) {
    reply({ buffers: null, error: String(err) });
  }
};
