import {
  BLOCK_SIZE,
  BLOCKS_PER_CHUNK,
  isGridSize,
  rasterizeVoxels,
  type Block,
  type Chunk,
  type VoxelsBlock,
} from './chunk.js';
import { isWater } from './materials.js';
import type { ChunkCoord } from './world.js';

/**
 * Binary chunk format (little-endian):
 *
 *   u8  format version (1)
 *   i32 cx, i32 cy, i32 cz
 *   u16 palette length, then per entry:
 *         u8 kind (1 = uniform, 2 = grid, 3 = voxels), then
 *         uniform: u8 voxel size, u16 material
 *         grid:    u8 voxel size, (16/size)^3 x u16 materials
 *         voxels:  u8 unused (0), u16 count (1..4096), count x (u16 packed, u16 material)
 *   u16 run count, then per run: u16 length, u16 palette index (0xffff = empty)
 *
 * Runs cover the chunk's blocks in blockIndex() order. Palette entries are
 * deduplicated by object identity, so shared generator blocks encode once.
 */
export const CHUNK_FORMAT_VERSION = 1;

const KIND_UNIFORM = 1;
const KIND_GRID = 2;
const KIND_VOXELS = 3;
const MAX_BLOCK_VOXELS = BLOCK_SIZE ** 3;
const EMPTY_INDEX = 0xffff;

export class ChunkDecodeError extends Error {}

export function encodeChunk(chunk: Chunk): Uint8Array {
  if (chunk.blocks.length !== BLOCKS_PER_CHUNK) {
    throw new RangeError(`chunk has ${chunk.blocks.length} blocks, expected ${BLOCKS_PER_CHUNK}`);
  }
  const palette: Exclude<Block, null>[] = [];
  const paletteIndex = new Map<Block, number>();
  const runs: [number, number][] = [];
  for (const block of chunk.blocks) {
    let idx = EMPTY_INDEX;
    if (block) {
      let found = paletteIndex.get(block);
      if (found === undefined) {
        found = palette.length;
        if (found >= EMPTY_INDEX) throw new RangeError('chunk palette overflow');
        palette.push(block);
        paletteIndex.set(block, found);
      }
      idx = found;
    }
    const last = runs[runs.length - 1];
    if (last && last[1] === idx) last[0]++;
    else runs.push([1, idx]);
  }

  let size = 1 + 12 + 2 + 2 + runs.length * 4;
  for (const b of palette) {
    size += 2 + (b.kind === 'uniform' ? 2 : b.kind === 'grid' ? b.materials.length * 2 : 2 + b.packed.length * 4);
  }

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint8(o, CHUNK_FORMAT_VERSION); o += 1;
  view.setInt32(o, chunk.cx, true); o += 4;
  view.setInt32(o, chunk.cy, true); o += 4;
  view.setInt32(o, chunk.cz, true); o += 4;
  view.setUint16(o, palette.length, true); o += 2;
  for (const b of palette) {
    if (b.kind === 'voxels') {
      const n = b.packed.length;
      if (n === 0 || n > MAX_BLOCK_VOXELS) throw new RangeError(`voxels block with ${n} voxels`);
      view.setUint8(o, KIND_VOXELS); o += 1;
      view.setUint8(o, 0); o += 1;
      view.setUint16(o, n === MAX_BLOCK_VOXELS ? 0 : n, true); o += 2;
      for (let i = 0; i < n; i++) {
        view.setUint16(o, b.packed[i]!, true); o += 2;
        view.setUint16(o, b.materials[i]!, true); o += 2;
      }
      continue;
    }
    view.setUint8(o, b.kind === 'uniform' ? KIND_UNIFORM : KIND_GRID); o += 1;
    view.setUint8(o, b.size); o += 1;
    if (b.kind === 'uniform') {
      view.setUint16(o, b.material, true); o += 2;
    } else {
      for (const m of b.materials) { view.setUint16(o, m, true); o += 2; }
    }
  }
  view.setUint16(o, runs.length, true); o += 2;
  for (const [len, idx] of runs) {
    view.setUint16(o, len, true); o += 2;
    view.setUint16(o, idx, true); o += 2;
  }
  return buf;
}

/**
 * Classifies an encoded chunk without decoding its voxels: 'air' if every
 * block is empty, 'solid' if every block is a uniform (completely filled)
 * block, otherwise 'mixed'. Used to skip meshing chunks that cannot have
 * visible faces.
 */
export function summarizeChunk(bytes: Uint8Array): 'air' | 'solid' | 'mixed' {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 15) throw new ChunkDecodeError('truncated chunk data');
  let o = 13;
  const paletteLen = view.getUint16(o, true); o += 2;
  let allUniform = true;
  for (let i = 0; i < paletteLen; i++) {
    if (o + 2 > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
    const kind = view.getUint8(o);
    const size = view.getUint8(o + 1);
    o += 2;
    if (kind === KIND_UNIFORM) {
      // Water doesn't hide what's next to it.
      if (o + 2 > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
      if (isWater(view.getUint16(o, true))) allUniform = false;
      o += 2;
    }
    else if (kind === KIND_GRID) {
      if (!isGridSize(size)) throw new ChunkDecodeError(`invalid voxel size ${size}`);
      o += (BLOCK_SIZE / size) ** 3 * 2;
      allUniform = false;
    } else if (kind === KIND_VOXELS) {
      if (o + 2 > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
      o += 2 + (view.getUint16(o, true) || MAX_BLOCK_VOXELS) * 4;
      allUniform = false;
    } else throw new ChunkDecodeError(`unknown block kind ${kind}`);
  }
  if (paletteLen === 0) return 'air';
  if (!allUniform) return 'mixed';
  if (o + 2 > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
  const runCount = view.getUint16(o, true); o += 2;
  for (let r = 0; r < runCount; r++) {
    if (o + 4 > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
    if (view.getUint16(o + 2, true) === EMPTY_INDEX) return 'mixed';
    o += 4;
  }
  return 'solid';
}

/** Reads just the coordinates from an encoded chunk without decoding it. */
export function readChunkHeader(bytes: Uint8Array): ChunkCoord {
  if (bytes.byteLength < 13) throw new ChunkDecodeError('truncated chunk data');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== CHUNK_FORMAT_VERSION) throw new ChunkDecodeError(`unsupported chunk format ${version}`);
  return { cx: view.getInt32(1, true), cy: view.getInt32(5, true), cz: view.getInt32(9, true) };
}

export function decodeChunk(bytes: Uint8Array): Chunk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number) => {
    if (o + n > bytes.byteLength) throw new ChunkDecodeError('truncated chunk data');
  };

  need(13);
  const version = view.getUint8(o); o += 1;
  if (version !== CHUNK_FORMAT_VERSION) throw new ChunkDecodeError(`unsupported chunk format ${version}`);
  const cx = view.getInt32(o, true); o += 4;
  const cy = view.getInt32(o, true); o += 4;
  const cz = view.getInt32(o, true); o += 4;

  need(2);
  const paletteLen = view.getUint16(o, true); o += 2;
  const palette: Exclude<Block, null>[] = [];
  for (let i = 0; i < paletteLen; i++) {
    need(2);
    const kind = view.getUint8(o); o += 1;
    const size = view.getUint8(o); o += 1;
    if (kind === KIND_VOXELS) {
      need(2);
      const n = view.getUint16(o, true) || MAX_BLOCK_VOXELS; o += 2;
      need(n * 4);
      const packed = new Uint16Array(n);
      const materials = new Uint16Array(n);
      for (let v = 0; v < n; v++) {
        packed[v] = view.getUint16(o, true); o += 2;
        materials[v] = view.getUint16(o, true); o += 2;
      }
      const block: VoxelsBlock = { kind: 'voxels', packed, materials };
      try {
        rasterizeVoxels(block);
      } catch (err) {
        throw new ChunkDecodeError(String((err as Error).message));
      }
      palette.push(block);
      continue;
    }
    if (!isGridSize(size)) throw new ChunkDecodeError(`invalid voxel size ${size}`);
    if (kind === KIND_UNIFORM) {
      need(2);
      const material = view.getUint16(o, true); o += 2;
      if (material === 0) throw new ChunkDecodeError('uniform block with air material');
      palette.push({ kind: 'uniform', size, material });
    } else if (kind === KIND_GRID) {
      const cells = (BLOCK_SIZE / size) ** 3;
      need(cells * 2);
      const materials = new Uint16Array(cells);
      for (let c = 0; c < cells; c++) { materials[c] = view.getUint16(o, true); o += 2; }
      palette.push({ kind: 'grid', size, materials });
    } else {
      throw new ChunkDecodeError(`unknown block kind ${kind}`);
    }
  }

  need(2);
  const runCount = view.getUint16(o, true); o += 2;
  const blocks: Block[] = [];
  for (let r = 0; r < runCount; r++) {
    need(4);
    const len = view.getUint16(o, true); o += 2;
    const idx = view.getUint16(o, true); o += 2;
    if (len === 0) throw new ChunkDecodeError('zero-length run');
    if (blocks.length + len > BLOCKS_PER_CHUNK) throw new ChunkDecodeError('runs exceed chunk size');
    let block: Block = null;
    if (idx !== EMPTY_INDEX) {
      const entry = palette[idx];
      if (!entry) throw new ChunkDecodeError(`palette index ${idx} out of range`);
      block = entry;
    }
    for (let i = 0; i < len; i++) blocks.push(block);
  }
  if (blocks.length !== BLOCKS_PER_CHUNK) throw new ChunkDecodeError('runs do not cover the chunk');
  if (o !== bytes.byteLength) throw new ChunkDecodeError('trailing bytes after chunk data');
  return { cx, cy, cz, blocks };
}
