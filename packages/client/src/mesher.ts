import {
  Material,
  blockWater,
  emptyChunk,
  isWater,
  setBlockWater,
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  blockIndex,
  gridCellIndex,
  rasterizeVoxels,
  unitIndex,
  unpackVoxel,
  type Block,
  type Chunk,
  type GridBlock,
  type MaterialId,
} from '@super-vox/shared';
import { faceLight, type LightFields } from './skyLight.js';

/**
 * Face directions, indexed 0..5: +X, -X, +Y, -Y, +Z, -Z. Neighbor chunks are
 * passed in the same order.
 */
export const DIRS = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
] as const;

/** In-plane axes for faces perpendicular to each axis, chosen so U x V = +axis. */
const U_AXIS = [1, 2, 0] as const;
const V_AXIS = [2, 0, 1] as const;

/**
 * A visible rectangle, in chunk-local units. It lies in the plane
 * `axis = plane` and spans [u, u+du) x [v, v+dv) on the U/V axes.
 * `size` is the edge of the voxels it belongs to (used to draw voxel edges).
 */
export interface Quad {
  dir: number;
  plane: number;
  u: number;
  v: number;
  du: number;
  dv: number;
  material: MaterialId;
  size: number;
  /**
   * Where the voxel's own grid starts, as its block-local position modulo its
   * size, on the face's two in-plane axes in shader order: (Y, Z) for X
   * faces, (X, Z) for Y faces, (X, Y) for Z faces. Voxel edge lines are drawn
   * from here, so voxels not aligned to their size draw correct edges.
   * Omitted = 0 (aligned).
   */
  pa?: number;
  pb?: number;
  /**
   * Ambient occlusion at the corners (u, v), (u+du, v), (u+du, v+dv), (u, v+dv): 0 (open) .. 3
   * (in a corner). Omitted = all 0.
   */
  ao?: readonly [number, number, number, number];
  /** Sky light at the same corners, 0 (dark) .. 255 (open to the sky; see faceLight). Omitted = all 255. */
  light?: readonly [number, number, number, number];
  /** Block light (torches) at the same corners, 0 (none) .. 255 (15). Omitted = all 0. */
  glow?: readonly [number, number, number, number];
}

/** Chunks adjacent in each of the six directions; null means empty. */
export type Neighbors = readonly (Chunk | null)[];

function blockAt(chunk: Chunk, neighbors: Neighbors, b: [number, number, number]): Block {
  let out = 0;
  for (let axis = 0; axis < 3; axis++) if (b[axis]! < 0 || b[axis]! >= BLOCKS_PER_AXIS) out++;
  // Diagonal neighbour chunks aren't passed: treated as empty.
  if (out > 1) return null;
  for (let axis = 0; axis < 3; axis++) {
    const c = b[axis]!;
    if (c < 0 || c >= BLOCKS_PER_AXIS) {
      const dir = axis * 2 + (c < 0 ? 1 : 0);
      const nb = neighbors[dir];
      if (!nb) return null;
      const w: [number, number, number] = [b[0], b[1], b[2]];
      w[axis] = c < 0 ? c + BLOCKS_PER_AXIS : c - BLOCKS_PER_AXIS;
      return nb.blocks[blockIndex(w[0], w[1], w[2])] ?? null;
    }
  }
  return chunk.blocks[blockIndex(b[0], b[1], b[2])] ?? null;
}

function gridCell(block: GridBlock, axis: number, layer: number, cu: number, cv: number): MaterialId {
  const n = BLOCK_SIZE / block.size;
  const c = [0, 0, 0];
  c[axis] = layer;
  c[U_AXIS[axis]!] = cu;
  c[V_AXIS[axis]!] = cv;
  return block.materials[gridCellIndex(n, c[0]!, c[1]!, c[2]!)] ?? 0;
}

/**
 * Unit-resolution coverage test against a rasterized block: emits the whole
 * square if nothing covers it, otherwise each uncovered unit square.
 * `layer` is the unit coordinate along `axis` of the covering cells.
 */
function emitUncoveredUnits(
  raster: Uint16Array,
  axis: number,
  layer: number,
  u0: number,
  v0: number,
  size: number,
  emit: (u: number, v: number, du: number, dv: number) => void,
): void {
  const c = [0, 0, 0];
  c[axis] = layer;
  const ua = U_AXIS[axis]!;
  const va = V_AXIS[axis]!;
  let covered = 0;
  for (let u = u0; u < u0 + size; u++) {
    for (let v = v0; v < v0 + size; v++) {
      c[ua] = u; c[va] = v;
      if (raster[unitIndex(c[0]!, c[1]!, c[2]!)] !== 0) covered++;
    }
  }
  if (covered === 0) {
    emit(u0, v0, size, size);
    return;
  }
  if (covered === size * size) return;
  for (let u = u0; u < u0 + size; u++) {
    for (let v = v0; v < v0 + size; v++) {
      c[ua] = u; c[va] = v;
      if (raster[unitIndex(c[0]!, c[1]!, c[2]!)] === 0) emit(u, v, 1, 1);
    }
  }
}

/**
 * Calls `emit(u, v, du, dv)` (block-local units) for each part of the square
 * [u0, u0+size)^2 on the face of a block in direction `dir` that is not
 * covered by the solid voxels of the adjacent block `nb`.
 */
function forUncovered(
  nb: Block,
  dir: number,
  u0: number,
  v0: number,
  size: number,
  emit: (u: number, v: number, du: number, dv: number) => void,
): void {
  if (nb === null) {
    emit(u0, v0, size, size);
    return;
  }
  if (nb.kind === 'uniform') return;
  const { axis, sign } = DIRS[dir]!;
  if (nb.kind === 'voxels') {
    emitUncoveredUnits(rasterizeVoxels(nb).materials, axis, sign > 0 ? 0 : BLOCK_SIZE - 1, u0, v0, size, emit);
    return;
  }
  // Walk every neighbor grid cell the square overlaps and emit the overlap
  // wherever that cell is empty. Works for any square size and alignment.
  const s2 = nb.size;
  const layer = sign > 0 ? 0 : BLOCK_SIZE / s2 - 1;
  const u1 = u0 + size, v1 = v0 + size;
  for (let cu = Math.floor(u0 / s2); cu * s2 < u1; cu++) {
    for (let cv = Math.floor(v0 / s2); cv * s2 < v1; cv++) {
      if (gridCell(nb, axis, layer, cu, cv) !== 0) continue;
      const a = Math.max(u0, cu * s2), b = Math.max(v0, cv * s2);
      emit(a, b, Math.min(u1, (cu + 1) * s2) - a, Math.min(v1, (cv + 1) * s2) - b);
    }
  }
}

const AXIS_OF = [0, 0, 1, 1, 2, 2] as const;
const SIGN_OF = [1, -1, 1, -1, 1, -1] as const;

/**
 * Visible faces of one block in block-local units (plane, u, v in 0..16),
 * given its six neighbor blocks in DIRS order.
 */
function blockFaces(block: Exclude<Block, null>, nbBlocks: readonly Block[]): Quad[] {
  const out: Quad[] = [];
  if (block.kind === 'uniform') {
    for (let d = 0; d < 6; d++) {
      const plane = SIGN_OF[d]! > 0 ? BLOCK_SIZE : 0;
      forUncovered(nbBlocks[d]!, d, 0, 0, BLOCK_SIZE, (u, v, du, dv) =>
        out.push({ dir: d, plane, u, v, du, dv, material: block.material, size: block.size }),
      );
    }
    return out;
  }

  if (block.kind === 'voxels') {
    const raster = rasterizeVoxels(block).materials;
    const c = [0, 0, 0];
    for (let i = 0; i < block.packed.length; i++) {
      const { x, y, z, size } = unpackVoxel(block.packed[i]!);
      const material = block.materials[i]!;
      c[0] = x; c[1] = y; c[2] = z;
      for (let d = 0; d < 6; d++) {
        const axis = AXIS_OF[d]!;
        const sign = SIGN_OF[d]!;
        const u = c[U_AXIS[axis]]!;
        const v = c[V_AXIS[axis]]!;
        const plane = c[axis]! + (sign > 0 ? size : 0);
        const layer = sign > 0 ? c[axis]! + size : c[axis]! - 1;
        const pa = (axis === 0 ? y : x) % size;
        const pb = (axis === 2 ? y : z) % size;
        const emit = (fu: number, fv: number, du: number, dv: number) =>
          out.push({ dir: d, plane, u: fu, v: fv, du, dv, material, size, pa, pb });
        if (layer >= 0 && layer < BLOCK_SIZE) emitUncoveredUnits(raster, axis, layer, u, v, size, emit);
        else forUncovered(nbBlocks[d]!, d, u, v, size, emit);
      }
    }
    return out;
  }

  const s = block.size;
  const n = BLOCK_SIZE / s;
  const mats = block.materials;
  // Index strides per axis for materials[x + n * (z + n * y)].
  const stride = [1, n * n, n];
  const c = [0, 0, 0];
  let idx = 0;
  for (let cy = 0; cy < n; cy++) {
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++, idx++) {
        const material = mats[idx]!;
        if (material === 0) continue;
        c[0] = cx; c[1] = cy; c[2] = cz;
        for (let d = 0; d < 6; d++) {
          const axis = AXIS_OF[d]!;
          const sign = SIGN_OF[d]!;
          const next = c[axis]! + sign;
          const u = c[U_AXIS[axis]]! * s;
          const v = c[V_AXIS[axis]]! * s;
          const plane = (c[axis]! + (sign > 0 ? 1 : 0)) * s;
          if (next >= 0 && next < n) {
            if (mats[idx + sign * stride[axis]!] === 0) {
              out.push({ dir: d, plane, u, v, du: s, dv: s, material, size: s });
            }
          } else {
            forUncovered(nbBlocks[d]!, d, u, v, s, (fu, fv, du, dv) =>
              out.push({ dir: d, plane, u: fu, v: fv, du, dv, material, size: s }),
            );
          }
        }
      }
    }
  }
  return out;
}

/** Whether the unit cell at chunk-local (x, y, z) is solid; cells of chunks not passed are empty. */
function solidCell(chunk: Chunk, neighbors: Neighbors, b: [number, number, number], x: number, y: number, z: number): boolean {
  b[0] = Math.floor(x / BLOCK_SIZE); b[1] = Math.floor(y / BLOCK_SIZE); b[2] = Math.floor(z / BLOCK_SIZE);
  const block = blockAt(chunk, neighbors, b);
  if (!block) return false;
  if (block.kind === 'uniform') return true;
  const lx = x - b[0] * BLOCK_SIZE, ly = y - b[1] * BLOCK_SIZE, lz = z - b[2] * BLOCK_SIZE;
  if (block.kind === 'grid') {
    const s = block.size, n = BLOCK_SIZE / s;
    return block.materials[gridCellIndex(n, Math.floor(lx / s), Math.floor(ly / s), Math.floor(lz / s))] !== 0;
  }
  return rasterizeVoxels(block).materials[unitIndex(lx, ly, lz)] !== 0;
}

/** Ambient occlusion looks past this far out from a face (units, 1/8 m), whatever its voxel size. */
const AO_REACH = 2;

/**
 * Ambient occlusion at the four corners of a face (chunk-local units), from the cells just in
 * front of it: at each corner, the two beside it along the face's edges and the one diagonal to
 * it, AO_REACH out from the face. The samples depend only on the corner, so faces of any size
 * agree where they meet, and steps no higher than AO_REACH cast no creases. Both sides solid: 3;
 * otherwise the number solid.
 */
function faceOcclusion(chunk: Chunk, neighbors: Neighbors, q: Quad, b: [number, number, number]): [number, number, number, number] {
  const axis = AXIS_OF[q.dir]!, ua = U_AXIS[axis]!, va = V_AXIS[axis]!;
  const half = 0.5; // the cells touching the corner
  // Out along the face's normal (a cell centre).
  const layer = SIGN_OF[q.dir]! > 0 ? q.plane + AO_REACH + 0.5 : q.plane - AO_REACH - 0.5;
  const p = [0, 0, 0];
  const solid = (u: number, v: number) => {
    p[axis] = layer; p[ua] = u; p[va] = v;
    return solidCell(chunk, neighbors, b, Math.floor(p[0]!), Math.floor(p[1]!), Math.floor(p[2]!));
  };
  const corner = (cu: number, cv: number, su: number, sv: number) => {
    // su, sv: away from the face along U and V.
    const a = solid(cu + su * half, cv - sv * half), c = solid(cu - su * half, cv + sv * half);
    if (a && c) return 3;
    return (a ? 1 : 0) + (c ? 1 : 0) + (solid(cu + su * half, cv + sv * half) ? 1 : 0);
  };
  const u0 = q.u, v0 = q.v, u1 = q.u + q.du, v1 = q.v + q.dv;
  return [corner(u0, v0, -1, -1), corner(u1, v0, 1, -1), corner(u1, v1, 1, 1), corner(u0, v1, -1, 1)];
}

/**
 * Collects every visible voxel face of `chunk`, merged within each block, with ambient occlusion
 * at their corners, and sky and block light from `light` (the chunk's, see lightFields). Faces
 * against a null neighbor are visible. Blocks with identical contents and identical neighbor
 * objects share the face search.
 */
export function visibleFaces(chunk: Chunk, neighbors: Neighbors, occlusion = true, light: LightFields | null = null): Quad[] {
  const out: Quad[] = [];
  const b: [number, number, number] = [0, 0, 0];
  const probe: [number, number, number] = [0, 0, 0];
  const nbBlocks: Block[] = new Array(6);
  const ids = new Map<Block, number>([[null, 0]]);
  const idOf = (x: Block) => {
    let id = ids.get(x);
    if (id === undefined) ids.set(x, (id = ids.size));
    return id;
  };
  const memo = new Map<string, Quad[]>();

  for (let by = 0; by < BLOCKS_PER_AXIS; by++) {
    for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++) {
      for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
        const block = chunk.blocks[blockIndex(bx, by, bz)];
        if (!block) continue;
        let key = String(idOf(block));
        for (let d = 0; d < 6; d++) {
          b[0] = bx; b[1] = by; b[2] = bz;
          b[AXIS_OF[d]!] += SIGN_OF[d]!;
          nbBlocks[d] = blockAt(chunk, neighbors, b);
          key += ',' + idOf(nbBlocks[d]!);
        }
        let local = memo.get(key);
        if (!local) {
          local = blockFaces(block, nbBlocks);
          memo.set(key, local);
        }
        if (local.length === 0) continue;
        const origin = [bx * BLOCK_SIZE, by * BLOCK_SIZE, bz * BLOCK_SIZE];
        // Occlusion depends on more than the six neighbours, so it's found per block, then merged.
        const placed = local.map((q) => {
          const axis = AXIS_OF[q.dir]!;
          const g: Quad = { ...q, plane: q.plane + origin[axis]!, u: q.u + origin[U_AXIS[axis]]!, v: q.v + origin[V_AXIS[axis]]! };
          if (occlusion) {
            const ao = faceOcclusion(chunk, neighbors, g, probe);
            if (ao[0] || ao[1] || ao[2] || ao[3]) g.ao = ao;
          }
          if (light?.sky) {
            const l = faceLight(light.sky, g.dir, g.plane, g.u, g.v, g.du, g.dv);
            if (l[0] < 255 || l[1] < 255 || l[2] < 255 || l[3] < 255) g.light = l;
          }
          if (light?.block) {
            const l = faceLight(light.block, g.dir, g.plane, g.u, g.v, g.du, g.dv, 0);
            if (l[0] || l[1] || l[2] || l[3]) g.glow = l;
          }
          return g;
        });
        for (const q of mergeFaces(placed)) out.push(q);
      }
    }
  }
  return out;
}

/** A chunk of nothing but water. */
const ALL_WATER: Chunk = { ...emptyChunk({ cx: 0, cy: 0, cz: 0 }), blocks: new Array(4096).fill(setBlockWater(null, 0)) };

/**
 * Faces where a chunk's water meets air (water against solid ground or more water draws
 * nothing), merged as one material. Missing neighbours beside it count as water, so the edge of
 * the loaded area shows no walls of water; above and below, as air.
 */
export function waterQuads(chunk: Chunk, neighbors: Neighbors): Quad[] {
  const wet = chunk.blocks.map((b) => blockWater(b ?? null) !== null);
  if (!wet.includes(true)) return [];
  // Only blocks with water, and those next to them (which can hide its faces), matter.
  const blocks = chunk.blocks.map((b, i) => {
    if (wet[i]) return b;
    const x = i % BLOCKS_PER_AXIS, z = Math.floor(i / BLOCKS_PER_AXIS) % BLOCKS_PER_AXIS, y = Math.floor(i / (BLOCKS_PER_AXIS * BLOCKS_PER_AXIS));
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= BLOCKS_PER_AXIS || ny >= BLOCKS_PER_AXIS || nz >= BLOCKS_PER_AXIS) continue;
      if (wet[blockIndex(nx, ny, nz)]) return b;
    }
    return null;
  });
  const around = neighbors.map((n, d) => n ?? (d === 2 || d === 3 ? null : ALL_WATER));
  const faces = visibleFaces({ ...chunk, blocks }, around, false)
    .filter((q) => isWater(q.material))
    .map((q): Quad => ({ dir: q.dir, plane: q.plane, u: q.u, v: q.v, du: q.du, dv: q.dv, material: Material.Water, size: 16 }));
  return mergeFaces(faces);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** A face's shading at corner k: its occlusion and light together (equal shading, equal key). */
const shadeAt = (f: Quad, k: number) => ((f.ao ? f.ao[k]! : 0) * 256 + (f.light ? f.light[k]! : 255)) * 256 + (f.glow ? f.glow[k]! : 0);

/**
 * Greedily merges coplanar faces that share direction, material, and voxel
 * size into larger rectangles. The union of the output equals the union of
 * the input. Faces with the same shading (occlusion and light) at all four corners merge
 * (keeping it); faces with differing corners are kept as they are.
 */
export function mergeFaces(faces: Quad[]): Quad[] {
  const groups = new Map<string, Quad[]>();
  const out: Quad[] = [];
  // Faces whose occlusion only varies across V (or U) merge in strips along U (or V) with faces
  // of the same span and shading; others with uneven corners stay as they are.
  const strips = new Map<string, Quad[]>();
  for (const f of faces) {
    const ao = f.ao || f.light || f.glow ? [shadeAt(f, 0), shadeAt(f, 1), shadeAt(f, 2), shadeAt(f, 3)] : undefined;
    const kind = `${f.dir}|${f.plane}|${f.material}|${f.size}|${f.pa ?? 0}|${f.pb ?? 0}`;
    if (ao && !(ao[0] === ao[1] && ao[1] === ao[2] && ao[2] === ao[3])) {
      const alongU = ao[0] === ao[1] && ao[3] === ao[2], alongV = ao[0] === ao[3] && ao[1] === ao[2];
      if (!alongU && !alongV) {
        out.push(f);
        continue;
      }
      const key = alongU ? `${kind}|u|${f.v}|${f.dv}|${ao}` : `${kind}|v|${f.u}|${f.du}|${ao}`;
      let g = strips.get(key);
      if (!g) strips.set(key, (g = []));
      g.push(f);
      continue;
    }
    const key = `${kind}|${ao ? ao[0] : 0}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(f);
  }

  for (const [key, group] of strips) {
    const alongU = key.includes('|u|');
    group.sort((p, q) => (alongU ? p.u - q.u : p.v - q.v));
    let run = { ...group[0]! };
    for (const f of group.slice(1)) {
      if (alongU && f.u === run.u + run.du) run.du += f.du;
      else if (!alongU && f.v === run.v + run.dv) run.dv += f.dv;
      else {
        out.push(run);
        run = { ...f };
      }
    }
    out.push(run);
  }

  for (const group of groups.values()) {
    const first = group[0]!;
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const f of group) {
      minU = Math.min(minU, f.u); minV = Math.min(minV, f.v);
      maxU = Math.max(maxU, f.u + f.du); maxV = Math.max(maxV, f.v + f.dv);
    }
    // Work on the coarsest lattice all rectangles align to, per axis: on
    // tiles, walls span arbitrary heights on one axis but whole cells on the
    // other, and a shared divisor would make the mask enormous.
    let gu = 0, gv = 0;
    for (const f of group) {
      gu = gcd(gcd(gu, f.u - minU), f.du);
      gv = gcd(gcd(gv, f.v - minV), f.dv);
    }
    const w = (maxU - minU) / gu;
    const h = (maxV - minV) / gv;
    const mask = new Uint8Array(w * h);
    for (const f of group) {
      const u0 = (f.u - minU) / gu, v0 = (f.v - minV) / gv;
      for (let j = v0; j < v0 + f.dv / gv; j++) mask.fill(1, j * w + u0, j * w + u0 + f.du / gu);
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!mask[j * w + i]) continue;
        let du = 1;
        while (i + du < w && mask[j * w + i + du]) du++;
        let dv = 1;
        outer: while (j + dv < h) {
          for (let k = 0; k < du; k++) if (!mask[(j + dv) * w + i + k]) break outer;
          dv++;
        }
        for (let jj = j; jj < j + dv; jj++) mask.fill(0, jj * w + i, jj * w + i + du);
        out.push({ ...first, u: minU + i * gu, v: minV + j * gv, du: du * gu, dv: dv * gv });
      }
    }
  }
  return out;
}

/**
 * Packed mesh data, 10 bytes per vertex and 4 vertices per quad:
 * - `positions`: chunk-local units (0..256) as u16 x, y, z.
 * - `faces`, per vertex (the same for all 4 vertices of a quad but the last 2 bits):
 *   byte 0: direction (0..5) | (voxel size - 1) << 3;
 *   byte 1: grid phase a (0..15) | phase b << 4 (see Quad.pa/pb);
 *   bytes 2-3: material (14 bits, little-endian; higher ids are drawn as unknown)
 *   | the corner's occlusion (0..3) << 14.
 * Corners are ordered so every quad is drawn with the same index pattern
 * (see quadIndexPattern) and faces outward, starting where the quad's diagonal should run
 * between its two most occluded corners (so occlusion shades evenly).
 */
export interface MeshBuffers {
  positions: Uint16Array;
  faces: Uint8Array;
  /**
   * Per vertex, 2 bytes: how far its sky light is below full (0 open to the sky .. 255 dark), and
   * its block light (0 none .. 255 full); omitted when every vertex is (0, 0).
   */
  shade?: Uint8Array;
  quadCount: number;
}

/** (Without `shade`, which only meshes in shade or by torches have.) */
export const BYTES_PER_QUAD = 4 * (3 * 2 + 4);

/** Triangle indices for quad q: every quad uses this pattern offset by 4q. */
export const QUAD_INDEX_PATTERN = [0, 1, 2, 0, 2, 3] as const;

/** Builds an index buffer covering `quads` quads. */
export function quadIndices(quads: number): Uint32Array {
  const out = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    for (let k = 0; k < 6; k++) out[q * 6 + k] = q * 4 + QUAD_INDEX_PATTERN[k]!;
  }
  return out;
}

const NO_AO = [0, 0, 0, 0] as const;
const FULL_LIGHT = [255, 255, 255, 255] as const;
/** Highest material id a mesh can carry (14 bits); higher ids are clamped to it (drawn as unknown). */
export const MAX_MESH_MATERIAL = 0x3fff;

/** Packs quads into vertex buffers. */
export function packQuads(quads: Quad[]): MeshBuffers {
  const n = quads.length;
  const positions = new Uint16Array(n * 12);
  const faces = new Uint8Array(n * 16);
  const shade = quads.some((q) => q.light || q.glow) ? new Uint8Array(n * 8) : undefined;
  const p = [0, 0, 0];
  quads.forEach((q, qi) => {
    const { axis, sign } = DIRS[q.dir]!;
    const ua = U_AXIS[axis]!;
    const va = V_AXIS[axis]!;
    // Counter-clockwise seen from outside: U then V for +dirs, V then U for -dirs.
    const ao = q.ao ?? NO_AO, light = q.light ?? FULL_LIGHT, glow = q.glow ?? NO_AO;
    // Corner k as an index into Quad.ao.
    let order = sign > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    // Triangles split along corners 0-2; run that diagonal between the more shaded pair.
    const dim = (c: number) => ao[c]! + (255 - Math.max(light[c]!, glow[c]!)) / 64;
    if (dim(order[0]!) + dim(order[2]!) < dim(order[1]!) + dim(order[3]!)) order = [order[1]!, order[2]!, order[3]!, order[0]!];
    const material = Math.min(q.material, MAX_MESH_MATERIAL);
    order.forEach((c, k) => {
      const u = c === 1 || c === 2 ? q.u + q.du : q.u, v = c >= 2 ? q.v + q.dv : q.v;
      p[axis] = q.plane; p[ua] = u; p[va] = v;
      const vi = qi * 4 + k;
      positions[vi * 3] = p[0]!;
      positions[vi * 3 + 1] = p[1]!;
      positions[vi * 3 + 2] = p[2]!;
      faces[vi * 4] = q.dir | ((q.size - 1) << 3);
      faces[vi * 4 + 1] = (q.pa ?? 0) | ((q.pb ?? 0) << 4);
      faces[vi * 4 + 2] = material & 0xff;
      faces[vi * 4 + 3] = (material >> 8) | (ao[c]! << 6);
      if (shade) {
        shade[vi * 2] = 255 - light[c]!;
        shade[vi * 2 + 1] = glow[c]!;
      }
    });
  });
  return shade ? { positions, faces, shade, quadCount: n } : { positions, faces, quadCount: n };
}
