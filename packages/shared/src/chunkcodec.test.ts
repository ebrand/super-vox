import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_CHUNK, GRID_SIZES, emptyChunk, type Block, type Chunk } from './chunk.js';
import { ChunkDecodeError, decodeChunk, encodeChunk, readChunkHeader } from './chunkcodec.js';
import { FlatGenerator, defaultFlatGen } from './flatgen.js';
import { FLAT_WORLD_16KM } from './world.js';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomChunk(seed: number): Chunk {
  const rand = rng(seed);
  const chunk = emptyChunk({ cx: -7, cy: 3, cz: 2 ** 31 - 1 });
  for (let i = 0; i < BLOCKS_PER_CHUNK; i++) {
    const roll = rand();
    let block: Block = null;
    const size = GRID_SIZES[Math.floor(rand() * GRID_SIZES.length)]!;
    if (roll < 0.3) {
      block = { kind: 'uniform', size, material: 1 + Math.floor(rand() * 0xfffe) };
    } else if (roll < 0.5) {
      const n = 16 / size;
      const materials = new Uint16Array(n ** 3);
      for (let c = 0; c < materials.length; c++) materials[c] = Math.floor(rand() * 0x10000);
      block = { kind: 'grid', size, materials };
    }
    chunk.blocks[i] = block;
  }
  return chunk;
}

describe('chunk codec', () => {
  it('round-trips generated chunks at every resolution', () => {
    for (const r of GRID_SIZES) {
      const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(r));
      for (const cy of [-64, -2, -1, 0, 5]) {
        const chunk = gen.generateChunk({ cx: 999, cy, cz: 0 });
        expect(decodeChunk(encodeChunk(chunk))).toEqual(chunk);
      }
    }
  });

  it('round-trips random chunks with unshared blocks', () => {
    for (const seed of [1, 2, 3]) {
      const chunk = randomChunk(seed);
      expect(decodeChunk(encodeChunk(chunk))).toEqual(chunk);
    }
  });

  it('keeps flat-world chunks small', () => {
    // The full-resolution surface chunk is the worst case for a flat world.
    const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(1));
    const surface = encodeChunk(gen.generateChunk({ cx: 0, cy: -1, cz: 0 }));
    expect(surface.byteLength).toBeLessThan(40_000);
    expect(encodeChunk(gen.generateChunk({ cx: 0, cy: 0, cz: 0 })).byteLength).toBeLessThan(32);
    expect(encodeChunk(gen.generateChunk({ cx: 0, cy: -9, cz: 0 })).byteLength).toBeLessThan(32);
  });

  it('rejects every truncation of a valid chunk', () => {
    const bytes = encodeChunk(randomChunk(9));
    for (let len = 0; len < bytes.byteLength; len += Math.max(1, Math.floor(bytes.byteLength / 500))) {
      expect(() => decodeChunk(bytes.subarray(0, len))).toThrow(ChunkDecodeError);
    }
    expect(() => decodeChunk(bytes.subarray(0, bytes.byteLength - 1))).toThrow(ChunkDecodeError);
  });

  it('rejects trailing bytes, bad versions, sizes, kinds, and indices', () => {
    const good = encodeChunk(new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16)).generateChunk({ cx: 0, cy: -1, cz: 0 }));
    const mutate = (fn: (b: Uint8Array) => void) => {
      const b = good.slice();
      fn(b);
      return b;
    };
    const withExtra = new Uint8Array(good.byteLength + 1);
    withExtra.set(good);
    expect(() => decodeChunk(withExtra)).toThrow(/trailing/);
    expect(() => decodeChunk(mutate((b) => (b[0] = 99)))).toThrow(/format/);
    // Palette entry 0 starts at offset 15: kind, size.
    expect(() => decodeChunk(mutate((b) => (b[15] = 7)))).toThrow(/kind/);
    expect(() => decodeChunk(mutate((b) => (b[16] = 3)))).toThrow(/size/);
    expect(() => decodeChunk(mutate((b) => { b[17] = 0; b[18] = 0; }))).toThrow(/air/);
  });

  it('rejects runs that do not exactly cover the chunk', () => {
    const encodeRuns = (runs: [number, number][]) => {
      const b = new Uint8Array(1 + 12 + 2 + 2 + runs.length * 4);
      const v = new DataView(b.buffer);
      v.setUint8(0, 1);
      v.setUint16(13, 0, true); // empty palette
      v.setUint16(15, runs.length, true);
      runs.forEach(([len, idx], i) => {
        v.setUint16(17 + i * 4, len, true);
        v.setUint16(19 + i * 4, idx, true);
      });
      return b;
    };
    expect(decodeChunk(encodeRuns([[4096, 0xffff]])).blocks.every((b) => b === null)).toBe(true);
    expect(() => decodeChunk(encodeRuns([[4095, 0xffff]]))).toThrow(/cover/);
    expect(() => decodeChunk(encodeRuns([[4096, 0xffff], [1, 0xffff]]))).toThrow(/exceed/);
    expect(() => decodeChunk(encodeRuns([[0, 0xffff], [4096, 0xffff]]))).toThrow(/zero-length/);
    expect(() => decodeChunk(encodeRuns([[4096, 0]]))).toThrow(/palette index/);
  });

  it('refuses to encode a chunk with the wrong block count', () => {
    expect(() => encodeChunk({ cx: 0, cy: 0, cz: 0, blocks: [] })).toThrow(RangeError);
  });

  it('reads the header without decoding', () => {
    const bytes = encodeChunk(randomChunk(4));
    expect(readChunkHeader(bytes)).toEqual({ cx: -7, cy: 3, cz: 2 ** 31 - 1 });
    expect(() => readChunkHeader(bytes.subarray(0, 12))).toThrow(ChunkDecodeError);
    const bad = bytes.slice();
    bad[0] = 2;
    expect(() => readChunkHeader(bad)).toThrow(/format/);
  });
});
