import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_AXIS, blockIndex } from './chunk.js';
import { Geology, isGeologyRock, layerSequence } from './geology.js';
import { Material } from './materials.js';
import { PlateHeights, defaultPlateTerrain } from './plates.js';
import { TerrainGenerator, defaultVoxelize } from './terrain.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM } from './world.js';

const M = 16;

/** The runs in a sequence: each rock and how many metres of it. */
function runs(rows: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  for (const m of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}

describe('layerSequence', () => {
  it('the same for a seed, different for another; only sedimentary rock and coal', () => {
    expect(layerSequence(7)).toEqual(layerSequence(7));
    expect(layerSequence(7)).not.toEqual(layerSequence(8));
    for (const m of layerSequence(7)) expect([Material.Sandstone, Material.Shale, Material.Limestone, Material.CoalOre]).toContain(m);
  });

  it('layers 2-12 m thick, coal seams 1-2 m (one every few tens of metres), all three rocks plenty', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      // (The first and last runs may be cut short by the table's ends.)
      const r = runs(layerSequence(seed)).slice(1, -1);
      const seams = r.filter(([m]) => m === Material.CoalOre);
      for (const [m, n] of r) {
        if (m === Material.CoalOre) {
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(2);
        } else {
          expect(n).toBeGreaterThanOrEqual(2);
          // (Two layers of the same rock can meet: as much as two of the thickest.)
          expect(n).toBeLessThanOrEqual(24);
        }
      }
      const metres = r.reduce((t, [, n]) => t + n, 0);
      expect(metres / seams.length).toBeGreaterThan(15);
      expect(metres / seams.length).toBeLessThan(80);
      for (const rock of [Material.Sandstone, Material.Shale, Material.Limestone]) expect(r.filter(([m]) => m === rock).length).toBeGreaterThan(10);
    }
  });
});

describe('Geology', () => {
  const g = new Geology(42, 0);

  it('granite below the basement, layers above it', () => {
    const c = g.column(1000 * M, 2000 * M);
    expect(g.rock(c.fold - c.base - 5 * M, c, 0, 0)).toBe(Material.Granite);
    expect([Material.Sandstone, Material.Shale, Material.Limestone, Material.CoalOre]).toContain(g.rock(c.fold - c.base + 5 * M, c, 0, 0));
    // (Basement 90-190 m down; layers folded up to about 120 m either way; stretched 0.75-1.25.)
    for (let x = 0; x < 16000; x += 997) {
      const k = g.column(x * M, (x * 7) % 16000 * M);
      expect(k.base / M).toBeGreaterThan(85);
      expect(k.base / M).toBeLessThan(195);
      expect(Math.abs(k.fold / M)).toBeLessThan(140);
      expect(k.stretch).toBeGreaterThan(0.7);
      expect(k.stretch).toBeLessThan(1.3);
    }
  });

  it('a layer carries on sideways: a seam can be followed (rising and falling with the fold)', () => {
    // A seam's middle at one place, then 1 m steps east following the fold: still in it.
    const rows = layerSequence(42);
    const seamRow = rows.findIndex((m, i) => i > 220 && m === Material.CoalOre);
    let inSeam = 0, steps = 0;
    for (let x = 5000; x < 5300; x++, steps++) {
      const c = g.column(x * M, 3000 * M);
      // (The seam's row's middle, through the column's stretch.)
      const y = c.fold + (seamRow - 200 + 0.5) * M * c.stretch;
      const m = g.rock(y, c, x, 3000);
      if (m === Material.CoalOre || m === Material.Shale) inSeam++;
    }
    // (Shale: the seam's impure blocks, or its edge where the stretch changes it by a row.)
    expect(inSeam / steps).toBeGreaterThan(0.95);
  });

  it('on a world that wraps, the same either side of the seam', () => {
    const W = 16000 * M, wrapped = new Geology(42, 0, W);
    for (const z of [100, 4000, 9000]) {
      const a = wrapped.column(0, z * M), b = wrapped.column(W, z * M);
      expect(a.fold).toBeCloseTo(b.fold, 6);
      expect(a.base).toBeCloseTo(b.base, 6);
      expect(a.stretch).toBeCloseTo(b.stretch, 6);
    }
  });
});

describe('geology in the terrain', () => {
  const world = FLAT_WORLD_16KM;
  const config = { ...defaultPlateTerrain(3, world), rivers: 0, lakes: 0, caves: 0 };

  /** The rock of underground blocks (counts by material) in chunks down a column of land. */
  function underground(geology: number) {
    const heights = new PlateHeights(world, { ...config, geology });
    const gen = new TerrainGenerator(world, defaultVoxelize(), heights);
    // A point on land, a little inland.
    let land: [number, number] | null = null;
    for (let x = 2000; x < 14000 && !land; x += 500)
      for (let z = 2000; z < 14000 && !land; z += 500) if (heights.heights(x * M, z * M, 1, 1)[0]! > heights.seaLevel + 20 * M) land = [x * M, z * M];
    const counts = new Map<number, number>();
    const cx = Math.floor(land![0] / CHUNK_SIZE), cz = Math.floor(land![1] / CHUNK_SIZE);
    const top = Math.floor(gen.surfaceHeightAt(land![0], land![1]) / CHUNK_SIZE);
    for (let dx = 0; dx < 3; dx++)
      for (let cy = top - 12; cy < top; cy++) {
        const chunk = gen.generateChunk({ cx: cx + dx, cy, cz });
        for (let by = 0; by < BLOCKS_PER_AXIS; by++)
          for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++)
            for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
              const b = chunk.blocks[blockIndex(bx, by, bz)];
              if (b?.kind === 'uniform') counts.set(b.material, (counts.get(b.material) ?? 0) + 1);
            }
      }
    return counts;
  }

  it('with geology: layered rock and coal seams, no plain stone; without: stone, as before', () => {
    const geo = underground(1), plain = underground(0);
    expect(geo.get(Material.Stone) ?? 0).toBe(0);
    for (const m of [Material.Sandstone, Material.Shale, Material.Limestone, Material.CoalOre]) expect(geo.get(m) ?? 0, `material ${m}`).toBeGreaterThan(0);
    expect(plain.get(Material.Stone) ?? 0).toBeGreaterThan(1000);
    for (const m of [Material.Sandstone, Material.Shale, Material.Limestone, Material.Granite]) expect(plain.get(m) ?? 0).toBe(0);
  }, 60_000);

  it('right under snow, the layers\' rock (no plain stone between the snow and the layers)', () => {
    const heights = new PlateHeights(world, { ...config, geology: 1, snowAltitude: 0, altitudeSnow: 1, biomes: 0 });
    const gen = new TerrainGenerator(world, defaultVoxelize(), heights);
    let checked = 0;
    for (let x = 3000; x < 13000 && checked < 3; x += 800) {
      const z = 8000, h = heights.heights(x * M, z * M, 1, 1)[0]!;
      if (h <= heights.seaLevel + 10 * M) continue;
      const mats = heights.materials(x * M, z * M, 1, 1, 1, Int32Array.of(h));
      if (mats[0] !== Material.Snow) continue;
      // The chunk holding the block 2 m under the surface (between the snow and DIRT_DEPTH).
      const y = h - 2 * M, chunk = gen.generateChunk({ cx: Math.floor((x * M) / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE), cz: Math.floor((z * M) / CHUNK_SIZE) });
      const b = chunk.blocks[blockIndex(Math.floor(((x * M) % CHUNK_SIZE) / 16), Math.floor((y % CHUNK_SIZE) / 16), Math.floor(((z * M) % CHUNK_SIZE) / 16))];
      if (b?.kind !== 'uniform') continue;
      expect(b.material).not.toBe(Material.Stone);
      expect(isGeologyRock(b.material) || b.material === Material.IronOre).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 60_000);

  it('bare rock at the surface is the layers\' rock (and the same in materials and materialsAt)', () => {
    const heights = new PlateHeights(world, { ...config, geology: 1, rockSlope: 5, rockVariety: 100 });
    const H = heights.heights(0, 0, 256, 256, 1024), mats = heights.materials(0, 0, 256, 256, 1024, H);
    const rock = [...mats].filter((m) => isGeologyRock(m));
    expect(rock.length).toBeGreaterThan(50);
    // (No patches: geology replaces them.)
    expect([...mats].filter((m) => m === Material.Gravel || m === Material.PaleStone || m === Material.MossyStone || m === Material.DarkStone)).toHaveLength(0);
    expect(new Set(rock).size).toBeGreaterThan(1);
    const at = heights.materialsAt(0, 0, 256, 256, 1024, H);
    for (let k = 0; k < mats.length; k += 7) expect(at(k)).toBe(mats[k]);
  });
});
