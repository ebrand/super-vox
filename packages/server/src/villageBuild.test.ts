import { describe, expect, it } from 'vitest';
import { WORLD_SHAPES, cottageDesign, defaultPlateTerrain, defaultVoxelize, designedCottage, designVoxels } from '@super-vox/shared';
import { World } from './world.js';
import { generatorFor, worldConfigOf } from './worldFile.js';

const B = 16;

/** A round world of plates (hills): somewhere a 7 by 6 m site slopes 1.5 to 3 m across, on land. */
function hillside(): { world: World; bx: number; bz: number } {
  const plates = defaultPlateTerrain(21, WORLD_SHAPES['round-16x8']);
  const spec = { generator: 'plates' as const, plates, voxelize: defaultVoxelize(), shape: 'round-16x8' as const };
  const config = worldConfigOf(spec);
  const world = new World(config, generatorFor(spec, config).generator);
  for (let bx = 4000; bx < 12000; bx += 37)
    for (let bz = 3000; bz < 5000; bz += 41) {
      let low = Infinity, high = -Infinity;
      for (let x = bx; x < bx + 7; x++) for (let z = bz; z < bz + 6; z++) {
        const g = world.blockGround(x, z);
        (low = Math.min(low, g.low)), (high = Math.max(high, g.high));
      }
      if (high - low < 1.5 * B || high - low > 3 * B) continue;
      const t = world.terrainAt((bx + 3) * B, (bz + 3) * B);
      if (t.land && !t.water && !t.tree) return { world, bx, bz };
    }
  throw new Error('no hillside');
}

describe('a cottage built into the world', () => {
  it('on a hillside: sat on the ground at its lowest point (nothing under its lowest voxels but ground), the ground over that in its footprint gone', async () => {
    const { world, bx, bz } = hillside();
    const design = cottageDesign(), c = { bx, bz, w: 7, d: 6, door: 0 as const, floor: 0, stage: 0, work: 0 };
    const { clear, groups } = designedCottage(c, design, (x, z) => world.blockGround(x, z));
    await world.buildWorks(clear, groups.flat());
    const mine = new Set(designVoxels(design, 0, 's').map((v) => v.material));
    const bottom = Math.min(...groups.flat().map((p) => p.y));
    let gaps = 0, earth = 0, onGround = 0;
    for (let x = bx * B; x < (bx + 7) * B; x += 4)
      for (let z = bz * B; z < (bz + 6) * B; z += 4) {
        // (Inside the footprint, from its bottom up: the house's, or air; nothing of the ground.)
        for (let y = bottom; y < bottom + 3 * B; y += 4) {
          const m = world.materialAtUnit(x + 2, y + 2, z + 2) ?? 0;
          if (m && !mine.has(m as never)) earth++;
        }
        // (Under its bottom: ground, a quarter metre down.)
        const under = world.materialAtUnit(x + 2, bottom - 2, z + 2) ?? 0;
        if (!under) gaps++;
        else onGround++;
      }
    expect({ earth, gaps }).toEqual({ earth: 0, gaps: 0 });
    expect(onGround).toBe(28 * 24);
  });
});
