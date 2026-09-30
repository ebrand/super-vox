import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  CHUNK_SIZE,
  FLAT_WORLD_16KM,
  FlatGenerator,
  GRID_SIZES,
  NoiseHeights,
  TerrainGenerator,
  blockIndex,
  defaultFlatGen,
  defaultNoiseTerrain,
  emptyChunk,
  materialAt,
  packVoxel,
  voxelAt,
  type Block,
  type Chunk,
} from '@super-vox/shared';
import { DIRS, buildBuffers, mergeFaces, visibleFaces, type Neighbors, type Quad } from './mesher.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random non-overlapping voxels of any size 1..16, each inside the block. */
function randomVoxelsBlock(rand: () => number): Block {
  const occ = new Uint8Array(16 ** 3);
  const packed: number[] = [];
  const materials: number[] = [];
  for (let tries = 0; tries < 60; tries++) {
    const size = 1 + Math.floor(rand() * (rand() < 0.5 ? 4 : 16));
    const [x, y, z] = [0, 0, 0].map(() => Math.floor(rand() * (17 - size))) as [number, number, number];
    let free = true;
    for (let a = x; a < x + size && free; a++)
      for (let b = y; b < y + size && free; b++)
        for (let c = z; c < z + size && free; c++) if (occ[a + 16 * (c + 16 * b)]) free = false;
    if (!free) continue;
    for (let a = x; a < x + size; a++)
      for (let b = y; b < y + size; b++) for (let c = z; c < z + size; c++) occ[a + 16 * (c + 16 * b)] = 1;
    packed.push(packVoxel(x, y, z, size));
    materials.push(1 + Math.floor(rand() * 3));
  }
  return { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
}

function randomBlock(rand: () => number): Block {
  if (rand() < 0.3) return randomVoxelsBlock(rand);
  const size = GRID_SIZES[Math.floor(rand() * GRID_SIZES.length)]!;
  if (rand() < 0.35) return { kind: 'uniform', size, material: 1 + Math.floor(rand() * 3) };
  const n = BLOCK_SIZE / size;
  const materials = new Uint16Array(n ** 3);
  for (let i = 0; i < materials.length; i++) materials[i] = rand() < 0.45 ? 0 : 1 + Math.floor(rand() * 3);
  return { kind: 'grid', size, materials };
}

/** Random blocks clustered at a corner and along chunk borders, where the tricky cases live. */
function randomChunk(seed: number): Chunk {
  const rand = rng(seed);
  const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
  const picks = [0, 1, 2, 14, 15];
  for (let i = 0; i < 40; i++) {
    const p = () => picks[Math.floor(rand() * picks.length)]!;
    chunk.blocks[blockIndex(p(), p(), p())] = randomBlock(rand);
  }
  return chunk;
}

/** Neighbors with random blocks on the layer facing the center chunk. */
function randomNeighbors(seed: number): Neighbors {
  const rand = rng(seed);
  return DIRS.map(({ axis, sign }) => {
    if (rand() < 0.15) return null;
    const nb = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    const layer = sign > 0 ? 0 : BLOCKS_PER_AXIS - 1;
    for (let i = 0; i < 256; i++) {
      if (rand() < 0.5) continue;
      const b = [Math.floor(rand() * 16), Math.floor(rand() * 16), Math.floor(rand() * 16)];
      b[axis] = layer;
      nb.blocks[blockIndex(b[0]!, b[1]!, b[2]!)] = randomBlock(rand);
    }
    return nb;
  });
}

function sizeAt(chunk: Chunk, x: number, y: number, z: number): number {
  return voxelAt(chunk, x, y, z)?.size ?? 0;
}

/** Brute force: every exposed unit face, keyed "dir,x,y,z,material,size" by the solid cell it belongs to. */
function oracleFaces(chunk: Chunk, neighbors: Neighbors): Set<string> {
  const solidAt = (p: number[]): boolean => {
    for (let axis = 0; axis < 3; axis++) {
      if (p[axis]! < 0 || p[axis]! >= CHUNK_SIZE) {
        const nb = neighbors[axis * 2 + (p[axis]! < 0 ? 1 : 0)];
        if (!nb) return false;
        const q = [...p];
        q[axis] = (q[axis]! + CHUNK_SIZE) % CHUNK_SIZE;
        return materialAt(nb, q[0]!, q[1]!, q[2]!) !== 0;
      }
    }
    return materialAt(chunk, p[0]!, p[1]!, p[2]!) !== 0;
  };
  const out = new Set<string>();
  for (let by = 0; by < 16; by++)
    for (let bz = 0; bz < 16; bz++)
      for (let bx = 0; bx < 16; bx++) {
        if (!chunk.blocks[blockIndex(bx, by, bz)]) continue;
        for (let y = by * 16; y < by * 16 + 16; y++)
          for (let z = bz * 16; z < bz * 16 + 16; z++)
            for (let x = bx * 16; x < bx * 16 + 16; x++) {
              const m = materialAt(chunk, x, y, z);
              if (m === 0) continue;
              DIRS.forEach(({ axis, sign }, d) => {
                const p = [x, y, z];
                p[axis]! += sign;
                if (!solidAt(p)) out.add(`${d},${x},${y},${z},${m},${sizeAt(chunk, x, y, z)}`);
              });
            }
      }
  return out;
}

const U = [1, 2, 0];
const V = [2, 0, 1];

/** Rasterizes quads into unit faces with the same keys as the oracle; also returns total area. */
function rasterize(quads: Quad[]): { faces: Set<string>; area: number } {
  const faces = new Set<string>();
  let area = 0;
  for (const q of quads) {
    const { axis, sign } = DIRS[q.dir]!;
    area += q.du * q.dv;
    for (let u = q.u; u < q.u + q.du; u++)
      for (let v = q.v; v < q.v + q.dv; v++) {
        const p = [0, 0, 0];
        p[axis] = sign > 0 ? q.plane - 1 : q.plane;
        p[U[axis]!] = u;
        p[V[axis]!] = v;
        faces.add(`${q.dir},${p[0]},${p[1]},${p[2]},${q.material},${q.size}`);
      }
  }
  return { faces, area };
}

function expectSameFaces(actual: Set<string>, expected: Set<string>): void {
  const missing = [...expected].filter((f) => !actual.has(f)).slice(0, 5);
  const extra = [...actual].filter((f) => !expected.has(f)).slice(0, 5);
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  expect(actual.size).toBe(expected.size);
}

const NO_NEIGHBORS: Neighbors = [null, null, null, null, null, null];

describe('visibleFaces', () => {
  it('emits six 1 m faces for a lone uniform block', () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(3, 4, 5)] = { kind: 'uniform', size: 4, material: 2 };
    const faces = visibleFaces(chunk, NO_NEIGHBORS);
    expect(faces).toHaveLength(6);
    for (const f of faces) expect([f.du, f.dv, f.material, f.size]).toEqual([16, 16, 2, 4]);
    expect(faces.find((f) => f.dir === 2)!.plane).toBe(5 * 16);
    expect(faces.find((f) => f.dir === 3)!.plane).toBe(4 * 16);
  });

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`matches the brute-force oracle exactly (random chunk ${seed})`, () => {
      const chunk = randomChunk(seed);
      const neighbors = randomNeighbors(seed * 101);
      const expected = oracleFaces(chunk, neighbors);
      const raw = rasterize(visibleFaces(chunk, neighbors));
      expectSameFaces(raw.faces, expected);
      expect(raw.area).toBe(expected.size); // no overlapping faces
    });
  }
});

describe('visibleFaces with shared block objects', () => {
  for (const seed of [31, 32, 33]) {
    it(`matches the oracle when blocks repeat, exercising the per-block cache (seed ${seed})`, () => {
      const rand = rng(seed);
      const pool = Array.from({ length: 4 }, () => randomBlock(rand));
      const pick = () => (rand() < 0.3 ? null : pool[Math.floor(rand() * pool.length)]!);
      const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
      for (let i = 0; i < chunk.blocks.length; i++) if (rand() < 0.08) chunk.blocks[i] = pick();
      // Dense 4x4x4 cluster so many blocks share identical neighborhoods.
      for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) chunk.blocks[blockIndex(x, y, z)] = pool[0]!;
      const neighbors: Neighbors = DIRS.map(() => {
        const nb = emptyChunk({ cx: 0, cy: 0, cz: 0 });
        for (let i = 0; i < nb.blocks.length; i++) if (rand() < 0.5) nb.blocks[i] = pick();
        return nb;
      });
      const expected = oracleFaces(chunk, neighbors);
      const r = rasterize(visibleFaces(chunk, neighbors));
      expectSameFaces(r.faces, expected);
      expect(r.area).toBe(expected.size);
    });
  }
});

describe('mergeFaces', () => {
  for (const seed of [11, 12, 13]) {
    it(`covers exactly the same faces with no overlap (random chunk ${seed})`, () => {
      const chunk = randomChunk(seed);
      const neighbors = randomNeighbors(seed);
      const raw = visibleFaces(chunk, neighbors);
      const merged = mergeFaces(raw);
      const r = rasterize(merged);
      expectSameFaces(r.faces, rasterize(raw).faces);
      expect(r.area).toBe(r.faces.size);
      expect(merged.length).toBeLessThanOrEqual(raw.length);
    });
  }

  it('does not merge faces of different voxel sizes or materials', () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: 1 };
    chunk.blocks[blockIndex(1, 0, 0)] = { kind: 'uniform', size: 8, material: 1 };
    chunk.blocks[blockIndex(2, 0, 0)] = { kind: 'uniform', size: 8, material: 2 };
    const top = mergeFaces(visibleFaces(chunk, NO_NEIGHBORS)).filter((q) => q.dir === 2);
    expect(top).toHaveLength(3);
  });

  it('merges two same-kind blocks into one rectangle per side', () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 2, material: 1 };
    chunk.blocks[blockIndex(1, 0, 0)] = { kind: 'uniform', size: 2, material: 1 };
    const merged = mergeFaces(visibleFaces(chunk, NO_NEIGHBORS));
    expect(merged).toHaveLength(6);
    expect(merged.reduce((a, q) => a + q.du * q.dv, 0)).toBe(10 * 256);
  });
});

describe('flat world meshing', () => {
  for (const r of GRID_SIZES) {
    it(`reduces a fully surrounded surface chunk to one grass quad (resolution ${r})`, () => {
      const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(r));
      const at = (cx: number, cy: number, cz: number) => gen.generateChunk({ cx, cy, cz });
      const center = at(10, -1, 10);
      const neighbors = [at(11, -1, 10), at(9, -1, 10), at(10, 0, 10), at(10, -2, 10), at(10, -1, 11), at(10, -1, 9)];
      const quads = mergeFaces(visibleFaces(center, neighbors));
      expect(quads).toEqual([{ dir: 2, plane: 256, u: 0, v: 0, du: 256, dv: 256, material: 3, size: r }]);
    });
  }

  it('produces no faces for buried stone', () => {
    const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16));
    const stone = gen.generateChunk({ cx: 0, cy: -5, cz: 0 });
    expect(visibleFaces(stone, DIRS.map(() => stone))).toHaveLength(0);
  });
});

describe('adaptive terrain meshing', () => {
  const src = new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(3));
  for (const tolerance of [0, 4]) {
    it(`matches the oracle on real terrain chunks (tolerance ${tolerance})`, () => {
      const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance }, src);
      // Find a hilly chunk column near the centre, then mesh its surface chunk.
      let found = false;
      for (let i = 0; i < 400 && !found; i++) {
        const cx = 400 + (i % 20) * 7;
        const cz = 400 + Math.floor(i / 20) * 7;
        const H = src.heights(cx * 256, cz * 256, 256, 256);
        let lo = Infinity, hi = -Infinity;
        for (const h of H) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
        if (hi - lo < 64) continue;
        const at = (x: number, y: number, z: number) => gen.generateChunk({ cx: x, cy: y, cz: z });
        // The chunk layer holding the most mixed-size blocks.
        let cy = Math.floor(lo / 256), best = -1;
        for (let y = Math.floor(lo / 256); y <= Math.floor(hi / 256); y++) {
          const n = at(cx, y, cz).blocks.filter((b) => b?.kind === 'voxels').length;
          if (n > best) [best, cy] = [n, y];
        }
        if (best <= 0) continue;
        found = true;
        const center = at(cx, cy, cz);
        const neighbors = [at(cx + 1, cy, cz), at(cx - 1, cy, cz), at(cx, cy + 1, cz), at(cx, cy - 1, cz), at(cx, cy, cz + 1), at(cx, cy, cz - 1)];
        expect(center.blocks.some((b) => b?.kind === 'voxels')).toBe(true);
        const expected = oracleFaces(center, neighbors);
        const r = rasterize(mergeFaces(visibleFaces(center, neighbors)));
        expectSameFaces(r.faces, expected);
        expect(r.area).toBe(expected.size);
      }
      expect(found).toBe(true);
    }, 60_000); // brute-force oracle over thousands of solid blocks
  }
});

describe('buildBuffers', () => {
  it('winds every triangle counter-clockwise around its normal', () => {
    const chunk = randomChunk(21);
    const quads = mergeFaces(visibleFaces(chunk, NO_NEIGHBORS));
    const buf = buildBuffers(quads, () => [1, 1, 1]);
    expect(buf.indices.length).toBe(quads.length * 6);
    const P = (i: number) => [buf.positions[i * 3]!, buf.positions[i * 3 + 1]!, buf.positions[i * 3 + 2]!];
    for (let t = 0; t < buf.indices.length; t += 3) {
      const [a, b, c] = [P(buf.indices[t]!), P(buf.indices[t + 1]!), P(buf.indices[t + 2]!)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const i = buf.indices[t]! * 3;
      const dot = cross[0]! * buf.normals[i]! + cross[1]! * buf.normals[i + 1]! + cross[2]! * buf.normals[i + 2]!;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('converts units to meters', () => {
    const buf = buildBuffers([{ dir: 2, plane: 32, u: 0, v: 0, du: 16, dv: 8, material: 1, size: 1 }], () => [0, 0, 0]);
    const ys = new Set<number>();
    for (let i = 1; i < buf.positions.length; i += 3) ys.add(buf.positions[i]!);
    expect([...ys]).toEqual([2]);
    expect(Math.max(...buf.positions)).toBe(2);
  });
});
