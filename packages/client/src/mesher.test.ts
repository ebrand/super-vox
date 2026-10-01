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
  Material,
  chunkWithoutWater,
  setBlockWater,
  type Block,
  type Chunk,
} from '@super-vox/shared';
import { DIRS, MAX_MESH_MATERIAL, QUAD_INDEX_PATTERN, mergeFaces, packQuads, quadIndices, visibleFaces, waterQuads, type Neighbors, type Quad } from './mesher.js';

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

describe('ambient occlusion', () => {
  /** A 3 x 3 floor of 1 m blocks at by = 0, plus solid blocks at `walls` on top. */
  const scene = (walls: [number, number, number][]) => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    for (let bz = 0; bz < 3; bz++) for (let bx = 0; bx < 3; bx++) chunk.blocks[blockIndex(bx, 0, bz)] = { kind: 'uniform', size: 16, material: 1 };
    for (const [x, y, z] of walls) chunk.blocks[blockIndex(x, y, z)] = { kind: 'uniform', size: 16, material: 2 };
    return visibleFaces(chunk, NO_NEIGHBORS);
  };
  /** Occlusion at world corner (x, z) of the floor's top face over block (bx, bz). */
  const floorAo = (faces: Quad[], bx: number, bz: number, x: number, z: number) => {
    const q = faces.find((f) => f.dir === 2 && f.plane === 16 && f.u <= bz * 16 && f.u + f.du >= bz * 16 + 16 && f.v <= bx * 16 && f.v + f.dv >= bx * 16 + 16)!;
    // Top faces: U is Z, V is X.
    const cu = z === q.u ? 0 : 1, cv = x === q.v ? 0 : 1;
    return (q.ao ?? [0, 0, 0, 0])[cv ? 3 - cu : cu]!;
  };

  it('leaves open faces unshaded', () => {
    const faces = scene([]);
    expect(faces.filter((f) => f.dir === 2).every((f) => !f.ao)).toBe(true);
    expect(faces.filter((f) => f.dir === 2).reduce((a, f) => a + f.du * f.dv, 0)).toBe(9 * 256);
  });

  it('darkens ground along the foot of a wall, the wall along its foot, and the corner diagonal to it', () => {
    const faces = scene([[1, 1, 1]]);
    // West of the wall: the corners at the wall (x = 16) are shaded, the far ones aren't.
    expect([floorAo(faces, 0, 1, 16, 16), floorAo(faces, 0, 1, 16, 32)]).toEqual([1, 1]);
    expect([floorAo(faces, 0, 1, 0, 16), floorAo(faces, 0, 1, 0, 32)]).toEqual([0, 0]);
    // The floor block diagonal to the wall: only its corner touching the wall's corner.
    expect(floorAo(faces, 0, 0, 16, 16)).toBe(1);
    expect(floorAo(faces, 0, 0, 0, 0) + floorAo(faces, 0, 0, 16, 0) + floorAo(faces, 0, 0, 0, 16)).toBe(0);
    // The wall's west face: bottom corners shaded by the floor (beside and diagonal: 2), top
    // corners open.
    const west = faces.find((f) => f.dir === 1 && f.plane === 16)!;
    // -X faces: U is Y, V is Z; corners (y, z): (16, 16), (32, 16), (32, 32), (16, 32).
    expect(west.ao).toEqual([2, 0, 0, 2]);
  });

  it('merges shaded faces into strips along the edge that shades them', () => {
    // A 1/4 m grid block: a full floor layer, and a ridge one cell high along X at z = 0.
    const n = 4, materials = new Uint16Array(n ** 3);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) materials[x + n * z] = 1;
    for (let x = 0; x < n; x++) materials[x + n * (0 + n * 1)] = 1;
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[0] = { kind: 'grid', size: 4, materials };
    const faces = visibleFaces(chunk, NO_NEIGHBORS);
    // The floor's top beside the ridge (z in [4, 8)), shaded on its ridge side: one strip along X
    // where the ridge is beside and diagonal to every corner (2), and an end cell either side
    // where the ridge ends (1 at the outer corner).
    const strip = faces.filter((f) => f.dir === 2 && f.plane === 4 && f.u === 4).sort((p, q) => p.v - q.v);
    // Top faces: U is Z, V is X; corners (z, x): (4, x0), (8, x0), (8, x1), (4, x1).
    expect(strip.map((f) => [f.v, f.dv, f.du, f.ao])).toEqual([
      [0, 4, 4, [1, 0, 0, 2]],
      [4, 8, 4, [2, 0, 0, 2]],
      [12, 4, 4, [2, 0, 0, 1]],
    ]);
  });

  it('merges strips the other way for a ridge along Z', () => {
    const n = 4, materials = new Uint16Array(n ** 3);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) materials[x + n * z] = 1;
    for (let z = 0; z < n; z++) materials[0 + n * (z + n * 1)] = 1;
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[0] = { kind: 'grid', size: 4, materials };
    const strip = visibleFaces(chunk, NO_NEIGHBORS).filter((f) => f.dir === 2 && f.plane === 4 && f.v === 4).sort((p, q) => p.u - q.u);
    expect(strip.map((f) => [f.u, f.du, f.dv, f.ao])).toEqual([
      [0, 4, 4, [1, 2, 0, 0]],
      [4, 8, 4, [2, 2, 0, 0]],
      [12, 4, 4, [2, 1, 0, 0]],
    ]);
  });

  it("ignores tiny steps (1/16 and 1/8 m) but shades along taller ones, however thin", () => {
    // A floor of 1/16 m voxels (one layer) with a bump h units high on its middle row.
    const shadedBeside = (h: number) => {
      const packed: number[] = [], materials: number[] = [];
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        packed.push(packVoxel(x, 0, z, 1)); materials.push(1);
        if (z === 8) for (let y = 1; y <= h; y++) { packed.push(packVoxel(x, y, z, 1)); materials.push(1); }
      }
      const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
      chunk.blocks[0] = { kind: 'voxels', packed: Uint16Array.from(packed), materials: Uint16Array.from(materials) };
      // Floor tops (plane 1) right beside the bump.
      return visibleFaces(chunk, NO_NEIGHBORS).filter((f) => f.dir === 2 && f.plane === 1 && (f.u === 7 || f.u + f.du === 8)).some((f) => f.ao);
    };
    expect(shadedBeside(1)).toBe(false);
    expect(shadedBeside(2)).toBe(false);
    expect(shadedBeside(3)).toBe(true);
    expect(shadedBeside(4)).toBe(true);
  });

  it('fully shades an inside corner between two walls', () => {
    const faces = scene([[1, 1, 0], [0, 1, 1]]);
    expect(floorAo(faces, 0, 0, 16, 16)).toBe(3);
  });

  it('reaches into neighbouring chunks across a face, and treats diagonal chunks as open', () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(15, 0, 5)] = { kind: 'uniform', size: 16, material: 1 };
    const east = emptyChunk({ cx: 1, cy: 0, cz: 0 });
    east.blocks[blockIndex(0, 1, 5)] = { kind: 'uniform', size: 16, material: 1 };
    const top = visibleFaces(chunk, [east, null, null, null, null, null]).find((f) => f.dir === 2)!;
    // The corners at x = 256 touch the block on top of the east chunk.
    expect(top.ao).toEqual([0, 0, 1, 1]);
  });
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

describe('voxel grid phase', () => {
  it('gives an offset voxel the phase of its block-local position on each face', () => {
    // A 1/2 m voxel at block-local (4, 3, 5): phases x 4, y 3, z 5.
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(2, 0, 1)] = { kind: 'voxels', packed: Uint16Array.of(packVoxel(4, 3, 5, 8)), materials: Uint16Array.of(1) };
    const quads = visibleFaces(chunk, NO_NEIGHBORS);
    expect(quads).toHaveLength(6);
    for (const q of quads) {
      const axis = DIRS[q.dir]!.axis;
      // Shader order: X faces (y, z), Y faces (x, z), Z faces (x, y).
      const expected = axis === 0 ? [3, 5] : axis === 1 ? [4, 5] : [4, 3];
      expect([q.pa, q.pb]).toEqual(expected);
    }
  });

  it('never merges faces whose voxel grids are out of phase', () => {
    const base = { dir: 2, plane: 16, v: 0, du: 8, dv: 8, material: 1, size: 8 } as const;
    const merged = mergeFaces([
      { ...base, u: 0, pa: 0, pb: 0 },
      { ...base, u: 8, pa: 4, pb: 0 },
    ]);
    expect(merged).toHaveLength(2);
    expect(mergeFaces([{ ...base, u: 0 }, { ...base, u: 8 }])).toHaveLength(1);
  });

  it('keeps aligned voxels at phase 0', () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[0] = { kind: 'voxels', packed: Uint16Array.of(packVoxel(8, 0, 8, 8), packVoxel(0, 12, 4, 4)), materials: Uint16Array.of(1, 2) };
    for (const q of visibleFaces(chunk, NO_NEIGHBORS)) expect([q.pa, q.pb]).toEqual([0, 0]);
  });
});

describe('packQuads', () => {
  const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  it('winds every triangle counter-clockwise around its face direction with the shared index pattern', () => {
    const quads = mergeFaces(visibleFaces(randomChunk(21), NO_NEIGHBORS));
    const buf = packQuads(quads);
    const indices = quadIndices(buf.quadCount);
    expect(buf.quadCount).toBe(quads.length);
    const P = (i: number) => [buf.positions[i * 3]!, buf.positions[i * 3 + 1]!, buf.positions[i * 3 + 2]!];
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [P(indices[t]!), P(indices[t + 1]!), P(indices[t + 2]!)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = NORMALS[buf.faces[indices[t]! * 4]! & 7]!;
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });

  it('round-trips every quad field through the packed buffers', () => {
    const quads = mergeFaces(visibleFaces(randomChunk(22), randomNeighbors(22)));
    quads.push({ dir: 4, plane: 256, u: 0, v: 0, du: 256, dv: 256, material: 0x1234, size: 16, pa: 15, pb: 7 });
    const buf = packQuads(quads);
    const U = [1, 2, 0], V = [2, 0, 1];
    quads.forEach((q, qi) => {
      const axis = DIRS[q.dir]!.axis;
      const vs = [0, 1, 2, 3].map((k) => [buf.positions[(qi * 4 + k) * 3]!, buf.positions[(qi * 4 + k) * 3 + 1]!, buf.positions[(qi * 4 + k) * 3 + 2]!]);
      for (const v of vs) expect(v[axis]).toBe(q.plane);
      const us = vs.map((v) => v[U[axis]!]!), ws = vs.map((v) => v[V[axis]!]!);
      expect([Math.min(...us), Math.max(...us), Math.min(...ws), Math.max(...ws)]).toEqual([q.u, q.u + q.du, q.v, q.v + q.dv]);
      for (let k = 0; k < 4; k++) {
        const f = buf.faces.subarray((qi * 4 + k) * 4, (qi * 4 + k) * 4 + 4);
        expect([f[0]! & 7, (f[0]! >> 3) + 1, f[1]! & 15, f[1]! >> 4, f[2]! | ((f[3]! & 63) << 8)]).toEqual([
          q.dir, q.size, q.pa ?? 0, q.pb ?? 0, q.material,
        ]);
        // The corner's occlusion: Quad.ao is ordered (u, v), (u+du, v), (u+du, v+dv), (u, v+dv).
        const cu = vs[k]![U[axis]!] === q.u ? 0 : 1, cv = vs[k]![V[axis]!] === q.v ? 0 : 1;
        expect(f[3]! >> 6).toBe((q.ao ?? [0, 0, 0, 0])[cv ? 3 - cu : cu]);
      }
    });
    expect(quads.some((q) => q.ao)).toBe(true);
  });

  it('clamps material ids beyond 14 bits (drawn as unknown)', () => {
    const buf = packQuads([{ dir: 2, plane: 16, u: 0, v: 0, du: 16, dv: 16, material: 0xfff0, size: 16, ao: [3, 3, 3, 3] }]);
    expect(buf.faces[2]! | ((buf.faces[3]! & 63) << 8)).toBe(MAX_MESH_MATERIAL);
    expect(buf.faces[3]! >> 6).toBe(3);
  });

  it('splits each quad along the diagonal between its two most occluded corners', () => {
    for (const dir of [2, 3]) {
      for (let dark = 0; dark < 4; dark++) {
        const ao = [0, 0, 0, 0] as [number, number, number, number];
        ao[dark] = 2;
        ao[(dark + 2) % 4] = 1;
        const buf = packQuads([{ dir, plane: 16, u: 0, v: 0, du: 16, dv: 16, material: 1, size: 16, ao }]);
        // The pattern's shared vertices (0 and 2) are both on the diagonal.
        const occ = (k: number) => buf.faces[k * 4 + 3]! >> 6;
        expect([occ(0), occ(2)].sort()).toEqual([1, 2]);
      }
    }
  });

  it('builds a shared index buffer from one repeating pattern', () => {
    const idx = quadIndices(3);
    expect([...idx]).toEqual([...QUAD_INDEX_PATTERN, ...QUAD_INDEX_PATTERN.map((i) => i + 4), ...QUAD_INDEX_PATTERN.map((i) => i + 8)]);
  });
});

describe('water meshing', () => {
  /** A pond: a stone floor (by = 0), water 2 m deep over it (by = 1, 2), a stone block standing in it. */
  const pond = () => {
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    for (let bz = 0; bz < 16; bz++) for (let bx = 0; bx < 16; bx++) {
      chunk.blocks[blockIndex(bx, 0, bz)] = { kind: 'uniform', size: 16, material: Material.Stone };
      for (const by of [1, 2]) chunk.blocks[blockIndex(bx, by, bz)] = setBlockWater(null, 0);
    }
    chunk.blocks[blockIndex(5, 1, 5)] = { kind: 'uniform', size: 16, material: Material.Stone };
    return chunk;
  };

  it('draws only where water meets air: the surface, not the floor or the stone in it', () => {
    const q = waterQuads(pond(), [null, null, null, null, null, null]);
    expect(q.every((f) => f.material === Material.Water && !f.ao)).toBe(true);
    // Only upward faces, all at the surface (y = 3 m), covering the whole pond.
    expect(q.every((f) => f.dir === 2 && f.plane === 3 * 16)).toBe(true);
    expect(q.reduce((a, f) => a + f.du * f.dv, 0)).toBe(256 * 256);
    // Merged into a few big quads.
    expect(q.length).toBeLessThanOrEqual(2);
  });

  it('shows the ground under the water: terrain meshes without it', () => {
    const terrain = mergeFaces(visibleFaces(chunkWithoutWater(pond()), NO_NEIGHBORS));
    // The floor's top is visible under the water, and the stone block's sides.
    expect(terrain.some((f) => f.dir === 2 && f.plane === 16)).toBe(true);
    expect(terrain.some((f) => f.dir === 0 && f.plane === 6 * 16)).toBe(true);
    // With the water in, the floor would have been hidden.
    expect(mergeFaces(visibleFaces(pond(), NO_NEIGHBORS)).some((f) => f.dir === 2 && f.plane === 16 && f.material === Material.Stone)).toBe(false);
  });

  it('shows a wall of water beside a dug hole, but not at the edge of the loaded area', () => {
    const chunk = pond();
    chunk.blocks[blockIndex(10, 2, 10)] = null; // a 1 m hole in the surface layer, beside water
    const q = waterQuads(chunk, NO_NEIGHBORS);
    // Four walls facing into the hole (and the hole's floor is water: a surface 1 m lower).
    expect(q.filter((f) => f.dir !== 2 && f.dir !== 3).length).toBeGreaterThanOrEqual(4);
    expect(q.some((f) => f.dir === 2 && f.plane === 2 * 16)).toBe(true);
    // No walls on the chunk's sides (no neighbours loaded there).
    expect(q.some((f) => (f.dir === 0 && f.plane === 256) || (f.dir === 1 && f.plane === 0))).toBe(false);
  });

  it('draws nothing for chunks without water', () => {
    expect(waterQuads(randomChunk(5), randomNeighbors(5))).toEqual([]);
  });
});
