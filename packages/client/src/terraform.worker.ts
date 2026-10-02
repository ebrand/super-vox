/// <reference lib="webworker" />
import {
  NO_WATER,
  PlateHeights,
  TerrainGenerator,
  WORLD_SHAPES,
  encodeClimate,
  migratePlateTerrain,
  type VoxelizeConfig,
  type WorldShape,
} from '@super-vox/shared';
import { meshDioramaSection, type DioramaField } from './dioramaMesher.js';
import { packQuads, type MeshBuffers } from './mesher.js';

/**
 * The Terraformer's worker: rebuilds a world from its settings (as the server builds it), and
 * makes a diorama of an area: its surface sampled every `step` (ground, materials, forest canopy,
 * the sea, rivers and lakes, as the game's distant terrain is), meshed in sections as flat-topped
 * columns with cut-off edges (see meshDioramaSection).
 */
export type TerraformRequest =
  | { type: 'world'; key: string; shape: WorldShape; plates: unknown; voxelize: VoxelizeConfig }
  | {
      type: 'area';
      id: number;
      /** The area's north-west corner and size (units; x0 may lie past a round world's seam). */
      x0: number;
      z0: number;
      size: number;
      /** Between samples (units), and how far below the area's lowest ground its base goes. */
      step: number;
      depth: number;
    };

export interface DioramaPart {
  /** Where the part's local origin is (units). */
  x: number;
  y: number;
  z: number;
  ground: MeshBuffers | null;
  water: MeshBuffers | null;
}

export type TerraformResponse =
  | { type: 'ready'; key: string; climate: Uint8Array | null; seaLevel: number | null; ms: number }
  | { type: 'area'; id: number; x0: number; z0: number; size: number; base: number; top: number; parts: DioramaPart[]; quads: number; ms: number }
  | { type: 'error'; id?: number; error: string };

/** Section size (m): the diorama is meshed (and culled) in squares this big. */
const SECTION_M = 64;

let built: { key: string; generator: TerrainGenerator } | null = null;

const post = (res: TerraformResponse, transfer: Transferable[] = []) => self.postMessage(res, transfer);

self.onmessage = (ev: MessageEvent<TerraformRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'world') {
      const t0 = performance.now();
      const world = WORLD_SHAPES[req.shape];
      const heights = new PlateHeights(world, migratePlateTerrain(req.plates));
      built = { key: req.key, generator: new TerrainGenerator(world, req.voxelize, heights) };
      const climate = heights.climate();
      post({ type: 'ready', key: req.key, climate: climate ? encodeClimate(climate) : null, seaLevel: heights.seaLevel, ms: performance.now() - t0 });
      return;
    }
    if (!built) throw new Error('no world loaded');
    const t0 = performance.now();
    const g = built.generator;
    const n = Math.round(req.size / req.step);
    // Each sample at the middle of its cell.
    const s = g.surfaceSamples(req.x0 + Math.floor(req.step / 2), req.z0 + Math.floor(req.step / 2), req.step, n);
    // Water over the ground: rivers and lakes, and the sea.
    const sea = g.seaLevel;
    let water = s.water;
    if (sea !== null) {
      water ??= new Int32Array(n * n).fill(NO_WATER);
      for (let k = 0; k < n * n; k++) if (s.heights[k]! < sea && water[k]! < sea) water[k] = sea;
    }
    let lowest = Infinity, top = -Infinity;
    for (let k = 0; k < n * n; k++) {
      lowest = Math.min(lowest, s.heights[k]!);
      top = Math.max(top, s.heights[k]!, s.canopy?.top[k] ?? -Infinity, water?.[k] ?? -Infinity);
    }
    const field: DioramaField = {
      cols: n, rows: n, step: req.step, heights: s.heights, materials: s.materials,
      canopy: s.canopy ? { top: s.canopy.top, bottom: s.canopy.bottom, material: s.canopy.material } : null,
      water, base: lowest - req.depth,
    };
    const per = Math.max(1, Math.round((SECTION_M * 16) / req.step));
    const parts: DioramaPart[] = [];
    let quads = 0;
    for (let j0 = 0; j0 < n; j0 += per) {
      for (let i0 = 0; i0 < n; i0 += per) {
        const w = Math.min(per, n - i0), d = Math.min(per, n - j0);
        const m = meshDioramaSection(field, i0, j0, w, d);
        quads += m.ground.length + m.water.length;
        parts.push({
          x: req.x0 + i0 * req.step, y: field.base, z: req.z0 + j0 * req.step,
          ground: m.ground.length ? packQuads(m.ground) : null,
          water: m.water.length ? packQuads(m.water) : null,
        });
      }
    }
    const transfer = parts.flatMap((p) => [p.ground, p.water].flatMap((b) => (b ? [b.positions.buffer, b.faces.buffer] : [])));
    post({ type: 'area', id: req.id, x0: req.x0, z0: req.z0, size: req.size, base: field.base, top, parts, quads, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    post({ type: 'error', ...(req.type === 'area' ? { id: req.id } : {}), error: err instanceof Error ? err.message : String(err) });
  }
};
