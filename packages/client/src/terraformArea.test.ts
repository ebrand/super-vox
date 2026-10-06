import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, Material, ROUND_WORLD_16x8KM, defaultPlateTerrain, type TerrainStroke, type WorldConfig } from '@super-vox/shared';
import { AreaMaker, type AreaRequest, type MadeArea, type PatchedArea } from './terraformArea.js';

/** The default settings without geology: plain stone (these tests are about where bare rock is, not what it's made of). */
const plainTerrain = (...a: Parameters<typeof defaultPlateTerrain>) => ({ ...defaultPlateTerrain(...a), geology: 0 });

const M = 16;
const dry = { ...plainTerrain(9), rivers: 0, lakes: 0 };
const stroke = (over: Partial<TerrainStroke>): TerrainStroke => ({ kind: 'raise', x: 0, z: 0, radius: 30, amount: 12, softness: 0.5, ...over });
/** A 256 m area every 2 m around (x, z) metres. */
const area = (x: number, z: number, strokes: TerrainStroke[] = []): AreaRequest => ({ x0: (x - 128) * M, z0: (z - 128) * M, size: 256 * M, step: 2 * M, depth: 16 * M, strokes });
const isPatch = (r: PatchedArea | MadeArea | null): r is PatchedArea => !!r && !('base' in r);

describe('AreaMaker', () => {
  // Somewhere on land in seed 9's flat world.
  const where = [7000, 7000] as const;

  it('patches a change in just the sections it touches, exactly as making the area again would', () => {
    const maker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    const before = maker.make(area(...where));
    const s = [stroke({ x: where[0] + 20, z: where[1] - 10 })];
    const r = maker.patch(s, { x0: where[0] - 10, z0: where[1] - 40, x1: where[0] + 50, z1: where[1] + 20 });
    expect(isPatch(r)).toBe(true);
    const p = r as PatchedArea;
    // 64 m sections of a 256 m area: 16; a 60 m box, and the 11 m trees reach around it, touches
    // 3 x 3 of them at most.
    expect(p.parts.length).toBeGreaterThan(0);
    expect(p.parts.length).toBeLessThanOrEqual(9);
    expect(p.heights).not.toEqual(before.heights);
    // The same as a fresh maker's area with the stroke.
    const fresh = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 }).make(area(...where, s));
    expect(p.heights).toEqual(fresh.heights);
    for (const part of p.parts) {
      const same = fresh.parts.find((q) => q.key === part.key)!;
      expect(part.ground?.positions).toEqual(same.ground?.positions);
      expect(part.ground?.faces).toEqual(same.ground?.faces);
    }
    // And back: undoing it restores the area as it was.
    const back = maker.patch([], { x0: where[0] - 10, z0: where[1] - 40, x1: where[0] + 50, z1: where[1] + 20 });
    expect((back as PatchedArea).heights).toEqual(before.heights);
  });

  it('puts snow and rock where a patch raises the ground, as making the area again would', () => {
    const maker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    maker.make(area(...where));
    // A 500 m-high flat-topped hill with steep sides: snow on top, bare rock on the sides.
    const s = [stroke({ kind: 'level', x: where[0], z: where[1], radius: 90, amount: 500, softness: 0.3 })];
    maker.patch(s, { x0: where[0] - 100, z0: where[1] - 100, x1: where[0] + 100, z1: where[1] + 100 });
    const patched = (maker as unknown as { shown: { field: { materials: Uint16Array } } }).shown.field.materials;
    const freshMaker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    freshMaker.make(area(...where, s));
    const fresh = (freshMaker as unknown as { shown: { field: { materials: Uint16Array } } }).shown.field.materials;
    expect(patched).toEqual(fresh);
    expect(patched).toContain(Material.Snow);
    expect(patched).toContain(Material.Stone);
  });

  it('makes the whole area again when a change digs below its base', () => {
    const maker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    const before = maker.make(area(...where));
    const r = maker.patch([stroke({ kind: 'lower', x: where[0], z: where[1], amount: 400 })], { x0: where[0] - 30, z0: where[1] - 30, x1: where[0] + 30, z1: where[1] + 30 });
    expect(r && 'base' in r).toBe(true);
    expect((r as MadeArea).base).toBeLessThan(before.base);
  });

  it('patches across the seam of a round world', () => {
    const world: WorldConfig = ROUND_WORLD_16x8KM;
    const cfg = { ...plainTerrain(3, world), rivers: 0, lakes: 0 };
    const W = world.widthUnits / M;
    const maker = new AreaMaker(world, cfg, { minVoxelSize: 1, tolerance: 4 });
    // An area straddling the seam (its corner west of x 0), a stroke just east of the seam's far side.
    maker.make(area(0, 4000));
    const s = [stroke({ x: W - 20, z: 4000 })];
    const p = maker.patch(s, { x0: W - 50, z0: 3970, x1: W + 10, z1: 4030 }) as PatchedArea;
    const fresh = new AreaMaker(world, cfg, { minVoxelSize: 1, tolerance: 4 }).make(area(0, 4000, s));
    expect(p.parts.length).toBeGreaterThan(0);
    expect(p.heights).toEqual(fresh.heights);
  });
  it('plants trees in a patch (crowns spreading past the brush too), as making the area again would', () => {
    // Open grassland (a couple of trees about).
    const land = [13000, 3500] as const;
    const maker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    // (Every 1 m: trees are drawn as themselves.)
    const fine = (s: TerrainStroke[] = []): AreaRequest => ({ ...area(...land, s), size: 192 * M, x0: (land[0] - 96) * M, z0: (land[1] - 96) * M, step: M });
    const before = maker.make(fine());
    // Across a section's edge; the trees' crowns spread past the brush.
    const s = [stroke({ kind: 'plant', x: land[0] - 32 - 3, z: land[1], radius: 10, amount: 1, softness: 0 })];
    const r = maker.patch(s, { x0: land[0] - 45, z0: land[1] - 10, x1: land[0] - 25, z1: land[1] + 10 });
    expect(isPatch(r)).toBe(true);
    const shown = new Map(before.parts.map((q) => [q.key, q]));
    for (const q of (r as PatchedArea).parts) shown.set(q.key, q);
    const fresh = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 }).make(fine(s));
    let changed = 0;
    for (const q of fresh.parts) {
      const was = before.parts.find((b) => b.key === q.key)!;
      if (String(was.ground?.positions) !== String(q.ground?.positions)) changed++;
      expect(shown.get(q.key)!.ground?.positions).toEqual(q.ground?.positions);
    }
    // Trees came up, across two sections at least.
    expect(changed).toBeGreaterThanOrEqual(2);
  });
});

describe('AreaMaker.makeDetail', () => {
  const where = [7000, 7000] as const;
  /** Whether any face but the bottom (any side wall) reaches down to the base (y 0 in a part). */
  const wallToBase = (parts: { ground: { positions: Uint16Array; faces: Uint8Array; quadCount: number } | null }[]) =>
    parts.some((p) => {
      const g = p.ground;
      if (!g) return false;
      for (let q = 0; q < g.quadCount; q++) {
        const dir = g.faces[q * 16]! & 7;
        if (dir === 2 || dir === 3) continue;
        for (let v = 0; v < 4; v++) if (g.positions[(q * 4 + v) * 3 + 1] === 0) return true;
      }
      return false;
    });

  it('makes part of an area finer, in sections lined up with its own, meeting the ground round it (no cut edges)', () => {
    const maker = new AreaMaker(FLAT_WORLD_16KM, dry, { minVoxelSize: 1, tolerance: 4 });
    const coarse = maker.make({ ...area(...where), step: 4 * M });
    // (A whole area is cut off at its edges, down to its base.)
    expect(wallToBase(coarse.parts)).toBe(true);
    const x0 = coarse.x0 + 64 * M, z0 = coarse.z0 + 64 * M;
    const { parts, heights, n } = maker.makeDetail({ x0, z0, size: 128 * M, step: M, base: coarse.base, strokes: [] });
    expect(n).toBe(128);
    expect(heights).toHaveLength(128 * 128);
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => [p.x, p.z]).sort()).toEqual([[x0, z0], [x0, z0 + 64 * M], [x0 + 64 * M, z0], [x0 + 64 * M, z0 + 64 * M]].sort());
    for (const p of parts) expect(p.y).toBe(coarse.base);
    expect(wallToBase(parts)).toBe(false);
    // A sample every metre: far more faces than the coarse sections it stands in for.
    const quads = (ps: typeof parts) => ps.reduce((n, p) => n + (p.ground?.quadCount ?? 0), 0);
    const under = coarse.parts.filter((p) => p.x >= x0 && p.x < x0 + 128 * M && p.z >= z0 && p.z < z0 + 128 * M);
    expect(under).toHaveLength(4);
    expect(quads(parts)).toBeGreaterThan(4 * quads(under));
  });
});
