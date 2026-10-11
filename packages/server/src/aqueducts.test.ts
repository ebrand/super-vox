import { describe, expect, it } from 'vitest';
import { Material, WORLD_SHAPES, defaultPlateTerrain, defaultVoxelize } from '@super-vox/shared';
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
  }, 120_000);
});
