import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_CHUNK, GRID_SIZES, emptyChunk, packVoxel, type Block, type Chunk, type VoxelsBlock } from './chunk.js';
import { ChunkDecodeError, decodeChunk, encodeChunk, readChunkHeader, summarizeChunk } from './chunkcodec.js';
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
    } else if (roll < 0.4) {
      // A few non-overlapping voxels stacked along X, any sizes that fit.
      const packed: number[] = [];
      const materials: number[] = [];
      let x = 0;
      while (x < 16) {
        const size = 1 + Math.floor(rand() * (16 - x));
        packed.push(packVoxel(x, Math.floor(rand() * (17 - size)), Math.floor(rand() * (17 - size)), size));
        materials.push(1 + Math.floor(rand() * 0xfffe));
        x += size;
      }
      block = { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
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

  describe('voxels blocks', () => {
    const one = (packed: number[], materials: number[]): Chunk => {
      const chunk = emptyChunk({ cx: 1, cy: 2, cz: 3 });
      chunk.blocks[5] = { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
      return chunk;
    };

    it('round-trips, including a block of 4096 unit voxels', () => {
      const full: number[] = [];
      for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) full.push(packVoxel(x, y, z, 1));
      for (const chunk of [one([packVoxel(0, 0, 0, 16)], [9]), one([packVoxel(3, 4, 5, 3), packVoxel(0, 0, 0, 3)], [1, 2]), one(full, full.map((_, i) => 1 + (i % 7)))]) {
        expect(decodeChunk(encodeChunk(chunk))).toEqual(chunk);
      }
    });

    /** Encodes without validation by building a valid chunk, then patching bytes. */
    const tamper = (voxels: [number, number][]) => {
      const bytes = encodeChunk(one(voxels.map(() => packVoxel(0, 0, 0, 1)).map((_, i) => packVoxel(i, 0, 0, 1)), voxels.map(() => 1)));
      const v = new DataView(bytes.buffer);
      // Palette entry 0 at offset 15: kind, pad, u16 count, then (packed, material) pairs.
      voxels.forEach(([p, m], i) => {
        v.setUint16(19 + i * 4, p, true);
        v.setUint16(21 + i * 4, m, true);
      });
      return bytes;
    };

    it('rejects overlapping, out-of-block, and air voxels', () => {
      expect(() => decodeChunk(tamper([[packVoxel(0, 0, 0, 4), 1], [packVoxel(3, 3, 3, 2), 1]]))).toThrow(/overlap/);
      expect(() => decodeChunk(tamper([[packVoxel(14, 0, 0, 4), 1]]))).toThrow(/boundary/);
      expect(() => decodeChunk(tamper([[packVoxel(0, 0, 0, 4), 0]]))).toThrow(/air/);
      expect(decodeChunk(tamper([[packVoxel(12, 0, 0, 4), 1]])).blocks[5]).toBeTruthy();
    });

    it('refuses to encode an empty voxels block', () => {
      expect(() => encodeChunk(one([], []))).toThrow(RangeError);
    });

    it('decodes voxels blocks as independent, valid objects', () => {
      const chunk = one([packVoxel(0, 0, 0, 8)], [4]);
      const block = decodeChunk(encodeChunk(chunk)).blocks[5] as VoxelsBlock;
      expect(block.kind).toBe('voxels');
      expect(block).not.toBe(chunk.blocks[5]);
    });
  });

  it('summarizes chunks without decoding them', () => {
    const flat = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16));
    expect(summarizeChunk(encodeChunk(flat.generateChunk({ cx: 0, cy: 3, cz: 0 })))).toBe('air');
    expect(summarizeChunk(encodeChunk(flat.generateChunk({ cx: 0, cy: -9, cz: 0 })))).toBe('solid');
    // The default surface (y = 0) sits exactly on a chunk's top edge, so that chunk is solid.
    expect(summarizeChunk(encodeChunk(flat.generateChunk({ cx: 0, cy: -1, cz: 0 })))).toBe('solid');
    // A surface inside the chunk: uniform blocks below, air above.
    const raised = new FlatGenerator(FLAT_WORLD_16KM, { ...defaultFlatGen(16), surfaceY: 32 });
    expect(summarizeChunk(encodeChunk(raised.generateChunk({ cx: 0, cy: 0, cz: 0 })))).toBe('mixed');
    // Several uniform materials still count as solid.
    const two = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    two.blocks.fill({ kind: 'uniform', size: 16, material: 1 });
    two.blocks[7] = { kind: 'uniform', size: 4, material: 2 };
    expect(summarizeChunk(encodeChunk(two))).toBe('solid');
    // Grid and voxels blocks may contain air.
    const fine = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(1));
    expect(summarizeChunk(encodeChunk(fine.generateChunk({ cx: 0, cy: -1, cz: 0 })))).toBe('mixed');
    for (const seed of [1, 2, 3]) expect(summarizeChunk(encodeChunk(randomChunk(seed)))).toBe('mixed');
  });

  it('agrees with a full decode on every summary', () => {
    const flat = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(2));
    for (let cy = -3; cy <= 1; cy++) {
      const bytes = encodeChunk(flat.generateChunk({ cx: 0, cy, cz: 0 }));
      const blocks = decodeChunk(bytes).blocks;
      const expected = blocks.every((b) => b === null) ? 'air' : blocks.every((b) => b?.kind === 'uniform') ? 'solid' : 'mixed';
      expect(summarizeChunk(bytes)).toBe(expected);
    }
  });
});

describe('chunkOpacity', () => {
  it('marks whole blocks of rock, not air, water, leaves or partial blocks', async () => {
    const { chunkOpacity, blocksLight } = await import('./chunkcodec.js');
    const { Material } = await import('./materials.js');
    const { blockIndex } = await import('./chunk.js');
    const { setBlockWater } = await import('./water.js');
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    expect(chunkOpacity(encodeChunk(chunk))).toBeNull();
    const stone: Block = { kind: 'uniform', size: 16, material: Material.Stone };
    chunk.blocks[blockIndex(1, 2, 3)] = stone;
    chunk.blocks[blockIndex(15, 15, 15)] = stone;
    chunk.blocks[blockIndex(4, 4, 4)] = { kind: 'uniform', size: 16, material: Material.Leaves };
    chunk.blocks[blockIndex(5, 4, 4)] = setBlockWater(null, 0);
    chunk.blocks[blockIndex(6, 4, 4)] = { kind: 'voxels', packed: Uint16Array.of(packVoxel(0, 0, 0, 8)), materials: Uint16Array.of(Material.Stone) };
    const o = chunkOpacity(encodeChunk(chunk))!;
    expect([...o.keys()].filter((i) => o[i])).toEqual([blockIndex(1, 2, 3), blockIndex(15, 15, 15)]);
    // Leaves and water only: nothing stops light.
    chunk.blocks[blockIndex(1, 2, 3)] = null;
    chunk.blocks[blockIndex(15, 15, 15)] = null;
    expect(chunkOpacity(encodeChunk(chunk))).toBeNull();
    expect(blocksLight(Material.Stone)).toBe(true);
    expect(blocksLight(Material.Water)).toBe(false);
    expect(blocksLight(Material.Needles)).toBe(false);
  });
});
