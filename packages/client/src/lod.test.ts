import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, FLAT_WORLD_16KM, tileSizeUnits } from '@super-vox/shared';
import { DETAIL_GROW_MS, SpeedDetail, flySpeeds, focusLead, selectLod } from './lod.js';

const FAR = 2048 * 16;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('selectLod', () => {
  it('keeps columns already drawn as voxel chunks (whole 32 m tiles of them) within the full-detail area, when chunks shrink', () => {
    const [x, z] = [500 * CHUNK_SIZE + 8, 300 * CHUNK_SIZE + 8];
    const full = selectLod(FLAT_WORLD_16KM, x, z, 8, FAR);
    const drawn = new Set(full.columns.map((c) => `${c.cx},${c.cz}`));
    // Moving fast: no chunks wanted; but all those drawn stay, and no tile covers them.
    const none = selectLod(FLAT_WORLD_16KM, x, z, 8, FAR, -1);
    expect(none.columns).toEqual([]);
    const kept = selectLod(FLAT_WORLD_16KM, x, z, 8, FAR, -1, 8, (cx, cz) => drawn.has(`${cx},${cz}`));
    expect(new Set(kept.columns.map((c) => `${c.cx},${c.cz}`))).toEqual(drawn);
    expect(kept.tiles).toEqual(full.tiles);
    // Only some drawn (a corner of one 32 m tile missing): that tile is a tile, the rest stay chunks.
    const [first] = full.columns, tx = Math.floor(first!.cx / 2), tz = Math.floor(first!.cz / 2);
    drawn.delete(`${tx * 2 + 1},${tz * 2 + 1}`);
    const partly = selectLod(FLAT_WORLD_16KM, x, z, 8, FAR, -1, 8, (cx, cz) => drawn.has(`${cx},${cz}`));
    expect(partly.tiles).toContainEqual({ level: 1, tx, tz });
    expect(partly.columns.length).toBe(full.columns.length - 4);
    // Beyond the full-detail area, drawn or not, nothing's kept (they'd be past the tiles' rings).
    const moved = selectLod(FLAT_WORLD_16KM, x + 40 * CHUNK_SIZE, z, 8, FAR, -1, 8, () => true);
    expect(moved.columns.length).toBeGreaterThan(0);
    for (const c of moved.columns) {
      // (Whole 32 m tiles within 8 chunks: their columns up to a tile further.)
      const d = Math.max(Math.abs((c.cx + 0.5) * CHUNK_SIZE - (x + 40 * CHUNK_SIZE)), Math.abs((c.cz + 0.5) * CHUNK_SIZE - z));
      expect(d).toBeLessThan((8 + 2) * CHUNK_SIZE);
    }
  });

  const fx = 9440 * 16, fz = 7968 * 16;
  const sel = selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR);

  it('covers every sampled point within view distance exactly once', () => {
    const rand = rng(1);
    for (let k = 0; k < 4000; k++) {
      const x = fx + (rand() * 2 - 1) * FAR * 0.99;
      const z = fz + (rand() * 2 - 1) * FAR * 0.99;
      let n = 0;
      for (const c of sel.columns) if (x >= c.cx * CHUNK_SIZE && x < (c.cx + 1) * CHUNK_SIZE && z >= c.cz * CHUNK_SIZE && z < (c.cz + 1) * CHUNK_SIZE) n++;
      for (const t of sel.tiles) {
        const s = tileSizeUnits(t.level);
        if (x >= t.tx * s && x < (t.tx + 1) * s && z >= t.tz * s && z < (t.tz + 1) * s) n++;
      }
      expect(n).toBe(1);
    }
  });

  it('uses full detail within the radius and coarser levels farther out', () => {
    // Every column within `radius` chunks is full detail.
    const cols = new Set(sel.columns.map((c) => `${c.cx},${c.cz}`));
    const fcx = Math.floor(fx / CHUNK_SIZE), fcz = Math.floor(fz / CHUNK_SIZE);
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) expect(cols.has(`${fcx + dx},${fcz + dz}`)).toBe(true);
    // Levels form an unbroken sequence from 1 outward (with radius 4, level-6
    // tiles would only start at 2048 m, the view limit, so levels stop at 5).
    const levels = [...new Set(sel.tiles.map((t) => t.level))].sort();
    expect(levels).toEqual([1, 2, 3, 4, 5]);
    // A larger view distance brings in level 6.
    expect(selectLod(FLAT_WORLD_16KM, fx, fz, 4, 2 * FAR).tiles.some((t) => t.level === 6)).toBe(true);
    expect(sel.columns.length).toBeLessThan(200);
    expect(sel.tiles.length).toBeLessThan(400);
  });

  it('skips everything outside a non-wrapping world', () => {
    const edge = selectLod(FLAT_WORLD_16KM, 100, 100, 4, FAR);
    for (const c of edge.columns) expect(c.cx >= 0 && c.cz >= 0).toBe(true);
    for (const t of edge.tiles) expect((t.tx + 1) * tileSizeUnits(t.level) > 0 && (t.tz + 1) * tileSizeUnits(t.level) > 0).toBe(true);
  });

  it('is deterministic and changes only near the focus when it moves a little', () => {
    expect(selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR)).toEqual(sel);
    const moved = selectLod(FLAT_WORLD_16KM, fx + CHUNK_SIZE, fz, 4, FAR);
    const key = (t: { level: number; tx: number; tz: number }) => `${t.level}:${t.tx},${t.tz}`;
    const before = new Set(sel.tiles.map(key));
    const changed = moved.tiles.filter((t) => !before.has(key(t)));
    expect(changed.length).toBeLessThan(sel.tiles.length / 4);
  });
});

describe('distant detail apart from the full-detail radius', () => {
  const fx = 9440 * 16, fz = 7968 * 16;
  const coveredOnce = (sel: ReturnType<typeof selectLod>) => {
    const rand = rng(2);
    for (let k = 0; k < 3000; k++) {
      const x = fx + (rand() * 2 - 1) * FAR * 0.99, z = fz + (rand() * 2 - 1) * FAR * 0.99;
      let n = 0;
      for (const c of sel.columns) if (x >= c.cx * CHUNK_SIZE && x < (c.cx + 1) * CHUNK_SIZE && z >= c.cz * CHUNK_SIZE && z < (c.cz + 1) * CHUNK_SIZE) n++;
      for (const t of sel.tiles) {
        const s = tileSizeUnits(t.level);
        if (x >= t.tx * s && x < (t.tx + 1) * s && z >= t.tz * s && z < (t.tz + 1) * s) n++;
      }
      expect(n).toBe(1);
    }
  };

  it('draws far rings as a smaller radius would, keeping the full-detail area, everything covered once', () => {
    const fine = selectLod(FLAT_WORLD_16KM, fx, fz, 8, FAR);
    const lean = selectLod(FLAT_WORLD_16KM, fx, fz, 8, FAR, 8, 4);
    coveredOnce(lean);
    expect(lean.columns).toEqual(fine.columns);
    // Far fewer distant samples (32 x 32 a tile): about a quarter.
    expect(lean.tiles.length / fine.tiles.length).toBeLessThan(0.35);
    // Like the default radius's rings beyond the full-detail area.
    const four = selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR);
    const beyond = (sel: ReturnType<typeof selectLod>) => sel.tiles.filter((t) => t.level >= 3).map((t) => `${t.level},${t.tx},${t.tz}`).sort();
    expect(beyond(lean)).toEqual(beyond(four));
  });

  it('is the same as before when the distant detail is the radius', () => {
    expect(selectLod(FLAT_WORLD_16KM, fx, fz, 6, FAR, 6, 6)).toEqual(selectLod(FLAT_WORLD_16KM, fx, fz, 6, FAR));
    expect(selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR, 4, 4)).toEqual(selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR));
  });

  it('covers everything once with finer distant detail too', () => {
    coveredOnce(selectLod(FLAT_WORLD_16KM, fx, fz, 4, FAR, 4, 6));
    coveredOnce(selectLod(FLAT_WORLD_16KM, fx, fz, 8, FAR, -1, 3));
  });
});

describe('focusLead', () => {
  it('leads one second of travel, at most radius - 1 chunks', () => {
    expect(focusLead(0, 0, 4)).toEqual({ dx: 0, dz: 0 });
    expect(focusLead(160, 0, 4)).toEqual({ dx: 160, dz: 0 }); // 10 m/s: 10 m ahead
    const fast = focusLead(-3000 * 16, 4000 * 16, 4); // 5 km/s: clamped to 3 chunks
    expect(Math.hypot(fast.dx, fast.dz)).toBeCloseTo(3 * CHUNK_SIZE);
    expect(fast.dx / fast.dz).toBeCloseTo(-3 / 4);
    expect(focusLead(1000, 0, 1)).toEqual({ dx: 0, dz: 0 });
  });
});

describe('voxel chunks while moving fast', () => {
  const world = FLAT_WORLD_16KM;
  const at = [8000.5 * 16, 8000.5 * 16] as const;

  it('replaces chunk columns beyond chunkRadius with 32 m tiles, keeping the rest of the layout', () => {
    const full = selectLod(world, ...at, 4, FAR);
    expect(selectLod(world, ...at, 4, FAR, 4)).toEqual(full);
    const none = selectLod(world, ...at, 4, FAR, -1);
    expect(none.columns).toEqual([]);
    // Every 2 x 2 group of columns became one level-1 tile; nothing else changed.
    expect(none.tiles.filter((t) => t.level === 1)).toHaveLength(full.columns.length / 4 + full.tiles.filter((t) => t.level === 1).length);
    expect(none.tiles.filter((t) => t.level > 1)).toEqual(full.tiles.filter((t) => t.level > 1));
    const some = selectLod(world, ...at, 4, FAR, 1);
    expect(some.columns.length).toBeGreaterThan(0);
    expect(some.columns.length).toBeLessThan(full.columns.length);
    for (const c of some.columns) expect(Math.max(Math.abs((c.cx + 0.5) * CHUNK_SIZE - at[0]), Math.abs((c.cz + 0.5) * CHUNK_SIZE - at[1]))).toBeLessThan(3 * CHUNK_SIZE);
  });

  it('shrinks the chunk radius in steps with speed at once, and grows it back only after a while', () => {
    const sd = new SpeedDetail(8, { full: 25, none: 60 });
    expect(sd.target(5)).toBe(8);
    expect(sd.target(25)).toBe(8); // ordinary speeds keep full detail
    expect(sd.target(26)).toBe(4);
    expect(sd.target(59)).toBe(4);
    expect(sd.target(60)).toBe(-1);
    expect(sd.target(400)).toBe(-1);
    expect(new SpeedDetail(5).target(40)).toBe(3);
    expect(sd.update(5, 0)).toBe(8);
    expect(sd.update(80, 100)).toBe(-1); // at once
    expect(sd.update(5, 200)).toBe(-1); // slowed down: not yet
    expect(sd.update(5, 200 + DETAIL_GROW_MS - 1)).toBe(-1);
    expect(sd.update(5, 200 + DETAIL_GROW_MS)).toBe(8);
    // A wobble back up resets the wait.
    sd.update(80, 5000);
    sd.update(5, 5100);
    sd.update(80, 5200);
    expect(sd.update(5, 5300 + DETAIL_GROW_MS - 1)).toBe(-1);
  });

  it('flying, loads detail as it speeds up, less of it, then none (unless detail at any speed was asked for)', () => {
    const sd = new SpeedDetail(8, { full: 25, none: 60 });
    const FLY = flySpeeds(8);
    expect(FLY).toEqual({ full: 100, half: 180 });
    expect(sd.target(0, true)).toBe(8);
    expect(sd.target(15, true)).toBe(8); // the usual flying speed: everything as built
    expect(sd.target(FLY.full, true)).toBe(8);
    expect(sd.target(150, true)).toBe(4); // (Shift)
    expect(sd.target(FLY.half, true)).toBe(4);
    expect(sd.target(FLY.half + 1, true)).toBe(-1);
    expect(sd.target(40, false)).toBe(4); // on foot: as before
    expect(sd.update(750, 0, true)).toBe(-1); // at once
    expect(sd.update(15, 100, true)).toBe(-1); // slowed down: not yet
    expect(sd.update(15, 100 + DETAIL_GROW_MS, true)).toBe(8);
    const always = new SpeedDetail(8, { full: Infinity, none: Infinity });
    expect(always.target(300, true)).toBe(8);
  });

  it('flying, keeps up at speeds that go with the detail: a wider ring, slower', () => {
    expect(flySpeeds(16)).toEqual({ full: 50, half: 90 });
    expect(flySpeeds(4)).toEqual({ full: 200, half: 360 });
    const wide = new SpeedDetail(16), narrow = new SpeedDetail(4);
    expect(wide.target(60, true)).toBe(8);
    expect(wide.target(95, true)).toBe(-1);
    expect(narrow.target(180, true)).toBe(4);
    expect(narrow.target(350, true)).toBe(2);
    expect(narrow.target(370, true)).toBe(-1);
  });
});

