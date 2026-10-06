import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_AXIS, blockIndex } from './chunk.js';
import { Geology, isGeologyRock, layerSequence, rockNote, type GeologyColumn } from './geology.js';
import { ALL_ITEMS, Item, itemName } from './items.js';
import { RECIPES } from './recipes.js';
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

  /** How far faults have moved the rock at height y in column c (units). */
  const moved = (c: GeologyColumn, y: number) => c.cutY.reduce((t, cy, i) => (y > cy ? t + c.cutShift[i]! : t), 0);
  /** The height (units) of the point `offset` units above the fold's surface in column c, as faults have moved it (or null where a fault plane is too near to say). */
  const atLayer = (c: GeologyColumn, offset: number) => {
    let y = c.fold + offset;
    for (let k = 0; k < 4; k++) y = c.fold + offset + moved(c, y);
    return Math.abs(moved(c, y) - (y - c.fold - offset)) < 1e-6 ? y : null;
  };

  it('granite below the basement, layers above it', () => {
    let checked = 0;
    for (let x = 0; x < 16000; x += 997) {
      const c = g.column(x * M, ((x * 7) % 16000) * M);
      const deep = atLayer(c, -c.base - 5 * M), shallow = atLayer(c, -c.base + 5 * M);
      if (deep === null || shallow === null) continue;
      expect(g.rock(deep, c, 0, 0)).toBe(Material.Granite);
      expect([Material.Sandstone, Material.Shale, Material.Limestone, Material.CoalOre]).toContain(g.rock(shallow, c, 0, 0));
      checked++;
      // (Basement 90-190 m down; layers folded up to about 120 m either way; stretched 0.75-1.25.)
      expect(c.base / M).toBeGreaterThan(85);
      expect(c.base / M).toBeLessThan(195);
      expect(Math.abs(c.fold / M)).toBeLessThan(140);
      expect(c.stretch).toBeGreaterThan(0.7);
      expect(c.stretch).toBeLessThan(1.3);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('a layer carries on sideways: a seam can be followed (rising and falling with the fold, and the faults)', () => {
    const rows = layerSequence(42);
    const seamRow = rows.findIndex((m, i) => i > 220 && m === Material.CoalOre);
    let inSeam = 0, steps = 0;
    for (let x = 5000; x < 5300; x++) {
      const c = g.column(x * M, 3000 * M);
      // (The seam's row's middle, through the column's stretch, where faults have moved it.)
      const y = atLayer(c, (seamRow - 200 + 0.5) * M * c.stretch);
      if (y === null) continue;
      steps++;
      const m = g.rock(y, c, x, 3000);
      if (m === Material.CoalOre || m === Material.Shale) inSeam++;
    }
    // (Shale: the seam's impure blocks, or its edge where the stretch changes it by a row.)
    expect(steps).toBeGreaterThan(250);
    expect(inSeam / steps).toBeGreaterThan(0.95);
  });

  it('faults: steep, 3-8 km long, moving the rock above them 5-40 m (most down)', () => {
    const faults = [];
    for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) { const f = g.faultIn(i, j); if (f) faults.push(f); }
    // (About 60% of regions have one.)
    expect(faults.length).toBeGreaterThan(400 * 0.45);
    expect(faults.length).toBeLessThan(400 * 0.75);
    for (const f of faults) {
      expect(Math.abs(f.throw) / M).toBeGreaterThanOrEqual(5);
      expect(Math.abs(f.throw) / M).toBeLessThanOrEqual(40);
      expect((f.half * 2) / M).toBeGreaterThanOrEqual(3000);
      expect((f.half * 2) / M).toBeLessThanOrEqual(8000);
      expect(Math.atan(f.tanDip) * (180 / Math.PI)).toBeGreaterThanOrEqual(55);
    }
    expect(faults.filter((f) => f.throw < 0).length).toBeGreaterThan(faults.length * 0.55);
  });

  it('across a fault the rock jumps by its throw (tapering toward its ends); beyond its ends, and far off it, nothing', () => {
    let f = null;
    for (let j = 0; j < 20 && !f; j++) for (let i = 0; i < 20 && !f; i++) { const q = g.faultIn(i, j); if (q && Math.abs(q.throw) > 25 * M) f = q; }
    expect(f).not.toBeNull();
    const at = (along: number, across: number) => [f!.x + f!.sx * along + f!.nx * across, f!.z + f!.sz * along + f!.nz * across] as const;
    // This fault alone: just either side of where its plane comes up (it leans toward +across).
    const only = (along: number, across: number) => g.column(...at(along, across), [f!]);
    const y = 0;
    const jumpMiddle = moved(only(0, 10 * M), y) - moved(only(0, -10 * M), y);
    expect(jumpMiddle).toBeCloseTo(f!.throw * (1 - 10 * M / f!.reach) ** 2 * (3 - 2 * (1 - 10 * M / f!.reach)), -1);
    // Toward its ends, less; beyond them, none.
    const jumpNearEnd = moved(only(f!.half * 0.8, 10 * M), y) - moved(only(f!.half * 0.8, -10 * M), y);
    expect(Math.abs(jumpNearEnd)).toBeLessThan(Math.abs(jumpMiddle) * 0.5);
    expect(only(f!.half + 50 * M, 10 * M).cutY).toHaveLength(0);
    // Far off it (beyond its reach) on the side it moves: none.
    expect(only(0, f!.reach + 50 * M).cutY).toHaveLength(0);
    // Deep under the side it leans toward, the plane is passed: below it, nothing's moved.
    const c = only(0, 100 * M);
    expect(moved(c, c.cutY[0]! - 16)).toBe(0);
    expect(moved(c, c.cutY[0]! + 16)).not.toBe(0);
  });

  it('on a world that wraps, the same either side of the seam', () => {
    const W = 16000 * M, wrapped = new Geology(42, 0, W);
    for (const z of [100, 4000, 9000]) {
      const a = wrapped.column(0, z * M), b = wrapped.column(W, z * M);
      expect(a.fold).toBeCloseTo(b.fold, 6);
      expect(a.base).toBeCloseTo(b.base, 6);
      expect(a.stretch).toBeCloseTo(b.stretch, 6);
      expect(a.cutY).toEqual(b.cutY);
      expect(a.cutShift.map((v) => Math.round(v * 1e6))).toEqual(b.cutShift.map((v) => Math.round(v * 1e6)));
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

  it('worlds made before faults (geology 1) have none; new ones (2) do', () => {
    const cuts = (geology: number) => {
      const g = new PlateHeights(world, { ...config, geology }).geology()!;
      let n = 0;
      for (let x = 500; x < 16000; x += 500) n += g.column(x * M, 8000 * M).cutY.length;
      return n;
    };
    expect(cuts(1)).toBe(0);
    expect(cuts(2)).toBeGreaterThan(0);
  });

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

describe("the geologist's hammer", () => {
  it('names each rock, with what to know (shale: where coal is); anything else, its name', () => {
    expect(rockNote(Material.Sandstone)).toMatch(/^sandstone/);
    expect(rockNote(Material.Limestone)).toMatch(/^limestone/);
    expect(rockNote(Material.Granite)).toMatch(/^granite/);
    expect(rockNote(Material.Shale)).toMatch(/^shale.*coal/);
    expect(rockNote(Material.CoalOre)).toMatch(/coal.*seam/);
    expect(rockNote(Material.Grass)).toBe('grass');
  });

  it('is an item (in creative), made cheaply at a crafting table (in survival)', () => {
    expect(ALL_ITEMS).toContain(Item.GeologistsHammer);
    expect(itemName(Item.GeologistsHammer)).toBe("geologist's hammer");
    const r = RECIPES.find((q) => q.output[0] === Item.GeologistsHammer);
    expect(r).toBeDefined();
    expect(r!.inputs).toEqual([[Material.Cobblestone, 1], [Item.Stick, 1]]);
    expect(r!.table).toBe(true);
  });
});
