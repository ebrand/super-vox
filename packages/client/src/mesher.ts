import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  UNITS_PER_METER,
  blockIndex,
  gridCellIndex,
  type Block,
  type Chunk,
  type GridBlock,
  type MaterialId,
} from '@super-vox/shared';

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
}

/** Chunks adjacent in each of the six directions; null means empty. */
export type Neighbors = readonly (Chunk | null)[];

function blockAt(chunk: Chunk, neighbors: Neighbors, b: [number, number, number]): Block {
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
  const s2 = nb.size;
  const layer = sign > 0 ? 0 : BLOCK_SIZE / s2 - 1;
  if (s2 >= size) {
    if (gridCell(nb, axis, layer, Math.floor(u0 / s2), Math.floor(v0 / s2)) === 0) emit(u0, v0, size, size);
    return;
  }
  for (let u = u0; u < u0 + size; u += s2) {
    for (let v = v0; v < v0 + size; v += s2) {
      if (gridCell(nb, axis, layer, u / s2, v / s2) === 0) emit(u, v, s2, s2);
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

/**
 * Collects every visible voxel face of `chunk`, merged within each block.
 * Faces against a null neighbor are visible. Blocks with identical contents
 * and identical neighbor objects share one computation.
 */
export function visibleFaces(chunk: Chunk, neighbors: Neighbors): Quad[] {
  const out: Quad[] = [];
  const b: [number, number, number] = [0, 0, 0];
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
          local = mergeFaces(blockFaces(block, nbBlocks));
          memo.set(key, local);
        }
        const origin = [bx * BLOCK_SIZE, by * BLOCK_SIZE, bz * BLOCK_SIZE];
        for (const q of local) {
          const axis = AXIS_OF[q.dir]!;
          out.push({
            ...q,
            plane: q.plane + origin[axis]!,
            u: q.u + origin[U_AXIS[axis]]!,
            v: q.v + origin[V_AXIS[axis]]!,
          });
        }
      }
    }
  }
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Greedily merges coplanar faces that share direction, material, and voxel
 * size into larger rectangles. The union of the output equals the union of
 * the input.
 */
export function mergeFaces(faces: Quad[]): Quad[] {
  const groups = new Map<string, Quad[]>();
  for (const f of faces) {
    const key = `${f.dir}|${f.plane}|${f.material}|${f.size}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(f);
  }

  const out: Quad[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const f of group) {
      minU = Math.min(minU, f.u); minV = Math.min(minV, f.v);
      maxU = Math.max(maxU, f.u + f.du); maxV = Math.max(maxV, f.v + f.dv);
    }
    // Work on the coarsest lattice all rectangles align to.
    let g = 0;
    for (const f of group) g = gcd(gcd(gcd(gcd(g, f.u - minU), f.v - minV), f.du), f.dv);
    const w = (maxU - minU) / g;
    const h = (maxV - minV) / g;
    const mask = new Uint8Array(w * h);
    for (const f of group) {
      const u0 = (f.u - minU) / g, v0 = (f.v - minV) / g;
      for (let j = v0; j < v0 + f.dv / g; j++) mask.fill(1, j * w + u0, j * w + u0 + f.du / g);
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
        out.push({ ...first, u: minU + i * g, v: minV + j * g, du: du * g, dv: dv * g });
      }
    }
  }
  return out;
}

export interface MeshBuffers {
  /** Chunk-local meters. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Voxel edge in units, per vertex. */
  voxelSizes: Float32Array;
  indices: Uint32Array;
}

/** Turns quads into indexed triangle buffers with counter-clockwise front faces. */
export function buildBuffers(quads: Quad[], colorOf: (m: MaterialId) => readonly [number, number, number]): MeshBuffers {
  const n = quads.length;
  const positions = new Float32Array(n * 12);
  const normals = new Float32Array(n * 12);
  const colors = new Float32Array(n * 12);
  const voxelSizes = new Float32Array(n * 4);
  const indices = new Uint32Array(n * 6);
  const p = [0, 0, 0];
  quads.forEach((q, qi) => {
    const { axis, sign } = DIRS[q.dir]!;
    const ua = U_AXIS[axis]!;
    const va = V_AXIS[axis]!;
    const corners = [
      [q.u, q.v],
      [q.u + q.du, q.v],
      [q.u + q.du, q.v + q.dv],
      [q.u, q.v + q.dv],
    ] as const;
    const color = colorOf(q.material);
    corners.forEach(([u, v], k) => {
      p[axis] = q.plane; p[ua] = u; p[va] = v;
      const o = (qi * 4 + k) * 3;
      for (let a = 0; a < 3; a++) {
        positions[o + a] = p[a]! / UNITS_PER_METER;
        normals[o + a] = a === axis ? sign : 0;
        colors[o + a] = color[a]!;
      }
      voxelSizes[qi * 4 + k] = q.size;
    });
    const base = qi * 4;
    const tri = sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    tri.forEach((t, k) => (indices[qi * 6 + k] = base + t));
  });
  return { positions, normals, colors, voxelSizes, indices };
}
