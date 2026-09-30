import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_CHUNK, GRID_SIZES, materialAt, type Chunk } from './chunk.js';
import { FlatGenerator, defaultFlatGen, validateFlatGen } from './flatgen.js';
import { Material } from './materials.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from './world.js';

/** Independent statement of the default layering: r of grass, 3 m dirt, stone. */
function expectedDefault(r: number, y: number): number {
  const minY = FLAT_WORLD_16KM.minYUnits;
  if (y >= 0 || y < minY) return Material.Air;
  if (y >= -r) return Material.Grass;
  if (y >= -r - 48) return Material.Dirt;
  return Material.Stone;
}

function distinctBlocks(chunk: Chunk): number {
  return new Set(chunk.blocks.filter((b) => b !== null)).size;
}

describe('validateFlatGen', () => {
  it('accepts the default config at every grid resolution', () => {
    for (const r of GRID_SIZES) expect(() => validateFlatGen(FLAT_WORLD_16KM, defaultFlatGen(r))).not.toThrow();
  });

  it('rejects resolutions that do not tile a 1 m block', () => {
    for (const r of [0, 3, 5, 6, 12, 15, 17, 2.5]) {
      expect(() => validateFlatGen(FLAT_WORLD_16KM, defaultFlatGen(r))).toThrow(RangeError);
    }
  });

  it('rejects misaligned surfaces and layers', () => {
    const gen = defaultFlatGen(4);
    expect(() => validateFlatGen(FLAT_WORLD_16KM, { ...gen, surfaceY: 2 })).toThrow(/surfaceY/);
    expect(() => validateFlatGen(FLAT_WORLD_16KM, { ...gen, surfaceY: FLAT_WORLD_16KM.maxYUnits + 4 })).toThrow(/range/);
    expect(() =>
      validateFlatGen(FLAT_WORLD_16KM, { ...gen, layers: [{ material: 1, thickness: 6 }, { material: 2, thickness: 0 }] }),
    ).toThrow(/thickness/);
    expect(() => validateFlatGen(FLAT_WORLD_16KM, { ...gen, layers: [{ material: 0, thickness: 0 }] })).toThrow(/material/);
    expect(() => validateFlatGen(FLAT_WORLD_16KM, { ...gen, layers: [] })).toThrow(/layer/);
  });
});

describe('FlatGenerator', () => {
  for (const r of GRID_SIZES) {
    describe(`resolution ${r}`, () => {
      const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(r));

      it('reports the expected material at every Y around the surface', () => {
        for (let y = -2 * CHUNK_SIZE; y < CHUNK_SIZE; y++) {
          expect(gen.materialAtY(y)).toBe(expectedDefault(r, y));
        }
      });

      it('fills the surface chunk exactly per the layering (full Y scan, sampled X/Z)', () => {
        const chunk = gen.generateChunk({ cx: 123, cy: -1, cz: 45 });
        const y0 = -CHUNK_SIZE;
        for (const [lx, lz] of [[0, 0], [255, 255], [17, 200], [128, 3], [r, r]] as const) {
          for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            expect(materialAt(chunk, lx, ly, lz)).toBe(expectedDefault(r, y0 + ly));
          }
        }
      });

      it('uses voxels of exactly the configured size', () => {
        const chunk = gen.generateChunk({ cx: 0, cy: -1, cz: 0 });
        for (const b of chunk.blocks) if (b) expect(b.kind !== 'voxels' && b.size).toBe(r);
      });

      it('shares blocks so a surface chunk has only a few distinct blocks', () => {
        const chunk = gen.generateChunk({ cx: 0, cy: -1, cz: 0 });
        // Rows: grass(+dirt) row, dirt rows, dirt/stone boundary (if misaligned), stone rows.
        expect(distinctBlocks(chunk)).toBeLessThanOrEqual(4);
      });
    });
  }

  const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(16));

  it('produces empty chunks above ground and solid stone deep below', () => {
    expect(gen.generateChunk({ cx: 5, cy: 0, cz: 5 }).blocks.every((b) => b === null)).toBe(true);
    const deep = gen.generateChunk({ cx: 5, cy: -10, cz: 5 });
    expect(deep.blocks).toHaveLength(BLOCKS_PER_CHUNK);
    expect(deep.blocks.every((b) => b?.kind === 'uniform' && b.material === Material.Stone)).toBe(true);
  });

  it('stops at the world floor', () => {
    const floorCy = FLAT_WORLD_16KM.minYUnits / CHUNK_SIZE;
    expect(gen.generateChunk({ cx: 0, cy: floorCy, cz: 0 }).blocks.every((b) => b !== null)).toBe(true);
    expect(gen.generateChunk({ cx: 0, cy: floorCy - 1, cz: 0 }).blocks.every((b) => b === null)).toBe(true);
  });

  it('returns empty chunks outside the horizontal bounds', () => {
    const last = FLAT_WORLD_16KM.widthUnits / CHUNK_SIZE;
    expect(gen.generateChunk({ cx: last - 1, cy: -1, cz: 0 }).blocks.some((b) => b !== null)).toBe(true);
    for (const c of [{ cx: last, cy: -1, cz: 0 }, { cx: -1, cy: -1, cz: 0 }, { cx: 0, cy: -1, cz: -1 }]) {
      expect(gen.generateChunk(c).blocks.every((b) => b === null)).toBe(true);
    }
  });

  it('honors the depth bound of the round world', () => {
    const round = new FlatGenerator(ROUND_WORLD_16x8KM, defaultFlatGen(16));
    const lastZ = ROUND_WORLD_16x8KM.depthUnits / CHUNK_SIZE;
    expect(round.generateChunk({ cx: 0, cy: -1, cz: lastZ - 1 }).blocks.some((b) => b !== null)).toBe(true);
    expect(round.generateChunk({ cx: 0, cy: -1, cz: lastZ }).blocks.every((b) => b === null)).toBe(true);
  });

  it('supports a surface that is not block-aligned', () => {
    const g = new FlatGenerator(FLAT_WORLD_16KM, {
      resolution: 2,
      surfaceY: 38,
      layers: [
        { material: Material.Grass, thickness: 2 },
        { material: Material.Stone, thickness: 0 },
      ],
    });
    const chunk = g.generateChunk({ cx: 0, cy: 0, cz: 0 });
    for (let ly = 0; ly < 64; ly++) {
      const expected = ly >= 38 ? Material.Air : ly >= 36 ? Material.Grass : Material.Stone;
      expect(materialAt(chunk, 7, ly, 9)).toBe(expected);
    }
  });
});
