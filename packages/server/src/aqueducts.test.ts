import { describe, expect, it } from 'vitest';
import { CROP_STAGE_MS, GREENER, Item, Material, RIPE, WATERED_GROWTH, WORLD_SHAPES, defaultPlateTerrain, defaultVoxelize } from '@super-vox/shared';
import { World } from './world.js';
import { generatorFor, worldConfigOf } from './worldFile.js';

const B = 16;
/** A round world with lakes (one's east shore near x 6370 m, z 5488 m: its level 127.7 m). */
function lakeWorld(): World {
  const plates = { ...defaultPlateTerrain(21, WORLD_SHAPES['round-16x8']), lakes: 80 };
  const spec = { generator: 'plates' as const, plates, voxelize: defaultVoxelize(), shape: 'round-16x8' as const };
  const config = worldConfigOf(spec);
  return new World(config, generatorFor(spec, config).generator);
}

describe('aqueducts in a world', () => {
  it('start by a lake (its floor under the water), run while whole, stop at a break, run again mended, and are finished with an outlet', () => {
    const w = lakeWorld();
    // By the sea: its water's salt, no head there.
    expect(w.aqueductIntake(6000, 3000)).toMatch(/the sea/);
    const intake = w.aqueductIntake(6374, 5488);
    if (typeof intake === 'string') throw new Error(intake);
    expect(intake.surface).toBeGreaterThan(127 * B);
    expect(intake.floor).toBeLessThanOrEqual(intake.surface - B);
    // A segment east, falling 1 in 50.
    let told = 0;
    w.onAqueductsChanged = () => void told++;
    const built = w.buildAqueductSegment({ aqueduct: null, from: { bx: 6374, bz: 5488 }, to: { bx: 6434, bz: 5488 }, fall: 1 / 50 });
    if (typeof built === 'string') throw new Error(built);
    const a = built.aqueduct;
    expect(a.cells).toHaveLength(61);
    expect(a.head).toHaveLength(9);
    expect(a.runs).toBe(61);
    expect(told).toBe(1);
    // Built of cobblestone and stone, the channel open.
    const mid = a.cells[30]!, cx = mid.bx * B + 8, cz = mid.bz * B + 8;
    expect(w.materialAtUnit(cx, mid.floor - 2, cz)).toBe(Material.Stone);
    expect(w.materialAtUnit(cx, mid.floor + 4, cz)).toBe(Material.Air);
    expect(w.materialAtUnit(cx, mid.floor + 4, cz - 10)).toBe(Material.Cobblestone);
    // Its floor broken 30 m along: its water reaches that far.
    const broke = w.applyEdit({ op: 'removeBox', x: mid.bx * B + 4, y: mid.floor - 8, z: mid.bz * B + 4, size: 8 });
    expect(w.aqueductsChangedBy(broke)).toBe(true);
    expect(w.aqueductList()[0]!.runs).toBe(30);
    // Mended: running again.
    // (Mended: the four half-metre stones the dig took, put back.)
    let mendedAny = false;
    for (const dx of [0, 8]) for (const dz of [0, 8]) {
      const put = w.applyEdit({ op: 'place', x: mid.bx * B + dx, y: mid.floor - 8, z: mid.bz * B + dz, size: 8, material: Material.Stone });
      if (w.aqueductsChangedBy(put)) mendedAny = true;
    }
    expect(mendedAny).toBe(true);
    expect(w.aqueductList()[0]!.runs).toBe(61);
    // On from its end, then finished: its outlet basin round its end.
    const on = w.buildAqueductSegment({ aqueduct: a.id, from: { bx: 0, bz: 0 }, to: { bx: 6434, bz: 5520 }, fall: 1 / 50 });
    if (typeof on === 'string') throw new Error(on);
    expect(on.aqueduct.cells.length).toBe(61 + 32);
    const done = w.finishAqueduct(a.id);
    if (typeof done === 'string') throw new Error(done);
    expect(done.aqueduct.finished).toBe(true);
    expect(done.aqueduct.outlet).toHaveLength(9);
    expect(done.aqueduct.runs).toBe(93);
    expect(w.buildAqueductSegment({ aqueduct: a.id, from: { bx: 0, bz: 0 }, to: { bx: 6500, bz: 5520 }, fall: 1 / 50 })).toMatch(/finished/);

    // The land round its outlet, watered: a block of dirt there tilled and sown grows half again as fast.
    const end = done.aqueduct.cells.at(-1)!, fx = end.bx + 4, fz = end.bz + 4;
    const top = (bx: number, bz: number) => {
      for (let y = 140; y > 100; y--) {
        const m = w.materialAtUnit(bx * B + 8, y * B + 8, bz * B + 8);
        if (m !== undefined && m !== Material.Air) return y;
      }
      throw new Error('no ground');
    };
    /** A block of `m` put on the ground at (bx, bz), whatever's in its way cleared first: its block y. */
    const lay = (bx: number, bz: number, m: number) => {
      const y = top(bx, bz) + 1;
      try {
        w.applyEdit({ op: 'removeBox', x: bx * B, y: y * B, z: bz * B, size: B });
      } catch {
        // (Nothing there.)
      }
      w.applyEdit({ op: 'place', x: bx * B, y: y * B, z: bz * B, size: B, material: m });
      return y;
    };
    const fy = lay(fx, fz, Material.Dirt);
    expect(Array.isArray(w.till(fx * B + 8, fy * B + 8, fz * B + 8))).toBe(true);
    expect(w.sow(fx * B + 8, fy * B + 8, fz * B + 8, 1000)).toBe(true);
    expect(w.cropList().find(([x, , z]) => x === fx && z === fz)?.[4]).toBe(WATERED_GROWTH);
    const ripe = 1000 + (CROP_STAGE_MS * RIPE) / WATERED_GROWTH;
    expect(w.harvest(fx * B + 8, fy * B + 8, fz * B + 8, ripe - 60_000)).toMatch(/not ripe/);
    expect(w.harvest(fx * B + 8, fy * B + 8, fz * B + 8, ripe)).toBe(true);
    // Sand there takes a sapling; sand far off doesn't.
    const sy = lay(fx + 2, fz, Material.Sand);
    expect(w.plant((fx + 2) * B + 8, sy * B + 8, fz * B + 8, Item.OakSapling, 0)).toBe(true);
    const ay = lay(fx + 60, fz, Material.Sand);
    expect(w.plant((fx + 60) * B + 8, ay * B + 8, fz * B + 8, Item.OakSapling, 0)).toMatch(/only where an aqueduct's outlet waters it/);
    // The ground round it greens, a step at a time.
    let greened = 0;
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 40; i++) {
      const g = w.greenWatered(10, random);
      if (g) greened += g.changes.length;
    }
    expect(greened).toBeGreaterThan(0);
    expect(GREENER[Material.Sand]).toBe(Material.Dirt);
    // Broken: the wheat sown since grows as anywhere.
    w.sow(fx * B + 8, fy * B + 8, fz * B + 8, 2000);
    const cut = done.aqueduct.cells[10]!;
    const broke2 = w.applyEdit({ op: 'removeBox', x: cut.bx * B + 4, y: cut.floor - 8, z: cut.bz * B + 4, size: 8 });
    expect(w.aqueductsChangedBy(broke2)).toBe(true);
    expect(w.cropList().find(([x, , z]) => x === fx && z === fz)?.[4]).toBeUndefined();
  }, 120_000);
});
