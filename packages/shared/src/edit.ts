import {
  BLOCK_SIZE,
  blockIndex,
  gridCellIndex,
  packVoxel,
  rasterizeVoxels,
  unitIndex,
  unpackVoxel,
  type Block,
  type Chunk,
} from './chunk.js';
import type { MaterialId } from './materials.js';
import { breakSizesFor, isValidVoxelSize } from './units.js';
import { voxelFitsInBlock } from './voxel.js';
import { CHUNK_SIZE } from './world.js';

/**
 * A voxel edit. Coordinates are world units (1/16 m).
 * - remove: remove the voxel covering unit cell (x, y, z).
 * - break: split the voxel covering (x, y, z) into equal pieces of `pieceSize`,
 *   which must evenly divide it.
 * - place: add a voxel with its minimum corner at (x, y, z) that must not
 *   overlap any existing voxel. `applyEdit` requires it to lie in one 1 m
 *   block; servers accept any cube and place `splitPlacement` pieces.
 */
export type Edit =
  | { op: 'remove'; x: number; y: number; z: number }
  | { op: 'break'; x: number; y: number; z: number; pieceSize: number }
  | { op: 'place'; x: number; y: number; z: number; size: number; material: MaterialId }
  | RemoveBoxEdit;

/**
 * Removes every voxel with any part inside the cube [x, x+size)^3 (world
 * units). Unlike a voxel, the cube may cross 1 m gridlines and chunk borders.
 */
export interface RemoveBoxEdit {
  op: 'removeBox';
  x: number;
  y: number;
  z: number;
  size: number;
}

export class EditError extends Error {}

/** A voxel in block-local units. */
export interface BlockVoxel {
  x: number;
  y: number;
  z: number;
  size: number;
  material: MaterialId;
}

const mod = (v: number, m: number) => ((v % m) + m) % m;

/** The voxel covering block-local unit cell (x, y, z), or null for air. */
export function blockVoxelContaining(block: Block, x: number, y: number, z: number): BlockVoxel | null {
  if (!block) return null;
  if (block.kind === 'uniform' || block.kind === 'grid') {
    const s = block.size;
    const [cx, cy, cz] = [Math.floor(x / s), Math.floor(y / s), Math.floor(z / s)];
    const material = block.kind === 'uniform' ? block.material : block.materials[gridCellIndex(BLOCK_SIZE / s, cx, cy, cz)]!;
    return material === 0 ? null : { x: cx * s, y: cy * s, z: cz * s, size: s, material };
  }
  const i = rasterizeVoxels(block).index[unitIndex(x, y, z)]!;
  if (i === 0) return null;
  const v = unpackVoxel(block.packed[i - 1]!);
  return { ...v, material: block.materials[i - 1]! };
}

/** Every voxel of a block, in block-local units. */
export function blockVoxels(block: Block): BlockVoxel[] {
  if (!block) return [];
  if (block.kind === 'voxels') {
    return Array.from(block.packed, (p, i) => ({ ...unpackVoxel(p), material: block.materials[i]! }));
  }
  const s = block.size;
  const n = BLOCK_SIZE / s;
  const out: BlockVoxel[] = [];
  for (let y = 0; y < n; y++) {
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const material = block.kind === 'uniform' ? block.material : block.materials[gridCellIndex(n, x, y, z)]!;
        if (material !== 0) out.push({ x: x * s, y: y * s, z: z * s, size: s, material });
      }
    }
  }
  return out;
}

/** The most compact block for a list of voxels (assumed valid and non-overlapping). */
export function blockFromVoxels(voxels: BlockVoxel[]): Block {
  if (voxels.length === 0) return null;
  const only = voxels[0]!;
  if (voxels.length === 1 && only.size === BLOCK_SIZE) return { kind: 'uniform', size: BLOCK_SIZE, material: only.material };
  const block: Block = {
    kind: 'voxels',
    packed: Uint16Array.from(voxels, (v) => packVoxel(v.x, v.y, v.z, v.size)),
    materials: Uint16Array.from(voxels, (v) => v.material),
  };
  rasterizeVoxels(block); // validates: in-block, non-overlapping, non-air
  return block;
}

/**
 * Applies an edit to the chunk containing its target and returns a new chunk.
 * Only the edited block is replaced; other blocks (which may be shared with
 * other chunks) are reused untouched. Throws EditError if the edit is invalid
 * or its target is not in this chunk.
 */
export function applyEdit(chunk: Chunk, edit: Edit): Chunk {
  const x0 = chunk.cx * CHUNK_SIZE, y0 = chunk.cy * CHUNK_SIZE, z0 = chunk.cz * CHUNK_SIZE;
  const lx = edit.x - x0, ly = edit.y - y0, lz = edit.z - z0;
  if (![lx, ly, lz].every((c) => Number.isInteger(c) && c >= 0 && c < CHUNK_SIZE)) {
    throw new EditError(`target ${edit.x},${edit.y},${edit.z} is not in chunk ${chunk.cx},${chunk.cy},${chunk.cz}`);
  }
  const bi = blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE));
  const block = chunk.blocks[bi] ?? null;
  const [bx, by, bz] = [mod(lx, BLOCK_SIZE), mod(ly, BLOCK_SIZE), mod(lz, BLOCK_SIZE)];

  if (edit.op === 'removeBox') {
    const next = removeBoxFromChunk(chunk, edit);
    if (!next) throw new EditError('nothing to remove there');
    return next;
  }

  let voxels: BlockVoxel[];
  switch (edit.op) {
    case 'remove': {
      const target = blockVoxelContaining(block, bx, by, bz);
      if (!target) throw new EditError('nothing to remove there');
      voxels = blockVoxels(block).filter((v) => !(v.x === target.x && v.y === target.y && v.z === target.z));
      break;
    }
    case 'break': {
      const target = blockVoxelContaining(block, bx, by, bz);
      if (!target) throw new EditError('nothing to break there');
      if (!breakSizesFor(target.size).includes(edit.pieceSize)) {
        throw new EditError(`a ${target.size}/16 m voxel cannot be broken into ${edit.pieceSize}/16 m pieces`);
      }
      const n = target.size / edit.pieceSize;
      voxels = blockVoxels(block).filter((v) => !(v.x === target.x && v.y === target.y && v.z === target.z));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          for (let k = 0; k < n; k++) {
            voxels.push({
              x: target.x + i * edit.pieceSize,
              y: target.y + j * edit.pieceSize,
              z: target.z + k * edit.pieceSize,
              size: edit.pieceSize,
              material: target.material,
            });
          }
        }
      }
      break;
    }
    case 'place': {
      if (!isValidVoxelSize(edit.size)) throw new EditError(`invalid voxel size ${edit.size}`);
      if (!Number.isInteger(edit.material) || edit.material < 1 || edit.material > 0xffff) {
        throw new EditError(`invalid material ${edit.material}`);
      }
      if (!voxelFitsInBlock(edit.x, edit.y, edit.z, edit.size)) {
        throw new EditError('a voxel cannot cross a 1 m gridline');
      }
      const existing = blockVoxels(block);
      const s = edit.size;
      const overlaps = (v: BlockVoxel) =>
        v.x < bx + s && bx < v.x + v.size && v.y < by + s && by < v.y + v.size && v.z < bz + s && bz < v.z + v.size;
      if (existing.some(overlaps)) throw new EditError('that space is occupied');
      voxels = [...existing, { x: bx, y: by, z: bz, size: s, material: edit.material }];
      break;
    }
  }
  const blocks = chunk.blocks.slice();
  blocks[bi] = blockFromVoxels(voxels);
  return { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, blocks };
}

/** A cube in world units. */
export interface Cube {
  x: number;
  y: number;
  z: number;
  size: number;
}

const pow2Floor = (n: number) => 2 ** Math.floor(Math.log2(n));

/**
 * Splits a cube into voxels that each lie inside one 1 m block and together
 * fill exactly the same space. A cube that already fits in one block is
 * returned whole. Otherwise each block's part (a box) is tiled greedily with
 * the largest power-of-two cubes that fit, so pieces use the standard sizes.
 */
export function splitPlacement(cube: Cube): Cube[] {
  if (voxelFitsInBlock(cube.x, cube.y, cube.z, cube.size)) return [cube];
  const out: Cube[] = [];
  const tile = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    if (w <= 0 || h <= 0 || d <= 0) return;
    const c = pow2Floor(Math.min(w, h, d));
    const nx = Math.floor(w / c), ny = Math.floor(h / c), nz = Math.floor(d / c);
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        for (let i = 0; i < nx; i++) out.push({ x: x + i * c, y: y + j * c, z: z + k * c, size: c });
      }
    }
    // What's left: a slab beyond the tiled X extent, then beyond Y, then beyond Z.
    tile(x + nx * c, y, z, w - nx * c, h, d);
    tile(x, y + ny * c, z, nx * c, h - ny * c, d);
    tile(x, y, z + nz * c, nx * c, ny * c, d - nz * c);
  };
  const lo = (v: number) => Math.floor(v / BLOCK_SIZE) * BLOCK_SIZE;
  for (let by = lo(cube.y); by < cube.y + cube.size; by += BLOCK_SIZE) {
    for (let bz = lo(cube.z); bz < cube.z + cube.size; bz += BLOCK_SIZE) {
      for (let bx = lo(cube.x); bx < cube.x + cube.size; bx += BLOCK_SIZE) {
        // This block's part of the cube.
        const x0 = Math.max(bx, cube.x), y0 = Math.max(by, cube.y), z0 = Math.max(bz, cube.z);
        const x1 = Math.min(bx + BLOCK_SIZE, cube.x + cube.size);
        const y1 = Math.min(by + BLOCK_SIZE, cube.y + cube.size);
        const z1 = Math.min(bz + BLOCK_SIZE, cube.z + cube.size);
        tile(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
      }
    }
  }
  return out;
}

/** Throws EditError unless `box` is a valid removeBox cube. */
export function validateRemoveBox(box: RemoveBoxEdit): void {
  if (!isValidVoxelSize(box.size)) throw new EditError(`invalid box size ${box.size}`);
}

/** Chunks overlapped by a removeBox cube. */
export function removeBoxChunks(box: RemoveBoxEdit): { cx: number; cy: number; cz: number }[] {
  const lo = [box.x, box.y, box.z].map((v) => Math.floor(v / CHUNK_SIZE));
  const hi = [box.x, box.y, box.z].map((v) => Math.floor((v + box.size - 1) / CHUNK_SIZE));
  const out: { cx: number; cy: number; cz: number }[] = [];
  for (let cy = lo[1]!; cy <= hi[1]!; cy++) {
    for (let cz = lo[2]!; cz <= hi[2]!; cz++) {
      for (let cx = lo[0]!; cx <= hi[0]!; cx++) out.push({ cx, cy, cz });
    }
  }
  return out;
}

/**
 * Removes from one chunk every voxel with any part inside the box. Returns
 * the new chunk, or null if nothing in this chunk was touched.
 */
export function removeBoxFromChunk(chunk: Chunk, box: RemoveBoxEdit): Chunk | null {
  validateRemoveBox(box);
  const x0 = chunk.cx * CHUNK_SIZE, y0 = chunk.cy * CHUNK_SIZE, z0 = chunk.cz * CHUNK_SIZE;
  // The box in chunk-local units, clipped to the chunk.
  const lo = [box.x - x0, box.y - y0, box.z - z0].map((v) => Math.max(0, v));
  const hi = [box.x - x0, box.y - y0, box.z - z0].map((v) => Math.min(CHUNK_SIZE, v + box.size));
  if (lo.some((v, a) => v >= hi[a]!)) return null;
  let blocks: Chunk['blocks'] | null = null;
  for (let by = Math.floor(lo[1]! / BLOCK_SIZE); by * BLOCK_SIZE < hi[1]!; by++) {
    for (let bz = Math.floor(lo[2]! / BLOCK_SIZE); bz * BLOCK_SIZE < hi[2]!; bz++) {
      for (let bx = Math.floor(lo[0]! / BLOCK_SIZE); bx * BLOCK_SIZE < hi[0]!; bx++) {
        const bi = blockIndex(bx, by, bz);
        const block = chunk.blocks[bi] ?? null;
        if (!block) continue;
        const origin = [bx * BLOCK_SIZE, by * BLOCK_SIZE, bz * BLOCK_SIZE];
        const inBox = (v: BlockVoxel) =>
          [v.x, v.y, v.z].every((c, a) => origin[a]! + c < hi[a]! && lo[a]! < origin[a]! + c + v.size);
        const all = blockVoxels(block);
        const kept = all.filter((v) => !inBox(v));
        if (kept.length === all.length) continue;
        blocks ??= chunk.blocks.slice();
        blocks[bi] = blockFromVoxels(kept);
      }
    }
  }
  return blocks ? { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, blocks } : null;
}

/** The chunk containing the unit cell an edit targets. */
export function editChunk(edit: Edit): { cx: number; cy: number; cz: number } {
  return {
    cx: Math.floor(edit.x / CHUNK_SIZE),
    cy: Math.floor(edit.y / CHUNK_SIZE),
    cz: Math.floor(edit.z / CHUNK_SIZE),
  };
}
