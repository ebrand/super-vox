import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE } from './chunk.js';
import { Material, isWater } from './materials.js';
import { PlateHeights, defaultPlateTerrain, migratePlateTerrain } from './plates.js';
import { BANK_SLOPE, VALLEY_REACH, buildHydrology, carveRivers, riverSize, type RiverSegment } from './rivers.js';
import { TerrainGenerator } from './terrain.js';
import { NO_WATER } from './water.js';
import { CHUNK_SIZE, FLAT_WORLD_16KM } from './world.js';

const M = 16, CELL = 512;

/** A 60 x 40 cell slope down to the sea along x (sea for x < 4), with a valley along z = 20. */
function valley(extra?: (c: number, r: number) => number) {
  const cols = 60, rows = 40;
  const e = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    e[c + cols * r] = c < 4 ? -20 * M : (c - 3) * 2 * M + Math.abs(r - 20) * 1.5 * M + (extra?.(c, r) ?? 0);
  }
  return { e, cols, rows };
}

describe('hydrology', () => {
  it('runs a river down the valley to the sea, falling and widening as it goes', () => {
    const { e, cols, rows } = valley();
    const h = buildHydrology({ elevation: e, cols, rows, cell: CELL, sea: 0, wrap: false, wetness: null, rivers: 50, lakes: 0, seed: 1 });
    expect(h.segments.length).toBeGreaterThan(20);
    // Along the valley floor (z near cell 20), from the inland end to the sea.
    const main = h.segments.filter((s) => Math.abs(s.az / CELL - 20.5) < 1.5).sort((a, b) => b.ax - a.ax);
    expect(main.length).toBeGreaterThan(30);
    for (const s of main) expect(s.sb).toBeLessThanOrEqual(s.sa); // never runs uphill
    expect(main[main.length - 1]!.width).toBeGreaterThan(main[0]!.width); // wider toward the sea
    // It reaches the sea.
    expect(Math.min(...main.map((s) => Math.min(s.ax, s.bx)))).toBeLessThan(5 * CELL);
  });

  it('makes no rivers at 0, and more, smaller streams as the setting rises', () => {
    const count = (rivers: number) => {
      const { e, cols, rows } = valley();
      return buildHydrology({ elevation: e, cols, rows, cell: CELL, sea: 0, wrap: false, wetness: null, rivers, lakes: 0, seed: 1 }).riverCells;
    };
    expect(count(0)).toBe(0);
    expect(count(75)).toBeGreaterThan(count(50));
    expect(count(100)).toBeGreaterThan(count(75));
  });

  it('holds a lake at its spill height in a big enough basin, and fills small ones in', () => {
    // A bowl 40 m deep at the middle, 12 cells across, up the valley: deeper than the slope it
    // sits on drops, so it holds water.
    const bowl = (c: number, r: number) => {
      const d = Math.hypot(c - 40, r - 20);
      return d < 6 ? -40 * M * (1 - d / 6) : 0;
    };
    const lake = valley(bowl);
    // (About 45 cells lie below its rim: lakes 80 keeps basins of 8 or more.)
    const h = buildHydrology({ elevation: lake.e, cols: lake.cols, rows: lake.rows, cell: CELL, sea: 0, wrap: false, wetness: null, rivers: 50, lakes: 80, seed: 1 });
    expect(h.lakeCount).toBe(1);
    const centre = 40 + lake.cols * 20;
    const level = h.lakeLevel[centre]!;
    expect(level).toBeGreaterThan(lake.e[centre]!);
    // Flat: every lake cell has the same level, and it's at the basin's rim, where water spills.
    const levels = new Set([...h.lakeLevel].filter((v) => !Number.isNaN(v)));
    expect(levels.size).toBe(1);
    // With lakes off, the basin is filled in instead.
    const filled = valley(bowl);
    const f = buildHydrology({ elevation: filled.e, cols: filled.cols, rows: filled.rows, cell: CELL, sea: 0, wrap: false, wetness: null, rivers: 50, lakes: 0, seed: 1 });
    expect(f.lakeCount).toBe(0);
    expect(filled.e[centre]).toBeGreaterThan(lake.e[centre]! + 5 * M);
  });

  it('by area: makes the biggest basins lakes first, until they hold that share of what all of them could', () => {
    // Three bowls up the valley (above the sea), big, middling and small.
    const bowls = [[28, 7], [42, 5], [53, 3]] as const;
    const terrain = () => valley((c, r) => bowls.reduce((t, [bc, br]) => {
      const d = Math.hypot(c - bc, r - 20);
      return t + (d < br ? -40 * M * (1 - d / br) : 0);
    }, 0));
    const at = (lakes: number) => {
      const v = terrain();
      const h = buildHydrology({ elevation: v.e, cols: v.cols, rows: v.rows, cell: CELL, sea: 0, wrap: false, wetness: null, rivers: 0, lakes, lakesByArea: true, seed: 1 });
      const has = bowls.map(([bc]) => !Number.isNaN(h.lakeLevel[bc + v.cols * 20]!));
      return { count: h.lakeCount, cells: h.lakeCells, has };
    };
    const all = at(100);
    expect(all.count).toBe(3);
    expect(at(0).count).toBe(0);
    // A little: the big bowl alone (the others filled in).
    expect(at(1).has).toEqual([true, false, false]);
    // More: never less water, and the middling bowl before the small one.
    let before = 0;
    for (let lakes = 0; lakes <= 100; lakes += 5) {
      const a = at(lakes);
      expect(a.cells).toBeGreaterThanOrEqual(before);
      if (a.has[2]) expect(a.has[1]).toBe(true);
      // At least the share asked for (lakes come whole: up to one basin over).
      expect(a.cells).toBeGreaterThanOrEqual((lakes / 100) * all.cells - 1e-9);
      before = a.cells;
    }
    // Older worlds keep the smallest-basin meaning; new ones go by area.
    expect(migratePlateTerrain({}).lakesByArea).toBe(0);
    expect(migratePlateTerrain({ lakesByArea: 1 }).lakesByArea).toBe(1);
    expect(defaultPlateTerrain().lakesByArea).toBe(1);
  });

  it('cuts a channel under the water and a valley around it, and leaves the rest alone', () => {
    const s: RiverSegment = { ax: 0, az: 0, bx: 1000 * M, bz: 0, sa: 20 * M, sb: 10 * M, width: 10 * M, depth: 2 * M };
    const mid = 500 * M, surface = 15 * M;
    const centre = carveRivers([s], mid, 0, 40 * M, 1e9, false);
    expect(centre.water).toBeCloseTo(surface, 6);
    expect(centre.ground).toBeCloseTo(surface - 2 * M, 6);
    const edge = carveRivers([s], mid, 4 * M, 40 * M, 1e9, false);
    expect(edge.ground).toBeLessThan(surface);
    expect(edge.ground).toBeGreaterThan(surface - 2 * M);
    // Banks rise at BANK_SLOPE; no water out there.
    const bank = carveRivers([s], mid, 25 * M, 40 * M, 1e9, false);
    expect(bank.water).toBeNull();
    expect(bank.ground).toBeCloseTo(surface + 20 * M * BANK_SLOPE, 6);
    // Ground already lower is kept; beyond the valley, nothing changes.
    expect(carveRivers([s], mid, 25 * M, 0, 1e9, false).ground).toBe(0);
    expect(carveRivers([s], mid, 5 * M + VALLEY_REACH + 1, 40 * M, 1e9, false)).toEqual({ ground: 40 * M, water: null });
  });

  it('widens with the area drained, up to 50 m', () => {
    expect(riverSize(100, CELL).width).toBeLessThan(riverSize(10000, CELL).width);
    expect(riverSize(1e9, CELL).width).toBe(50 * M);
  });
});

describe('rivers and lakes in plate worlds', () => {
  const p = new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(9), mountains: 0 });

  it('are on by default and off for older worlds', () => {
    expect(defaultPlateTerrain().rivers).toBe(50);
    expect(defaultPlateTerrain().lakes).toBe(50);
    expect(migratePlateTerrain({})).toMatchObject({ rivers: 0, lakes: 0 });
    expect(new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(9), mountains: 0, rivers: 0, lakes: 0 }).hydrology).toBeNull();
    expect(p.hydrology!.riverCells).toBeGreaterThan(200);
  });

  it('stand above the sea with a sand bed under them, in generated chunks too', () => {
    // A river segment well inland: sample around its middle.
    const s = p.hydrology!.segments.find((x) => x.sa > 20 * M && x.width > 6 * M)!;
    const x = Math.round((s.ax + s.bx) / 2), z = Math.round((s.az + s.bz) / 2);
    const w = p.water(x - 64, z - 64, 9, 9, 16)!;
    const h = p.heights(x - 64, z - 64, 9, 9, 16);
    const m = p.materials(x - 64, z - 64, 9, 9, 16, h);
    let wet = 0;
    for (let k = 0; k < 81; k++) {
      if (w[k] === NO_WATER) continue;
      wet++;
      expect(w[k]).toBeGreaterThan(p.seaLevel);
      expect(w[k]).toBeGreaterThan(h[k]!);
      expect(m[k]).toBe(Material.Sand);
    }
    expect(wet).toBeGreaterThan(0);
    // The chunk under it holds fresh water above sea level.
    const gen = new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance: 4 }, p);
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const r = gen.columnRange(cx, cz);
    let water = 0;
    for (let cy = Math.floor(r.minY / CHUNK_SIZE); cy <= Math.floor(r.maxY / CHUNK_SIZE); cy++) {
      const chunk = gen.generateChunk({ cx, cy, cz });
      chunk.blocks.forEach((b, i) => {
        if (!b) return;
        const y0 = cy * CHUNK_SIZE + Math.floor(i / 256) * BLOCK_SIZE;
        const ms = b.kind === 'uniform' ? [b.material] : Array.from(b.materials);
        if (y0 >= p.seaLevel && ms.some(isWater)) water++;
      });
    }
    expect(water).toBeGreaterThan(0);
  });
});

describe('river valleys on steep ground', () => {
  it('leave no steps: a stream falling faster than its banks rise, beside a steep hillside', () => {
    // A stream running south, falling 0.5 m per metre, in 40 m pieces with a bend; the hillside to
    // the east rises 1 m per metre (and falls with the stream).
    const pts = [[0, 0], [5, 40], [0, 80], [10, 120], [5, 160], [0, 200]].map(([x, z]) => [x! * M, z! * M] as const);
    const segs: RiverSegment[] = pts.slice(1).map(([bx, bz], k) => {
      const [ax, az] = pts[k]!;
      return { ax, az, bx, bz, sa: (300 - az / M / 2) * M, sb: (300 - bz / M / 2) * M, width: 6 * M, depth: 2 * M };
    });
    const hill = (x: number, z: number) => (300 - z / M / 2 + 2 + Math.max(0, x / M)) * M;
    const N = 160, step = M; // metres east and south, 1 m apart
    const h: number[][] = [], wet: boolean[][] = [];
    for (let j = 0; j < N; j++) {
      h.push([]);
      wet.push([]);
      for (let i = 0; i < N; i++) {
        const x = (i - 20) * step, z = (j + 20) * step;
        const r = carveRivers(segs, x, z, hill(x, z), 1e9, false);
        h[j]!.push(r.ground);
        wet[j]!.push(r.water !== null);
      }
    }
    // Out of the channel (a steep bowl across the stream), the slope changes gradually: a step
    // (or a valley cut off at its reach) shows as a sudden change between neighbouring metres.
    let worst = 0;
    for (let j = 2; j < N; j++) {
      for (let i = 2; i < N; i++) {
        if (wet[j]![i] || wet[j]![i - 1] || wet[j]![i - 2] || wet[j - 1]![i] || wet[j - 2]![i]) continue;
        worst = Math.max(worst, Math.abs(h[j]![i]! - 2 * h[j]![i - 1]! + h[j]![i - 2]!), Math.abs(h[j]![i]! - 2 * h[j - 1]![i]! + h[j - 2]![i]!));
      }
    }
    expect(worst / M).toBeLessThan(1);
  });
});
