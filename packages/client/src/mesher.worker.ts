/// <reference lib="webworker" />
import { chunkWithoutWater, decodeChunk, decodeTile, isWater } from '@super-vox/shared';
import { mergeFaces, packQuads, visibleFaces, waterQuads, type MeshBuffers } from './mesher.js';
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
  /** Chunks only: the water surfaces (see waterQuads), or null for none. */
  water?: MeshBuffers | null;
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
    const transfer = [res.buffers, res.water].flatMap((b) => (b ? [b.positions.buffer, b.faces.buffer] : []));
    self.postMessage(msg, transfer);
  };
  try {
    if (req.kind === 'tile') {
      const m = meshTile(decodeTile(req.tile));
      if (!m || !m.quads.length) {
        reply({ buffers: null });
        return;
      }
      // Rivers and lakes (water-topped samples) are drawn as water, the rest as ground.
      const ground = m.quads.filter((q) => !isWater(q.material));
      const water = m.quads.filter((q) => isWater(q.material));
      reply({ buffers: ground.length ? packQuads(ground) : null, water: water.length ? packQuads(water) : null, baseY: m.baseY });
      return;
    }
    const chunk = decodeChunk(req.center);
    const neighbors = req.neighbors.map((n) => (n ? decodeChunk(n) : null));
    // Terrain without its water (so the bottom shows through), then the water's surfaces.
    const quads = mergeFaces(visibleFaces(chunkWithoutWater(chunk), neighbors.map((n) => n && chunkWithoutWater(n))));
    const water = waterQuads(chunk, neighbors);
    reply({ buffers: quads.length ? packQuads(quads) : null, water: water.length ? packQuads(water) : null });
  } catch (err) {
    reply({ buffers: null, error: String(err) });
  }
};
