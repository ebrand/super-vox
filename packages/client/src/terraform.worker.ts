/// <reference lib="webworker" />
import { WORLD_SHAPES, encodeClimate, migratePlateTerrain, surfaceMap, type TerrainStroke, type VoxelizeConfig, type WorldShape } from '@super-vox/shared';
import { AreaMaker, buffersOf, type AreaRequest, type DetailRequest, type DioramaPart, type MadeArea } from './terraformArea.js';

export type { DioramaPart } from './terraformArea.js';

/**
 * The Terraformer's worker: rebuilds a world from its settings (as the server builds it) and
 * makes dioramas of its areas (see AreaMaker), and the whole world's map, with the draft.
 */
export type TerraformRequest =
  | { type: 'world'; key: string; shape: WorldShape; plates: unknown; voxelize: VoxelizeConfig }
  | ({ type: 'area'; id: number } & AreaRequest)
  | {
      /**
       * Quick: the draft (`strokes`) changed within `box` (metres, x within the world): the area
       * showing is resampled and re-meshed there only (see AreaMaker.patch).
       */
      type: 'patch';
      id: number;
      strokes: TerrainStroke[];
      box: { x0: number; z0: number; x1: number; z1: number };
    }
  /** A finer look at part of the area showing (see AreaMaker.makeDetail). */
  | ({ type: 'detail'; id: number } & DetailRequest)
  | {
      /** The whole world from above, `width` samples across, with the draft (for the 3D overview). */
      type: 'map';
      id: number;
      width: number;
      strokes: TerrainStroke[];
    };

export type TerraformResponse =
  | { type: 'ready'; key: string; climate: Uint8Array | null; seaLevel: number | null; ms: number }
  | ({ type: 'area'; id: number; ms: number } & MadeArea)
  | { type: 'patch'; id: number; parts: DioramaPart[]; heights: Int32Array; samples: number; ms: number }
  | { type: 'detail'; id: number; x0: number; z0: number; size: number; parts: DioramaPart[]; ms: number }
  | {
      type: 'map'; id: number; cols: number; rows: number; step: number; seaLevel: number | null;
      heights: Int16Array; materials: Uint8Array; climate: Uint8Array | null; ms: number;
    }
  | { type: 'error'; id?: number; error: string };

let maker: { key: string; maker: AreaMaker } | null = null;

const post = (res: TerraformResponse, transfer: Transferable[] = []) => self.postMessage(res, transfer);
const postArea = (id: number, a: MadeArea, ms: number) => post({ type: 'area', id, ms, ...a }, [...buffersOf(a.parts), a.heights.buffer]);

self.onmessage = (ev: MessageEvent<TerraformRequest>) => {
  const req = ev.data;
  try {
    const t0 = performance.now();
    if (req.type === 'world') {
      const m = new AreaMaker(WORLD_SHAPES[req.shape], migratePlateTerrain(req.plates), req.voxelize);
      maker = { key: req.key, maker: m };
      const climate = m.heights.climate();
      post({ type: 'ready', key: req.key, climate: climate ? encodeClimate(climate) : null, seaLevel: m.heights.seaLevel, ms: performance.now() - t0 });
      return;
    }
    if (!maker) throw new Error('no world loaded');
    const m = maker.maker;
    if (req.type === 'map') {
      const b = m.withStrokes(req.strokes);
      const step = Math.ceil(b.world.widthUnits / req.width);
      const map = surfaceMap(b.generator, 0, 0, step, Math.ceil(b.world.widthUnits / step), Math.ceil(b.world.depthUnits / step));
      const c = b.heights.climate();
      const climate = c ? encodeClimate(c) : null;
      post({ type: 'map', id: req.id, ...map, climate, ms: performance.now() - t0 }, [map.heights.buffer, map.materials.buffer, ...(climate ? [climate.buffer] : [])]);
      return;
    }
    if (req.type === 'detail') {
      const parts = m.makeDetail(req);
      post({ type: 'detail', id: req.id, x0: req.x0, z0: req.z0, size: req.size, parts, ms: performance.now() - t0 }, buffersOf(parts));
      return;
    }
    if (req.type === 'patch') {
      const r = m.patch(req.strokes, req.box);
      if (!r) return;
      if ('base' in r) return postArea(req.id, r, performance.now() - t0);
      post({ type: 'patch', id: req.id, ...r, ms: performance.now() - t0 }, [...buffersOf(r.parts), r.heights.buffer]);
      return;
    }
    postArea(req.id, m.make(req), performance.now() - t0);
  } catch (err) {
    post({ type: 'error', ...('id' in req ? { id: req.id } : {}), error: err instanceof Error ? err.message : String(err) });
  }
};
