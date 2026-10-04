/// <reference lib="webworker" />
import { chunkWithoutWater, decodeChunk, decodeTile, isWater } from '@super-vox/shared';
import { mergeFaces, packQuads, visibleFaces, waterQuads, type MeshBuffers } from './mesher.js';
import { skyLight, type LightInput } from './skyLight.js';
import { meshTile } from './tileMesher.js';

export type MeshRequest =
  | {
      kind: 'chunk';
      id: number;
      center: Uint8Array;
      /** Encoded neighbors in DIRS order; null = empty / outside the world / open side. */
      neighbors: (Uint8Array | null)[];
      /** For its sky light (see skyLight); none: all lit. */
      light?: LightInput;
    }
  | { kind: 'tile'; id: number; tile: Uint8Array };

export interface MeshResponse {
  id: number;
  buffers: MeshBuffers | null;
  /** Chunks only: the water surfaces (see waterQuads), or null for none. */
  water?: MeshBuffers | null;
  /** Chunks only: whether any of it is in shade (below full sky light). */
  shaded?: boolean;
  /** Tiles only: world Y (units) of the mesh origin. */
  baseY?: number;
  /** Time spent meshing in the worker. */
  ms: number;
  error?: string;
  /** Set by the pool (not the worker) for a job skipped because it was no longer wanted. */
  skipped?: boolean;
}

self.onmessage = (ev: MessageEvent<MeshRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  const reply = (res: Omit<MeshResponse, 'id' | 'ms'>) => {
    const msg: MeshResponse = { id: req.id, ms: performance.now() - t0, ...res };
    const transfer = [res.buffers, res.water].flatMap((b) => (b ? [b.positions.buffer, b.faces.buffer, ...(b.dark ? [b.dark.buffer] : [])] : []));
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
    const light = req.light ? skyLight(req.light) : null;
    const quads = mergeFaces(visibleFaces(chunkWithoutWater(chunk), neighbors.map((n) => n && chunkWithoutWater(n)), true, light));
    const water = waterQuads(chunk, neighbors);
    const buffers = quads.length ? packQuads(quads) : null;
    reply({ buffers, water: water.length ? packQuads(water) : null, shaded: !!buffers?.dark });
  } catch (err) {
    reply({ buffers: null, error: String(err) });
  }
};
