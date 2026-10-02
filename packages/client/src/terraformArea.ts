import {
  NO_CANOPY,
  NO_WATER,
  PlateHeights,
  PlateStageCache,
  TerrainGenerator,
  type PlateTerrainConfig,
  type TerrainStroke,
  type VoxelizeConfig,
  type WorldConfig,
} from '@super-vox/shared';
import { meshDioramaSection, type DioramaField } from './dioramaMesher.js';
import { packQuads, type MeshBuffers } from './mesher.js';

/** Section size (m): a diorama is meshed (and patched) in squares this big. */
export const SECTION_M = 64;

export interface DioramaPart {
  /** Which section of the area (its first sample, "i,j"): a newer part with the same key replaces it. */
  key: string;
  /** Where the part's local origin is (units). */
  x: number;
  y: number;
  z: number;
  ground: MeshBuffers | null;
  water: MeshBuffers | null;
}

/** An area to make: its north-west corner and size, between samples, base depth below its lowest ground (units), and the draft. */
export interface AreaRequest {
  x0: number;
  z0: number;
  size: number;
  step: number;
  depth: number;
  strokes: TerrainStroke[];
}

export interface MadeArea {
  x0: number; z0: number; size: number; base: number; top: number; parts: DioramaPart[]; quads: number;
  heights: Int32Array; n: number; step: number;
}

export interface PatchedArea {
  /** Sections re-made, and the samples now (all of them), and how many were resampled. */
  parts: DioramaPart[];
  heights: Int32Array;
  samples: number;
}

/**
 * Makes dioramas of a world (see terraform.worker.ts): rebuilds it from its settings, makes an
 * area (sampled and meshed in sections) and keeps it, so a change to the draft can be patched in
 * quickly: just the samples and sections it touches, with the strokes applied to the samples
 * (rivers, lakes and climate follow when the area is made again with the strokes).
 */
export class AreaMaker {
  private strokesKey = '[]';
  heights: PlateHeights;
  generator: TerrainGenerator;
  private readonly cache = new PlateStageCache();
  private shown: { req: AreaRequest; field: DioramaField; per: number } | null = null;

  constructor(
    readonly world: WorldConfig,
    readonly config: PlateTerrainConfig,
    readonly voxelize: VoxelizeConfig,
  ) {
    this.heights = new PlateHeights(world, config, this.cache);
    this.generator = new TerrainGenerator(world, voxelize, this.heights);
  }

  /** The world built with `strokes` (rebuilt if they've changed, reusing every stage up to the heights). */
  withStrokes(strokes: TerrainStroke[]): this {
    const key = JSON.stringify(strokes);
    if (key !== this.strokesKey) {
      this.heights = new PlateHeights(this.world, this.config, this.cache, strokes);
      this.generator = new TerrainGenerator(this.world, this.voxelize, this.heights);
      this.strokesKey = key;
    } else this.heights.setSampleStrokes(strokes); // (after quick patches, which change only what samples apply)
    return this;
  }

  /** Makes the area asked for, whole (with the world built with its strokes), and keeps it for patches. */
  make(req: AreaRequest): MadeArea {
    const g = this.withStrokes(req.strokes).generator;
    const n = Math.round(req.size / req.step);
    const s = sampleField(g, req.x0, req.z0, req.step, n);
    let lowest = Infinity;
    for (let k = 0; k < n * n; k++) lowest = Math.min(lowest, s.heights[k]!);
    const field: DioramaField = {
      cols: n, rows: n, step: req.step, heights: s.heights, materials: s.materials,
      canopy: s.canopy ? { top: s.canopy.top, bottom: s.canopy.bottom, material: s.canopy.material } : null,
      water: s.water, base: lowest - req.depth,
    };
    const per = Math.max(1, Math.round((SECTION_M * 16) / req.step));
    this.shown = { req, field, per };
    const parts: DioramaPart[] = [];
    for (let j0 = 0; j0 < n; j0 += per) for (let i0 = 0; i0 < n; i0 += per) parts.push(meshPart(field, req, per, i0, j0));
    let top = -Infinity;
    for (let k = 0; k < n * n; k++) top = Math.max(top, field.heights[k]!, field.canopy?.top[k] ?? -Infinity, field.water?.[k] ?? -Infinity);
    return { x0: req.x0, z0: req.z0, size: req.size, base: field.base, top, parts, quads: quadsOf(parts), heights: field.heights.slice(), n, step: req.step };
  }

  /**
   * The draft (`strokes`) changed within `box` (metres, x within the world): resamples and
   * re-meshes the area showing there only; or, if that dug below the area's base, makes it all
   * again (a MadeArea). Null with no area showing.
   */
  patch(strokes: TerrainStroke[], box: { x0: number; z0: number; x1: number; z1: number }): PatchedArea | MadeArea | null {
    if (!this.shown) return null;
    this.heights.setSampleStrokes(strokes);
    const { field: f, per } = this.shown, a = this.shown.req;
    const M = 16, W = this.world.widthUnits;
    // The box in the area's own x (round worlds: its copy nearest the area).
    let bx0 = box.x0 * M, bx1 = box.x1 * M;
    if (this.world.wrapX) {
      const shift = Math.round((a.x0 + a.size / 2 - (bx0 + bx1) / 2) / W) * W;
      bx0 += shift;
      bx1 += shift;
    }
    // Samples under the box, and one more each way (their walls face the changed ones).
    const i0 = Math.max(0, Math.floor((bx0 - a.x0) / a.step) - 1), i1 = Math.min(f.cols - 1, Math.ceil((bx1 - a.x0) / a.step) + 1);
    const j0 = Math.max(0, Math.floor((box.z0 * M - a.z0) / a.step) - 1), j1 = Math.min(f.rows - 1, Math.ceil((box.z1 * M - a.z0) / a.step) + 1);
    if (i1 < i0 || j1 < j0) return { parts: [], heights: f.heights.slice(), samples: 0 };
    const w = i1 - i0 + 1, d = j1 - j0 + 1, m = Math.max(w, d);
    const s = sampleField(this.generator, a.x0 + i0 * a.step, a.z0 + j0 * a.step, a.step, m);
    // Dug below the diorama's base: make it all again (with a deeper base).
    for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
      if (s.heights[i + m * j]! < f.base + M) return this.make({ ...a, strokes });
    }
    if (s.canopy && !f.canopy) f.canopy = { top: new Int32Array(f.cols * f.rows).fill(NO_CANOPY), bottom: new Int32Array(f.cols * f.rows).fill(NO_CANOPY), material: new Uint16Array(f.cols * f.rows) };
    if (s.water && !f.water) f.water = new Int32Array(f.cols * f.rows).fill(NO_WATER);
    for (let j = 0; j < d; j++) {
      for (let i = 0; i < w; i++) {
        const k = i + m * j, g = i0 + i + f.cols * (j0 + j);
        f.heights[g] = s.heights[k]!;
        f.materials[g] = s.materials[k]!;
        if (f.canopy) {
          f.canopy.top[g] = s.canopy ? s.canopy.top[k]! : NO_CANOPY;
          f.canopy.bottom[g] = s.canopy ? s.canopy.bottom[k]! : NO_CANOPY;
          f.canopy.material[g] = s.canopy ? s.canopy.material[k]! : 0;
        }
        if (f.water) f.water[g] = s.water ? s.water[k]! : NO_WATER;
      }
    }
    // The sections those samples are in.
    const parts: DioramaPart[] = [];
    for (let sj = Math.floor(j0 / per) * per; sj <= j1; sj += per) for (let si = Math.floor(i0 / per) * per; si <= i1; si += per) parts.push(meshPart(f, a, per, si, sj));
    return { parts, heights: f.heights.slice(), samples: w * d };
  }
}

/** Samples (with the sea as water) over n x n samples from (x0, z0), `step` apart (units). */
function sampleField(g: TerrainGenerator, x0: number, z0: number, step: number, n: number) {
  const s = g.surfaceSamples(x0 + Math.floor(step / 2), z0 + Math.floor(step / 2), step, n);
  const sea = g.seaLevel;
  let water = s.water;
  if (sea !== null) {
    water ??= new Int32Array(n * n).fill(NO_WATER);
    for (let k = 0; k < n * n; k++) if (s.heights[k]! < sea && water[k]! < sea) water[k] = sea;
  }
  return { heights: s.heights, materials: s.materials, canopy: s.canopy, water };
}

/** Meshes the section starting at sample (i0, j0) as a part. */
function meshPart(f: DioramaField, req: { x0: number; z0: number; step: number }, per: number, i0: number, j0: number): DioramaPart {
  const w = Math.min(per, f.cols - i0), d = Math.min(per, f.rows - j0);
  const m = meshDioramaSection(f, i0, j0, w, d);
  return {
    key: `${i0},${j0}`, x: req.x0 + i0 * req.step, y: f.base, z: req.z0 + j0 * req.step,
    ground: m.ground.length ? packQuads(m.ground) : null,
    water: m.water.length ? packQuads(m.water) : null,
  };
}

export const buffersOf = (parts: DioramaPart[]): ArrayBuffer[] => parts.flatMap((p) => [p.ground, p.water].flatMap((b) => (b ? [b.positions.buffer as ArrayBuffer, b.faces.buffer as ArrayBuffer] : [])));
const quadsOf = (parts: DioramaPart[]) => parts.reduce((n, p) => n + (p.ground?.quadCount ?? 0) + (p.water?.quadCount ?? 0), 0);
