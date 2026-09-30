import { BLOCK_SIZE, BLOCKS_PER_CHUNK, isGridSize, type Block, type Chunk } from './chunk.js';

/**
 * Binary chunk format (little-endian):
 *
 *   u8  format version (1)
 *   i32 cx, i32 cy, i32 cz
 *   u16 palette length, then per entry:
 *         u8 kind (1 = uniform, 2 = grid), u8 voxel size,
 *         uniform: u16 material | grid: (16/size)^3 x u16 materials
 *   u16 run count, then per run: u16 length, u16 palette index (0xffff = empty)
 *
 * Runs cover the chunk's blocks in blockIndex() order. Palette entries are
 * deduplicated by object identity, so shared generator blocks encode once.
 */
export const CHUNK_FORMAT_VERSION = 1;

const KIND_UNIFORM = 1;
const KIND_GRID = 2;
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
  for (const b of palette) size += 2 + (b.kind === 'uniform' ? 2 : b.materials.length * 2);

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint8(o, CHUNK_FORMAT_VERSION); o += 1;
  view.setInt32(o, chunk.cx, true); o += 4;
  view.setInt32(o, chunk.cy, true); o += 4;
  view.setInt32(o, chunk.cz, true); o += 4;
  view.setUint16(o, palette.length, true); o += 2;
  for (const b of palette) {
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
