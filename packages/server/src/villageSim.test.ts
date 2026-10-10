import { describe, expect, it } from 'vitest';
import { CROP_STAGE_MS, FOUNDERS, Material, RIPE, UNITS_PER_METER, cottageStage, cropStage, villagePlot, type VillagePiece } from '@super-vox/shared';
import { VillageSim, type VillageWorld } from './villageSim.js';

const M = UNITS_PER_METER;

/** Flat land at 10 m everywhere (but a lake, if asked), 16 km square; what's built, recorded. */
function world(lake?: (x: number, z: number) => boolean) {
  const built: { clear: VillagePiece[]; place: VillagePiece[] }[] = [];
  let saved: unknown = null;
  const w: VillageWorld & { saveVillages(s: unknown): void } = {
    config: { widthUnits: 16000 * M, depthUnits: 16000 * M },
    terrainAt: (x, z) => ({ h: 10 * M, water: lake?.(x / M, z / M) ?? false, tree: false, land: true }),
    buildWorks: async (clear, place) => {
      built.push({ clear: [...clear], place: [...place] });
      return [];
    },
    editedNear: () => false,
    saveVillages: (s) => (saved = s),
  };
  return { w, built, saved: () => saved };
}

/** Steps a sim `s` seconds (a tenth at a time), from `t0` (ms); where it got to (ms). */
async function run(sim: VillageSim, s: number, t0: number, players: { x: number; z: number }[], night = false): Promise<number> {
  let now = t0;
  for (let i = 0; i < s * 10; i++) {
    now += 100;
    sim.step(0.1, now, players, night);
    // (Building's done between steps, as the server's would be.)
    if (i % 10 === 0) await Promise.resolve();
  }
  return now;
}

describe('villages', () => {
  it("a cottage's stages: footing and floor, walls (a door and windows left open), a thatched roof", () => {
    const c = { bx: 0, bz: 0, w: 5, d: 4, floor: 12, door: 0 as const, stage: 0, work: 0 };
    const footing = cottageStage(c, 1, () => 10);
    expect(footing.clear.length).toBeGreaterThan(0);
    expect(footing.place.filter((p) => p.material === Material.Planks)).toHaveLength(20);
    expect(footing.place.filter((p) => p.material === Material.Cobblestone)).toHaveLength(20); // (a block under each: ground 10, floor 11)
    const walls = cottageStage(c, 2, () => 10).place;
    // Perimeter 14 blocks, 3 high, less the door (2) and two windows: 39.
    expect(walls).toHaveLength(14 * 3 - 2 - 2);
    expect(walls.filter((p) => p.material === Material.Wood)).toHaveLength(12);
    const roof = cottageStage(c, 3, () => 10).place;
    expect(roof.every((p) => p.material === Material.Thatch)).toBe(true);
    expect(Math.max(...roof.map((p) => p.y))).toBe((12 + 3 + 2) * 16);
    // Plots round a middle: each its door toward it, its field beyond.
    for (let n = 0; n < 6; n++) {
      const { cottage, field } = villagePlot(100, 100, n);
      const mid = { x: cottage.bx + cottage.w / 2, z: cottage.bz + cottage.d / 2 }, fmid = { x: field.bx + field.w / 2, z: field.bz + field.d / 2 };
      expect(Math.hypot(fmid.x - 100, fmid.z - 100)).toBeGreaterThan(Math.hypot(mid.x - 100, mid.z - 100));
    }
    expect(cropStage(0, 1e6)).toBe(-1);
    expect(cropStage(1000, 1000 + CROP_STAGE_MS * 10)).toBe(RIPE);
  });

  it('wanderers come near players, drift together, found a village, build a cottage and work its field; it is theirs', async () => {
    const { w, built, saved } = world();
    const sim = new VillageSim(w);
    const player = { x: 8100 * M, z: 8100 * M };
    let now = await run(sim, 2, 0, [player]);
    expect(sim.population).toBeGreaterThanOrEqual(FOUNDERS);
    // In time (they walk), they meet and found a village.
    for (let i = 0; i < 60 && !sim.list().length; i++) now = await run(sim, 60, now, [player]);
    expect(sim.list().length).toBeGreaterThanOrEqual(1);
    const v = sim.list()[0]!;
    expect(v.cottages).toHaveLength(1);
    // They build it, stage by stage (each written into the world), then till and sow its field.
    for (let i = 0; i < 30 && !v.fields[0]!.tilled; i++) now = await run(sim, 60, now, [player]);
    expect(v.cottages[0]!.stage).toBe(3);
    expect(v.fields[0]!.tilled).toBe(true);
    expect(built.some((b) => b.place.some((p) => p.material === Material.Thatch))).toBe(true);
    expect(built.some((b) => b.place.some((p) => p.material === Material.Farmland))).toBe(true);
    // Ripe in time, harvested (and sown again).
    now = await run(sim, (CROP_STAGE_MS * RIPE) / 1000 + 120, now, [player]);
    expect(v.wheat).toBeGreaterThan(0);
    // Theirs: their land's protected; nearby but not on it, not.
    expect(sim.villageAt(v.x, v.z)?.name).toBe(v.name);
    expect(sim.villageAt(v.x + 200 * M, v.z)).toBeNull();
    // Kept, and read again.
    sim.persist();
    const again = new VillageSim(w, JSON.parse(JSON.stringify(saved())));
    expect(again.list().map((x) => x.name)).toEqual(sim.list().map((x) => x.name));
    expect(again.population).toBe(sim.population);
    expect(again.near(v.x, v.z, 100 * M).map((e) => [e.kind, typeof e.name])).toEqual(again.near(v.x, v.z, 100 * M).map(() => ['villager', 'string']));
    expect(again.near(v.x, v.z, 100 * M).length).toBeGreaterThan(0);
  });

  it("don't walk into water", async () => {
    // A lake east of x 8050 m; a player west of it.
    const { w } = world((x) => x > 8050);
    const sim = new VillageSim(w);
    await run(sim, 300, 0, [{ x: 8000 * M, z: 8000 * M }]);
    for (const e of sim.near(8000 * M, 8000 * M, 3000 * M)) expect(e.x / M).toBeLessThanOrEqual(8050.5);
  });
});
