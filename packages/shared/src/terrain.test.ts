import { describe, expect, it } from 'vitest';
import { rasterizeVoxels, unpackVoxel, voxelAt, type Chunk, type VoxelsBlock } from './chunk.js';
import { Material } from './materials.js';
import {
  NoiseHeights,
  TerrainGenerator,
  defaultNoiseTerrain,
  validateVoxelize,
  type HeightSource,
} from './terrain.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from './world.js';

/** A height source defined by a function of the unit column. */
function fnSource(f: (x: number, z: number) => number, min: number, max: number): HeightSource {
  return {
    minHeight: min,
    maxHeight: max,
    heights(x0, z0, w, d) {
      const out = new Int32Array(w * d);
      for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) out[i + w * j] = f(x0 + i, z0 + j);
      return out;
    },
  };
}

function voxelBlocks(chunk: Chunk): VoxelsBlock[] {
  return [...new Set(chunk.blocks)].filter((b): b is VoxelsBlock => b?.kind === 'voxels');
}

/** Finds a chunk column with at least `relief` units of height variation. */
function hillyColumn(src: HeightSource, relief: number): { cx: number; cz: number; lo: number; hi: number } {
  for (let i = 0; i < 400; i++) {
    const cx = 400 + (i % 20) * 7;
    const cz = 400 + Math.floor(i / 20) * 7;
    const H = src.heights(cx * CHUNK_SIZE, cz * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    let lo = Infinity, hi = -Infinity;
    for (const h of H) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (hi - lo >= relief) return { cx, cz, lo, hi };
  }
  throw new Error('no hilly column found');
}

describe('NoiseHeights', () => {
  const src = new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(7));

  it('is deterministic and seed-dependent', () => {
    const a = src.heights(123_456, 98_765, 32, 32);
    expect(new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(7)).heights(123_456, 98_765, 32, 32)).toEqual(a);
    expect(new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(8)).heights(123_456, 98_765, 32, 32)).not.toEqual(a);
  });

  it('agrees between one big query and many small ones', () => {
    const big = src.heights(50_000, 60_000, 64, 64);
    for (const [i, j] of [[0, 0], [63, 63], [17, 42], [40, 3]] as const) {
      expect(src.heights(50_000 + i, 60_000 + j, 1, 1)[0]).toBe(big[i + 64 * j]);
    }
  });

  it('samples with a stride exactly like the full-resolution grid (lattice and direct paths)', () => {
    for (const step of [1, 3, 16, 128, 512]) {
      const n = 12;
      const strided = src.heights(40_000, 70_000, n, n, step);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          expect(strided[i + n * j]).toBe(src.heights(40_000 + i * step, 70_000 + j * step, 1, 1)[0]);
        }
      }
    }
  });

  it('stays within its declared bounds and has both plains and hills', () => {
    let plains = 0, hills = 0;
    for (let k = 0; k < 40; k++) {
      const H = src.heights(k * 6_000, k * 5_000, 64, 64);
      for (const h of H) {
        expect(h).toBeGreaterThanOrEqual(src.minHeight);
        expect(h).toBeLessThanOrEqual(src.maxHeight);
        if (h === 0) plains++;
        else hills++;
      }
    }
    expect(plains).toBeGreaterThan(0);
    expect(hills).toBeGreaterThan(0);
  });

  it('wraps seamlessly across the east-west seam of a round world', () => {
    const round = new NoiseHeights(ROUND_WORLD_16x8KM, defaultNoiseTerrain(7));
    const W = ROUND_WORLD_16x8KM.widthUnits;
    for (const z of [0, 5_000, 100_000]) {
      expect(round.heights(W, z, 64, 4)).toEqual(round.heights(0, z, 64, 4));
      // Straddling the seam equals the two halves stitched together.
      const straddle = round.heights(W - 32, z, 64, 1);
      const left = round.heights(W - 32, z, 32, 1);
      const right = round.heights(0, z, 32, 1);
      expect([...straddle]).toEqual([...left, ...right]);
    }
  });

  it('rejects noise spacings that cannot wrap the world width', () => {
    expect(() => new NoiseHeights(ROUND_WORLD_16x8KM, { ...defaultNoiseTerrain(1), hillScale: 4096 })).toThrow(/wrap/);
    // A non-wrapping world does not care.
    expect(() => new NoiseHeights(FLAT_WORLD_16KM, { ...defaultNoiseTerrain(1), hillScale: 4096 })).not.toThrow();
  });

  it('rejects terrain taller than the world', () => {
    expect(() => new NoiseHeights(FLAT_WORLD_16KM, { ...defaultNoiseTerrain(1), hillHeight: FLAT_WORLD_16KM.maxYUnits })).toThrow(/range/);
  });
});

describe('validateVoxelize', () => {
  it('accepts grid sizes and non-negative tolerances only', () => {
    expect(() => validateVoxelize({ minVoxelSize: 1, tolerance: 0 })).not.toThrow();
    expect(() => validateVoxelize({ minVoxelSize: 3, tolerance: 0 })).toThrow(/minVoxelSize/);
    expect(() => validateVoxelize({ minVoxelSize: 1, tolerance: -1 })).toThrow(/tolerance/);
    expect(() => validateVoxelize({ minVoxelSize: 1, tolerance: NaN })).toThrow(/tolerance/);
  });
});

describe('TerrainGenerator', () => {
  it('uses only whole 1 m blocks for flat ground on a 1 m line', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 0 }, fnSource(() => 32, 32, 32));
    for (const cy of [-1, 0, 1]) {
      const c = gen.generateChunk({ cx: 3, cy, cz: 4 });
      expect(c.blocks.every((b) => b === null || (b.kind === 'uniform' && b.size === 16))).toBe(true);
    }
    const surface = gen.generateChunk({ cx: 3, cy: 0, cz: 4 });
    expect(voxelAt(surface, 5, 31, 5)?.material).toBe(Material.Grass);
    expect(voxelAt(surface, 5, 15, 5)?.material).toBe(Material.Dirt);
    expect(voxelAt(surface, 5, 32, 5)).toBeNull();
  });

  it('snaps off-grid flat ground to 1 m when the tolerance allows, and not otherwise', () => {
    const src = fnSource(() => 5, 5, 5);
    const exact = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 0 }, src).generateChunk({ cx: 0, cy: 0, cz: 0 });
    expect(exact.blocks.some((b) => b?.kind === 'voxels')).toBe(true);
    const snapped = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 8 }, src).generateChunk({ cx: 0, cy: 0, cz: 0 });
    expect(snapped.blocks.every((b) => b === null)).toBe(true); // 5 units of ground rounded away
  });

  const src = new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(1));
  const hill = hillyColumn(src, 96);

  for (const [minVoxelSize, tolerance] of [[1, 0], [1, 2], [1, 4], [1, 8], [4, 0], [2, 3]] as const) {
    it(`keeps octree invariants (min ${minVoxelSize}, tolerance ${tolerance})`, () => {
      const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize, tolerance }, src);
      let checked = 0;
      for (let cy = Math.floor(hill.lo / CHUNK_SIZE); cy <= Math.floor(hill.hi / CHUNK_SIZE); cy++) {
        for (const block of voxelBlocks(gen.generateChunk({ cx: hill.cx, cy, cz: hill.cz }))) {
          expect(() => rasterizeVoxels(block)).not.toThrow(); // in-block, non-overlapping
          const byKey = new Map<string, number>();
          for (let i = 0; i < block.packed.length; i++) {
            const v = unpackVoxel(block.packed[i]!);
            expect([1, 2, 4, 8].includes(v.size)).toBe(true);
            expect(v.size).toBeGreaterThanOrEqual(minVoxelSize);
            for (const c of [v.x, v.y, v.z]) expect(c % v.size).toBe(0); // octree-aligned
            byKey.set(`${v.x},${v.y},${v.z},${v.size}`, block.materials[i]!);
            checked++;
          }
          // Canonical: no 8 aligned siblings of one material that should have merged.
          for (const [key, m] of byKey) {
            const [x, y, z, s] = key.split(',').map(Number) as [number, number, number, number];
            const p = 2 * s;
            if (x % p || y % p || z % p) continue;
            const siblings = [0, 1].flatMap((a) => [0, 1].flatMap((b) => [0, 1].map((c) => byKey.get(`${x + a * s},${y + b * s},${z + c * s},${s}`))));
            expect(siblings.every((sm) => sm === m)).toBe(false);
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  for (const tolerance of [0, 2, 4, 8]) {
    it(`misplaces the surface by at most the tolerance (${tolerance}) in every column`, () => {
      const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance }, src);
      const H = src.heights(hill.cx * CHUNK_SIZE, hill.cz * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
      let mismatches = 0;
      for (let cy = Math.floor(hill.lo / CHUNK_SIZE) - 1; cy <= Math.floor(hill.hi / CHUNK_SIZE) + 1; cy++) {
        const chunk = gen.generateChunk({ cx: hill.cx, cy, cz: hill.cz });
        const y0 = cy * CHUNK_SIZE;
        // Every 3rd column in each direction keeps this fast while crossing all blocks.
        for (let z = 0; z < CHUNK_SIZE; z += 3) {
          for (let x = 0; x < CHUNK_SIZE; x += 3) {
            const h = H[x + CHUNK_SIZE * z]!;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
              const y = y0 + ly;
              const solid = voxelAt(chunk, x, ly, z) !== null;
              const exact = y < h;
              if (solid === exact) continue;
              mismatches++;
              if (solid) expect(y - h).toBeLessThan(Math.max(tolerance, 1));
              else expect(h - y).toBeLessThanOrEqual(tolerance);
            }
          }
        }
      }
      if (tolerance === 0) expect(mismatches).toBe(0);
    });
  }

  it('merges eight identical children back into their parent', () => {
    // One low column (h = 8) per 8x8 quadrant, 15 elsewhere: the 1 m block
    // must split, yet all eight 8-unit children come out as solid grass.
    const f = (x: number, z: number) => ((x & 7) === 3 && (z & 7) === 5 ? 8 : 15);
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 8, tolerance: 0 }, fnSource(f, 8, 15));
    const block = gen.generateChunk({ cx: 0, cy: 0, cz: 0 }).blocks[0];
    expect(block).toEqual({ kind: 'uniform', size: 16, material: Material.Grass });
  });

  for (const tolerance of [0, 2, 4, 8]) {
    it(`never leaves dirt or stone exposed to the sky (tolerance ${tolerance})`, () => {
      const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance }, src);
      const lo = Math.floor(hill.lo / CHUNK_SIZE), hi = Math.floor(hill.hi / CHUNK_SIZE);
      const chunks = new Map<number, Chunk>();
      for (let cy = lo; cy <= hi + 1; cy++) chunks.set(cy, gen.generateChunk({ cx: hill.cx, cy, cz: hill.cz }));
      const at = (x: number, y: number, z: number) => voxelAt(chunks.get(Math.floor(y / CHUNK_SIZE))!, x, ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, z);
      let exposed = 0, checked = 0;
      for (let z = 0; z < CHUNK_SIZE; z += 2) {
        for (let x = 0; x < CHUNK_SIZE; x += 2) {
          for (let y = lo * CHUNK_SIZE; y < (hi + 1) * CHUNK_SIZE; y++) {
            const v = at(x, y, z);
            if (!v || at(x, y + 1, z)) continue;
            checked++;
            if (v.material !== Material.Grass) exposed++;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(exposed).toBe(0);
    });
  }

  it('makes surface voxels grass, then dirt, then stone', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 0 }, fnSource(() => 0, 0, 0));
    const below = gen.generateChunk({ cx: 0, cy: -1, cz: 0 });
    expect(voxelAt(below, 0, 255, 0)?.material).toBe(Material.Grass);
    expect(voxelAt(below, 0, 255 - 16, 0)?.material).toBe(Material.Dirt);
    expect(voxelAt(below, 0, 255 - 64, 0)?.material).toBe(Material.Stone);
  });

  it('shares uniform block objects so buried chunks encode tiny', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, src);
    const deep = gen.generateChunk({ cx: hill.cx, cy: -5, cz: hill.cz });
    expect(new Set(deep.blocks).size).toBe(1);
  });

  it('returns empty chunks outside the world and above the terrain', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, src);
    expect(gen.generateChunk({ cx: -1, cy: -1, cz: 0 }).blocks.every((b) => b === null)).toBe(true);
    expect(gen.generateChunk({ cx: 0, cy: 10, cz: 0 }).blocks.every((b) => b === null)).toBe(true);
    const floor = FLAT_WORLD_16KM.minYUnits / CHUNK_SIZE;
    expect(gen.generateChunk({ cx: 0, cy: floor - 1, cz: 0 }).blocks.every((b) => b === null)).toBe(true);
    expect(gen.generateChunk({ cx: 0, cy: floor, cz: 0 }).blocks.every((b) => b !== null)).toBe(true);
  });

  it('reports exact column ranges and grass surface samples', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, src);
    const H = src.heights(hill.cx * CHUNK_SIZE, hill.cz * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    expect(gen.columnRange(hill.cx, hill.cz)).toEqual({ minY: Math.min(...H), maxY: Math.max(...H) });
    const s = gen.surfaceSamples(1000, 2000, 64, 8);
    expect(s.heights).toEqual(src.heights(1000, 2000, 8, 8, 64));
    expect([...new Set(s.materials)]).toEqual([Material.Grass]);
  });

  it('reports the surface height for spawning', () => {
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, src);
    const H = src.heights(1000, 2000, 1, 1);
    expect(gen.surfaceHeightAt(1000, 2000)).toBe(H[0]);
  });
});
