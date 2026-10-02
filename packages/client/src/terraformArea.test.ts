import { describe, expect, it } from 'vitest';
import { FLAT_WORLD_16KM, Material, ROUND_WORLD_16x8KM, defaultPlateTerrain, type TerrainStroke, type WorldConfig } from '@super-vox/shared';
import { AreaMaker, type AreaRequest, type MadeArea, type PatchedArea } from './terraformArea.js';

const M = 16;
const dry = { ...defaultPlateTerrain(9), rivers: 0, lakes: 0 };
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
    // 64 m sections of a 256 m area: 16; a 60 m box touches 2 x 2 of them at most.
    expect(p.parts.length).toBeGreaterThan(0);
    expect(p.parts.length).toBeLessThanOrEqual(4);
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
    const cfg = { ...defaultPlateTerrain(3, world), rivers: 0, lakes: 0 };
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
});
