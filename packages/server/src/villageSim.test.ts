import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cottageDesign, oldCottageDesign, parseDesign, designedCottage, BLOCK_VOLUME, CROP_STAGE_MS, FORGIVE_MS, FOUNDERS, HURT_GRUDGE_MS, Item, KILL_GRUDGE_MS, START_COINS, VILLAGER_DAMAGE, VILLAGER_ENTITY, VILLAGER_HEALTH, villageOffers, GATES, Material, RIPE, UNITS_PER_METER, WALL_AT, WALL_M, WALL_SECTIONS, cottageStage, cropStage, inGate, villagePlot, wallStage, VILLAGER_SEAT, type Station, type VillagePiece } from '@super-vox/shared';
import { VillageSim, type VillageWorld } from './villageSim.js';
import { DesignLibrary } from './designs.js';
import { TrainYard } from './trainYard.js';

const M = UNITS_PER_METER;
/**
 * When the simulations here start (ms): fixed, as villagers' choices are seeded by the time (a start
 * of Date.now() was a different run every time, and some failed). These two each made villagers
 * stick fast: by rail, against a cottage they were to go round; walling, on the wall's line, built
 * where they stood.
 */
const T0 = 1_800_000_000_000, T0_WALL = 1_800_000_555_000;

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
    // (What's written into the world, done between steps, as the server's would be.)
    if (i % 10 === 0) await sim.written();
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

  it('a wall round a village: its ring in sections, but its two gates', () => {
    const all = Array.from({ length: WALL_SECTIONS }, (_, k) => wallStage(1000, 1000, k, () => 10).place);
    const cols = new Set(all.flat().map((p) => `${p.x / 16},${p.z / 16}`));
    // (Each column four blocks: one in the ground, three up.)
    expect(all.flat().length).toBe(cols.size * 4);
    for (const key of cols) {
      const [x, z] = key.split(',').map(Number);
      expect(Math.abs(Math.hypot(x! + 0.5 - 1000.5, z! + 0.5 - 1000.5) - WALL_M)).toBeLessThan(0.51);
    }
    // At its gates: nothing.
    for (const g of GATES) {
      const x = Math.floor(1000.5 + Math.cos(g) * WALL_M), z = Math.floor(1000.5 + Math.sin(g) * WALL_M);
      expect(cols.has(`${x},${z}`)).toBe(false);
    }
    expect(all.every((s) => s.length > 0)).toBe(true);
  });

  it('a village of WALL_AT walls itself round, a section at a time; villagers walk in by its gates', async () => {
    const { w, built } = world();
    // A village of 14, its cottages and fields done (as kept), and someone outside it.
    const cottages = Array.from({ length: 7 }, (_, n) => ({ ...villagePlot(8000, 8000, n).cottage, floor: 11, stage: 3, work: 0 }));
    const fields = Array.from({ length: 7 }, (_, n) => ({ ...villagePlot(8000, 8000, n).field, tops: Array(30).fill(10), sown: Array(30).fill(T0_WALL), tilled: true }));
    const villagers = Array.from({ length: WALL_AT }, (_, i) => ({ id: i + 1, name: `v${i}`, look: '', x: 8000.5 * M + i * M, y: 10 * M, z: 8000.5 * M, yaw: 0, home: 100 }));
    const outside = { id: 50, name: 'out', look: '', x: 8000.5 * M + 45 * M, y: 10 * M, z: 8000.5 * M + 10 * M, yaw: 0, home: 100 };
    const raw = { villagers: [...villagers, outside], villages: [{ id: 100, name: 'Walled', x: 8000.5 * M, y: 10 * M, z: 8000.5 * M, founded: 0, cottages, fields, wheat: 0, stock: { wood: 0, planks: 0, cobble: 1000 } }], cells: ['4,4', '3,3', '3,4', '4,3', '5,5', '3,5', '5,3', '4,5', '5,4'], next: 200 };
    const sim = new VillageSim(w, raw);
    let now = T0_WALL;
    for (let i = 0; i < 120 && (sim.list()[0]!.wall ?? 0) < WALL_SECTIONS; i++) now = await run(sim, 60, now, [{ x: 8000 * M, z: 8000 * M }]);
    expect(sim.list()[0]!.wall).toBe(WALL_SECTIONS);
    expect(built.filter((b) => b.place.some((p) => p.material === Material.Cobblestone)).length).toBeGreaterThanOrEqual(WALL_SECTIONS);
    // Someone outside (the village as kept, them put outside it) comes in (home, at night): by a gate, never through the wall.
    const kept = JSON.parse(JSON.stringify(sim.save()));
    Object.assign(kept.villagers.find((p: { name: string }) => p.name === 'out'), { x: 8000.5 * M + 45 * M, z: 8000.5 * M + 10 * M });
    const walled = new VillageSim(w, kept);
    const at = () => walled.near(8000 * M, 8000 * M, 200 * M).find((e) => e.name === 'out')!;
    let crossed = 0;
    for (let i = 0; i < 1200; i++) {
      const before = at();
      now = await run(walled, 0.1, now, [{ x: 8000 * M, z: 8000 * M }], true);
      const after = at(), r0 = Math.hypot(before.x / M - 8000.5, before.z / M - 8000.5), r1 = Math.hypot(after.x / M - 8000.5, after.z / M - 8000.5);
      if ((r0 - WALL_M) * (r1 - WALL_M) <= 0 && r0 !== r1) {
        crossed++;
        expect(inGate(Math.atan2(after.z / M - 8000.5, after.x / M - 8000.5))).toBe(true);
      }
    }
    expect(crossed).toBeGreaterThan(0);
    expect(Math.hypot(at().x / M - 8000.5, at().z / M - 8000.5)).toBeLessThan(WALL_M);
  });

  it('by rail: villagers go on trips by a line (aboard, off at the other end, home again); wheat sent off and sold for the village', async () => {
    const { w } = world();
    // Track east from a village at x 8000 m to a trading post at 8600 m; a station by each; a line between them.
    const n = 700, points = Array.from({ length: n + 1 }, (_, i) => ({ x: (7950 + i) * M, y: 10 * M, z: 8040 * M, heading: -Math.PI / 2, s: i * M }));
    const yard = new TrainYard();
    yard.setTracks([{ id: 1, points, speed: 60, radius: null, columns: [] }]);
    const home = yard.placeStation(8000 * M, 10 * M, 8042 * M, 'Home') as Station, far = yard.placeStation(8600 * M, 10 * M, 8042 * M, 'Far') as Station;
    yard.place('engine', 8000 * M, 10 * M, 8040 * M, -Math.PI / 2);
    yard.place('passenger', 7987 * M, 10 * M, 8040 * M, -Math.PI / 2);
    yard.place('flatbed', 7974 * M, 10 * M, 8040 * M, -Math.PI / 2);
    // (Coupled: pushed together, as players do.)
    expect(yard.list().length).toBe(3);
    const trains = yard.list();
    void trains;
    w.rail = {
      stations: () => yard.stationList().map((st) => ({ id: st.id, name: st.name, ...yard.stationAt(st.id)! })),
      lines: () => yard.lineList(),
      platformAt: (id) => yard.platformAt(id),
      stoppedAt: (id, now) => yard.stoppedAt(id, now),
      seat: (t, who) => yard.seat(t, who),
      seatPose: (who) => yard.seatPose(who),
      trainOfSeat: (who) => yard.trainOfSeat(who),
      unseat: (who) => yard.unseat(who),
      ship: (t, v, k) => yard.ship(t, v, k),
      unship: (t) => yard.unship(t),
      posts: () => [{ x: 8610 * M, z: 8050 * M, wheat: 0.25 }],
    };
    // A village of eight by the first station, its fields sown (nothing ripe yet), wheat in store.
    const villagers = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `v${i}`, look: '', x: (8000 + i) * M, y: 10 * M, z: 8000 * M, yaw: 0, home: 100 }));
    const cottages = Array.from({ length: 4 }, (_, k) => ({ ...villagePlot(8000, 8000, k).cottage, floor: 11, stage: 3, work: 0 }));
    const fields = Array.from({ length: 4 }, (_, k) => ({ ...villagePlot(8000, 8000, k).field, tops: Array(30).fill(10), sown: Array(30).fill(T0), tilled: true }));
    const sim = new VillageSim(w, { villagers, villages: [{ id: 100, name: 'Home', x: 8000.5 * M, y: 10 * M, z: 8000.5 * M, founded: 0, cottages, fields, wheat: 60 }], cells: ['4,4', '3,3', '3,4', '4,3', '5,5', '3,5', '5,3', '4,5', '5,4'], next: 200 });
    // Coupled by hand: the engine nudged back into them.
    let now = T0;
    const e = yard.list().find((t) => t.cars[0]!.kind === 'engine')!.cars[0]!;
    yard.board(e.id, 7);
    yard.drive(7, -0.15, false, false);
    for (let i = 0; i < 20 * 60 && yard.list().length > 1; i++) yard.step(0.05, false, (now += 50));
    yard.drive(7, 0, true, false);
    for (let i = 0; i < 20 * 20; i++) yard.step(0.05, false, (now += 50));
    yard.leave(7);
    expect(yard.list()).toHaveLength(1);
    const line = yard.createLine([home.id, far.id], 30, 'Main');
    if (typeof line === 'string') throw new Error(line);
    // Run both, an hour.
    let rode = 0, sold = false;
    for (let i = 0; i < 20 * 3600; i++) {
      now += 50;
      yard.step(0.05, false, now);
      if (i % 2 === 0) sim.step(0.1, now, [{ x: 8000 * M, z: 8000 * M }], false);
      if (i % 200 === 0) {
        rode = Math.max(rode, yard.list()[0]!.cars.flatMap((c) => c.seats ?? []).filter((x) => x !== null && x >= VILLAGER_SEAT).length);
        if ((sim.list()[0]!.coins ?? 0) > 0) sold = true;
      }
    }
    const v = sim.list()[0]!;
    expect(v.wheat).toBeLessThan(60);
    expect(sold).toBe(true);
    expect(rode).toBeGreaterThan(0);
    void far;
  }, 60_000);
});
/** A hamlet of three by (8000, 8000) m, its first cottage not begun, and what it has to build with. */
function hamlet(stock: { wood: number; planks: number; cobble: number }, extra: Record<string, unknown> = {}) {
  const villagers = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `v${i}`, look: '', x: (8000 + i) * M, y: 10 * M, z: 8000 * M, yaw: 0, home: 100 }));
  const cottages = [{ ...villagePlot(8000, 8000, 0).cottage, floor: 11, stage: 0, work: 0 }];
  const fields = [{ ...villagePlot(8000, 8000, 0).field, tops: Array(30).fill(10), sown: Array(30).fill(0), tilled: false }];
  return { villagers, villages: [{ id: 100, name: 'Small', x: 8000.5 * M, y: 10 * M, z: 8000.5 * M, founded: 0, cottages, fields, wheat: 0, coins: START_COINS, stock, ...extra }], cells: ['4,4', '3,3', '3,4', '4,3', '5,5', '3,5', '5,3', '4,5', '5,4'], next: 200 };
}
const pieces = (built: { place: VillagePiece[] }[], m: number) => built.flatMap((b) => b.place).filter((p) => p.material === m).length;

describe('villages watched and not', () => {
  it('watched: builders put a piece in at a time, from their stock (out of it, they wait), walking to each', async () => {
    const { w, built } = world();
    const sim = new VillageSim(w, hamlet({ wood: 0, planks: 0, cobble: 0 }));
    const here = [{ x: 8000 * M, z: 8000 * M }];
    let now = await run(sim, 120, T0, here);
    expect(sim.isWatched(100)).toBe(true);
    // (No planks but what they've gathered in two minutes: a few pieces at most.)
    expect(pieces(built, Material.Planks)).toBeLessThanOrEqual(3);
    expect(sim.list()[0]!.cottages[0]!.stage).toBe(0);
    // Given planks and wood (as a player selling them would): built, one piece to each write.
    sim.bought(sim.list()[0]!, Material.Planks, 100 * BLOCK_VOLUME, 0, BLOCK_VOLUME);
    sim.bought(sim.list()[0]!, Material.Wood, 30 * BLOCK_VOLUME, 0, BLOCK_VOLUME);
    const before = sim.near(8000 * M, 8000 * M, 100 * M).map((e) => [e.x, e.z]);
    now = await run(sim, 600, now, here);
    expect(sim.list()[0]!.cottages[0]!.stage).toBe(3);
    const writes = built.filter((b) => b.place.length && b.place[0]!.material !== Material.Farmland);
    expect(writes.length).toBeGreaterThan(40);
    expect(writes.every((b) => b.place.length === 1)).toBe(true);
    // (They moved about to do it.)
    expect(sim.near(8000 * M, 8000 * M, 100 * M).map((e) => [e.x, e.z])).not.toEqual(before);
    // Its stock used: a block each (but thatch: straw).
    const v = sim.list()[0]!;
    expect(v.stock!.planks).toBeLessThan(100 - 40);
  });

  it("unwatched: built on in batches, its fields worked, its villagers where they were; caught up with after time away (kept too)", async () => {
    const { w, built, saved } = world();
    const sim = new VillageSim(w, hamlet({ wood: 100, planks: 200, cobble: 100 }));
    const far = [{ x: 3000 * M, z: 3000 * M }];
    const at = () => sim.near(8000 * M, 8000 * M, 100 * M).filter((e) => e.home === 100).map((e) => [e.x, e.z]);
    const before = at();
    let now = await run(sim, 300, T0, far);
    expect(sim.isWatched(100)).toBe(false);
    expect(sim.list()[0]!.cottages[0]!.stage).toBe(3);
    expect(sim.list()[0]!.fields[0]!.tilled).toBe(true);
    expect(at()).toEqual(before);
    expect(built.some((b) => b.place.filter((p) => p.material !== Material.Farmland).length > 1)).toBe(true);
    // Kept, then nobody here for two hours: on again, it's caught up (wheat grown and harvested, many times over).
    sim.persist();
    const again = new VillageSim(w, JSON.parse(JSON.stringify(saved())));
    now += 2 * 3600_000;
    await run(again, 1, now, far);
    const v = again.list()[0]!, members = again.near(8000 * M, 8000 * M, 400 * M).filter((e) => e.home === 100).length;
    // (30 blocks, ten harvests each: some of it into newcomers.)
    expect(v.wheat + (members - 3) * 36).toBeGreaterThan(200);
    expect(v.fields[0]!.sown.every((s) => now - s < CROP_STAGE_MS * RIPE)).toBe(true);
    // A hamlet kept as it was, its cottage not begun: after two hours away, it's built (a second's
    // stepping, without catching up, would put in two pieces).
    const fresh = new VillageSim(w, { ...hamlet({ wood: 100, planks: 200, cobble: 100 }), at: T0 });
    await run(fresh, 1, T0 + 2 * 3600_000, far);
    expect(fresh.list()[0]!.cottages[0]!.stage).toBe(3);
  });

  it('trade: sells wheat it has over what it keeps, and bread; buys materials and tools with its coins, as it has room and wants', () => {
    const { w } = world();
    const sim = new VillageSim(w, hamlet({ wood: 0, planks: 0, cobble: 0 }, { wheat: 32, coins: 20 }));
    const v = sim.list()[0]!;
    const { sells, buys } = villageOffers(v);
    // Wheat over the 12 kept: 20 bundles, five lots of four; six loaves.
    expect(sells.find((o) => o.item === Item.Wheat)).toMatchObject({ lot: 4, most: 5 });
    expect(sells.find((o) => o.item === Item.Bread)).toMatchObject({ lot: 1, most: 6 });
    // Short of wood: two copper a block; 20 coins: ten lots at most.
    expect(buys.find((o) => o.item === Material.Wood)).toMatchObject({ lot: BLOCK_VOLUME, price: 2, most: 10 });
    expect(buys.find((o) => o.item === Item.IronAxe)).toMatchObject({ price: 8, most: 2 });
    sim.sold(v, Item.Wheat, 2, 4);
    expect(v.wheat).toBe(24);
    expect(v.coins).toBe(24);
    sim.bought(v, Material.Wood, 40 * BLOCK_VOLUME, 20, BLOCK_VOLUME);
    expect(v.stock!.wood).toBe(40);
    expect(v.coins).toBe(4);
    // Plenty of wood now (over twice what it wants): it pays less; and it can't afford tools.
    const after = villageOffers(v);
    expect(after.buys.find((o) => o.item === Material.Wood)!.price / (after.buys.find((o) => o.item === Material.Wood)!.lot / BLOCK_VOLUME)).toBeLessThan(2);
    expect(after.buys.find((o) => o.item === Item.IronAxe)!.most).toBe(0);
    // Sold an axe: it gathers faster.
    v.coins = 8;
    sim.bought(v, Item.IronAxe, 1, 8, BLOCK_VOLUME);
    expect(v.tools).toEqual({ axes: 1, picks: 0 });
    expect(sim.villagerOf(VILLAGER_ENTITY + 1)?.village.id).toBe(100);
    expect(sim.villagerOf(VILLAGER_ENTITY + 99)).toBeNull();
  });
});

/** A hamlet of `n` by (8000, 8000) m, its cottages built, fields tilled and growing (nothing ripe). */
function settled(n: number) {
  const villagers = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `v${i}`, look: '', x: (8000 + (i % 3)) * M, y: 10 * M, z: (8000 + Math.floor(i / 3)) * M, yaw: 0, home: 100 }));
  const k = Math.ceil(n / 2);
  const cottages = Array.from({ length: k }, (_, j) => ({ ...villagePlot(8000, 8000, j).cottage, floor: 11, stage: 3, work: 0 }));
  const fields = Array.from({ length: k }, (_, j) => ({ ...villagePlot(8000, 8000, j).field, tops: Array(30).fill(10), sown: Array(30).fill(T0), tilled: true }));
  return { villagers, villages: [{ id: 100, name: 'Holdfast', x: 8000.5 * M, y: 10 * M, z: 8000.5 * M, founded: 0, cottages, fields, wheat: 0, coins: 30, stock: { wood: 0, planks: 0, cobble: 0 } }], cells: ['4,4', '3,3', '3,4', '4,3', '5,5', '3,5', '5,3', '4,5', '5,4'], next: 200 };
}

describe('villagers hurt, and fighting', () => {
  it('hurt by a player: their village holds it against them (killed, far longer); killing outlaws near it, a little less', () => {
    const { w } = world();
    const sim = new VillageSim(w, settled(3));
    const v = sim.list()[0]!, from = { x: 7990 * M, z: 8000 * M };
    expect(sim.hurtVillager(VILLAGER_ENTITY + 1, 4, from, 'ann', T0)).toMatchObject({ killed: false, name: 'v0' });
    expect(sim.grudge(v, 'ann', T0)).toBe(HURT_GRUDGE_MS);
    expect(sim.grudge(v, 'bob', T0)).toBe(0);
    expect(sim.near(8000 * M, 8000 * M, 50 * M).find((e) => e.name === 'v0')).toMatchObject({ health: VILLAGER_HEALTH - 4, max: VILLAGER_HEALTH });
    // Killed (hit enough): gone, and the grudge far longer.
    expect(sim.hurtVillager(VILLAGER_ENTITY + 2, VILLAGER_HEALTH, from, 'ann', T0)).toMatchObject({ killed: true, name: 'v1' });
    expect(sim.population).toBe(2);
    expect(sim.villagerOf(VILLAGER_ENTITY + 2)).toBeNull();
    expect(sim.grudge(v, 'ann', T0)).toBe(HURT_GRUDGE_MS + KILL_GRUDGE_MS);
    // An outlaw killed by them near the village: less; far off: no different.
    sim.forgive('ann', 8010 * M, 8000 * M, T0);
    expect(sim.grudge(v, 'ann', T0)).toBe(HURT_GRUDGE_MS + KILL_GRUDGE_MS - FORGIVE_MS);
    sim.forgive('ann', 9000 * M, 8000 * M, T0);
    expect(sim.grudge(v, 'ann', T0)).toBe(HURT_GRUDGE_MS + KILL_GRUDGE_MS - FORGIVE_MS);
    // (Not hurt by anyone in particular: no grudge.)
    sim.hurtVillager(VILLAGER_ENTITY + 3, 1, from, null, T0);
    expect(Object.keys(v.grudges!)).toEqual(['ann']);
  });

  it('an outlaw at the village: the first four fight it (hitting it once in reach), the rest run home; a player it holds a grudge against too', async () => {
    const { w } = world();
    const sim = new VillageSim(w, settled(6));
    const here = [{ x: 8000 * M, z: 8000 * M }];
    const outlaw = { id: 1_000_123, x: 8005 * M, z: 8003 * M, outlaw: true, vulnerable: true };
    const hits: { target: number; damage: number }[] = [];
    let now = T0;
    for (let i = 0; i < 100; i++) {
      now += 100;
      sim.step(0.1, now, here, false, [outlaw]);
      hits.push(...sim.hits);
    }
    const fighters = sim.near(8000 * M, 8000 * M, 100 * M).filter((e) => Math.hypot(e.x - outlaw.x, e.z - outlaw.z) < 2 * M);
    expect(fighters.map((e) => e.name).sort()).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(hits.length).toBeGreaterThan(8);
    expect(hits.every((h) => h.target === outlaw.id && h.damage === VILLAGER_DAMAGE)).toBe(true);
    // (The other two: off home, away from it.)
    const rest = sim.near(8000 * M, 8000 * M, 100 * M).filter((e) => e.name === 'v4' || e.name === 'v5');
    expect(rest.every((e) => Math.hypot(e.x - outlaw.x, e.z - outlaw.z) > 3 * M)).toBe(true);
    // Creatures see them all (to go for).
    expect(sim.targets().map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5, 6].map((i) => VILLAGER_ENTITY + i));
    // A player they hold a grudge against, near: fought too; one who can't be hurt (creative), not.
    sim.hurtVillager(VILLAGER_ENTITY + 6, 1, { x: 8000 * M, z: 8000 * M }, 'ann', now);
    const ann = { id: 7, x: 8001 * M, z: 8004 * M, outlaw: false, account: 'ann', vulnerable: true };
    const onAnn: number[] = [];
    for (let i = 0; i < 60; i++) {
      now += 100;
      sim.step(0.1, now, here, false, [ann]);
      onAnn.push(...sim.hits.filter((h) => h.target === 7).map((h) => h.damage));
    }
    expect(onAnn.length).toBeGreaterThan(3);
    const spared: number[] = [];
    for (let i = 0; i < 60; i++) {
      now += 100;
      sim.step(0.1, now, here, false, [{ ...ann, vulnerable: false }]);
      spared.push(...sim.hits.map((h) => h.damage));
    }
    expect(spared).toHaveLength(0);
    // Nor a player they hold nothing against.
    for (let i = 0; i < 60; i++) {
      now += 100;
      sim.step(0.1, now, here, false, [{ ...ann, id: 8, account: 'bob' }]);
      spared.push(...sim.hits.map((h) => h.damage));
    }
    expect(spared).toHaveLength(0);
  });
});

describe('walking round cottages', () => {
  it('one at a corner of a cottage, what they want beyond it: round it, not stuck at that corner', async () => {
    const { w } = world();
    const raw = settled(1);
    const c = raw.villages[0]!.cottages[0]!;
    // At its far corner (a little out from it, as walkers going round stop), an outlaw across it.
    const corner = { x: (c.bx + c.w) * M + 1.2 * M, z: (c.bz + c.d) * M + 1.2 * M };
    Object.assign(raw.villagers[0]!, corner);
    const sim = new VillageSim(w, raw);
    const outlaw = { id: 1_000_777, x: (c.bx - 1.5) * M, z: (c.bz - 1.5) * M, outlaw: true, vulnerable: true };
    let now = T0, hits = 0;
    for (let i = 0; i < 300 && !hits; i++) {
      now += 100;
      sim.step(0.1, now, [{ x: 8000 * M, z: 8000 * M }], false, [outlaw]);
      hits += sim.hits.length;
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('cottages of designs', () => {

  it('on a hillside (the ground known a 4 m square at a time, for walking): built sitting on the ground at its lowest point under it (as it is, not as the 4 m squares have it), no footing', async () => {
    new DesignLibrary(null, true);
    // (Rising an eighth of a metre a metre eastward, in whole units, as the generator's heights are.)
    const h = (x: number) => 10 * M + Math.floor((x - 7990 * M) / 8);
    const { w, built } = world();
    w.terrainAt = (x) => ({ h: h(x), water: false, tree: false, land: true });
    const raw = hamlet({ wood: 200, planks: 400, cobble: 400 });
    raw.villages[0]!.cottages = [];
    raw.villages[0]!.fields = [];
    const sim = new VillageSim(w, raw);
    const here = [{ x: 8000 * M, z: 8000 * M }];
    let now = await run(sim, 5, T0, here);
    const c = () => sim.list()[0]!.cottages[0]!;
    expect(c().design).toBe('thatched-cottage');
    for (let i = 0; i < 30 && c().stage < 3; i++) now = await run(sim, 60, now, here);
    const { bx, bz, stage } = c();
    expect(stage).toBe(3);
    // (Its own pieces: it may have more cottages since.)
    const solid = built.flatMap((b) => b.place).filter((p) => p.material !== Material.Farmland && p.x >= (bx - 1) * 16 && p.x < (bx + c().w + 1) * 16 && p.z >= (bz - 1) * 16 && p.z < (bz + c().d + 1) * 16);
    expect(solid.length).toBeGreaterThan(1000);
    expect(solid.some((p) => p.material === Material.Cobblestone)).toBe(false);
    // Its bottom: the ground's lowest under it (its west edge), to the quarter metre down.
    expect(Math.min(...solid.map((p) => p.y))).toBe(Math.floor(h(bx * 16) / 4) * 4);
    // The ground over that in its footprint dug away (up hill, its east side: a metre of it).
    const clear = built.flatMap((b) => b.clear);
    const cleared = (x: number, y: number, z: number) => clear.some((p) => p.x <= x && x < p.x + p.size && p.z <= z && z < p.z + p.size && p.y <= y && y < p.y + p.size);
    const east = (bx + c().w) * 16 - 1;
    for (let y = Math.min(...solid.map((p) => p.y)); y < h(east); y += 4) expect(cleared(east, y, bz * 16 + 8)).toBe(true);
  });

  it("a village's cottages are its designs (one of them each, turned to face the middle), built a block's worth at a time from the bottom, from its stock", async () => {
    // The built-in thatched cottage, and a hut of quarter voxels (a 1 m block of them: one piece).
    const lib = new DesignLibrary(null, true);
    const q = 4, voxels = [] as { x: number; y: number; z: number; size: number; material: number }[];
    for (let x = 0; x < 16; x += q) for (let y = 0; y < 16; y += q) for (let z = 0; z < 16; z += q) voxels.push({ x: 16 + x, y, z: 16 + z, size: q, material: Material.Planks });
    voxels.push({ x: 0, y: 0, z: 0, size: 16, material: Material.Thatch });
    expect(lib.put({ id: 'hut', name: 'Hut', size: [3, 2, 3], states: [{ name: 'built', voxels }], recipe: null, role: 'cottage' })).toMatchObject({ id: 'hut' });
    const { w, built } = world();
    const raw = hamlet({ wood: 200, planks: 400, cobble: 100 });
    raw.villages[0]!.cottages = [];
    raw.villages[0]!.fields = [];
    const sim = new VillageSim(w, raw);
    const here = [{ x: 8000 * M, z: 8000 * M }];
    let now = await run(sim, 5, T0, here);
    const v = sim.list()[0]!;
    expect(v.cottages).toHaveLength(1);
    const c = v.cottages[0]!;
    expect(['thatched-cottage', 'hut']).toContain(c.design);
    // (Sized as the design turned for its door.)
    const span = c.design === 'hut' ? [3, 3] : c.door % 2 === 0 ? [7, 6] : [6, 7];
    expect([c.w, c.d]).toEqual(span);
    now = await run(sim, 600, now, here);
    expect(c.stage).toBe(3);
    const writes = built.filter((b) => b.place.length && b.place[0]!.material !== Material.Farmland);
    if (c.design === 'hut') {
      // Its quarter voxels a block at a time (64 to the block), its thatch block on its own; the planks' one block from stock.
      expect(writes.some((b) => b.place.length === 64)).toBe(true);
      expect(400 + 6 - v.stock!.planks).toBeGreaterThan(0.99);
    } else {
      expect(writes.every((b) => b.place.length === 1)).toBe(true);
      expect(writes.length).toBeGreaterThan(100);
    }
    // All of it inside a cottage's footprint (it's had more since), on its floor and up.
    const B = 16, pieces = writes.flatMap((b) => b.place);
    const inside = (p: VillagePiece) => v.cottages.some((k) => p.x >= k.bx * B && p.x < (k.bx + k.w) * B && p.z >= k.bz * B && p.z < (k.bz + k.d) * B && p.y >= (k.floor - 1) * B);
    expect(pieces.every(inside)).toBe(true);
    // Another village's plots: both designs used (by the plot).
    const used = new Set<string>();
    for (let id = 1; id < 40 && used.size < 2; id++) {
      const r = hamlet({ wood: 200, planks: 400, cobble: 100 });
      r.villages[0]!.id = id;
      r.villagers.forEach((p) => (p.home = id));
      r.villages[0]!.cottages = [];
      r.villages[0]!.fields = [];
      const s2 = new VillageSim(world().w, r);
      await run(s2, 2, T0, here);
      for (const cc of s2.list()[0]!.cottages) if (cc.design) used.add(cc.design);
    }
    expect(used).toEqual(new Set(['thatched-cottage', 'hut']));
  });

  it('on sloping ground: its bottom on the lowest point under it (to the quarter metre), the ground over that dug out of its footprint, no footing; every piece on its grid; from the bottom up', () => {
    const d = { ...cottageDesign(), item: 20001 };
    const c = { bx: 100, bz: 200, w: 7, d: 6, door: 2 as const, floor: 13, stage: 0, work: 0 };
    // (The ground falls away eastward, 0.7 m a metre: its lowest under the house, under its east column (106), 12 m - 6 * 0.7 - 0.7 = 7.1 m.)
    const at = (x: number) => 12 * M - Math.max(0, Math.min(8 * M, (x - 100 * M) * 0.7));
    const ground = (bx: number) => ({ low: at((bx + 1) * M), high: at(bx * M) });
    const { clear, groups } = designedCottage(c, d, ground);
    const flat = groups.flat(), bottom = Math.floor(at(107 * M) / 4) * 4;
    expect(bottom).toBe(Math.floor((7.1 * M) / 4) * 4);
    expect(Math.min(...flat.map((p) => p.y))).toBe(bottom);
    expect(flat.some((p) => p.material === Material.Cobblestone)).toBe(false);
    // Every piece on its own grid (lifted by quarter metres, blocks cut smaller), none overlapping.
    for (const p of [...flat, ...clear]) expect([p.x % p.size, p.y % p.size, p.z % p.size]).toEqual([0, 0, 0]);
    const seen = new Set<string>();
    for (const p of flat)
      for (let x = 0; x < p.size; x += 4) for (let y = 0; y < p.size; y += 4) for (let z = 0; z < p.size; z += 4) {
        const k = `${p.x + x},${p.y + y},${p.z + z}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    // Its footprint cleared from its bottom up, all of it (up hill, the ground over it: 4.9 m of it at the west).
    for (let x = 100; x < 107; x++)
      for (let z = 200; z < 206; z++)
        for (let y = bottom; y < at(x * M); y += 4) expect(clear.some((p) => p.x <= x * 16 && x * 16 < p.x + p.size && p.z <= z * 16 && z * 16 < p.z + p.size && p.y <= y && y < p.y + p.size), `${x},${z} at ${y}`).toBe(true);
    // Round it, the ground left (only what's over it cleared).
    expect(clear.some((p) => p.x === 99 * 16 && p.y < Math.ceil(at(99 * M) / 16) * 16)).toBe(false);
    // Bottom up, a block's worth at a time: no row before one under it.
    const ys = groups.map((g) => Math.floor(Math.min(...g.map((p) => p.y)) / 16));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(flat.some((p) => p.material === Material.Thatch)).toBe(true);
  });

  it("a design that doesn't start at its bottom (its lowest voxels 1.5 m up): lowered onto the ground", () => {
    const base = { ...cottageDesign(), item: 20002 };
    const d = { ...base, size: [7, 9, 6] as [number, number, number], states: [{ name: 'built', voxels: base.states[0]!.voxels.map((v) => ({ ...v, y: v.y + 24 })) }] };
    const c = { bx: 100, bz: 200, w: 7, d: 6, door: 2 as const, floor: 13, stage: 0, work: 0 };
    const { groups } = designedCottage(c, d, () => ({ low: 12 * M + 6, high: 12 * M + 6 }));
    const flat = groups.flat();
    expect(Math.min(...flat.map((p) => p.y))).toBe(12 * M + 4);
    // (All of it: as many quarter metres as the design has.)
    const volume = (vs: readonly { size: number }[]) => vs.reduce((n, v) => n + v.size ** 3, 0);
    expect(volume(flat)).toBe(volume(base.states[0]!.voxels));
  });

  it('the thatched cottage that comes: in quarter metres, its door open in its front, valid; a library holding the old one (1 m blocks, unchanged) has it replaced, a changed one kept', () => {
    const d = cottageDesign();
    expect(parseDesign({ ...d, item: 20003 })).not.toBeTypeOf('string');
    expect(d.states[0]!.voxels.some((v) => v.size === 4)).toBe(true);
    expect(new Set(d.states[0]!.voxels.map((v) => v.material))).toEqual(new Set([Material.Planks, Material.Wood, Material.Glass, Material.Thatch, Material.StoneBricks, Material.Coal]));
    // (The doorway: air 2 m up in the middle of the front wall (z 5.25..5.5 m, x 3..4 m).)
    const at = (x: number, y: number, z: number) => d.states[0]!.voxels.find((v) => x >= v.x && x < v.x + v.size && y >= v.y && y < v.y + v.size && z >= v.z && z < v.z + v.size);
    expect(at(3.5 * 16, 1 * 16, 5.4 * 16)).toBeUndefined();
    expect(at(2.4 * 16, 1.6 * 16, 5.4 * 16)?.material).toBe(Material.Planks);
    const dir = mkdtempSync(join(tmpdir(), 'designs-')), file = join(dir, 'designs.json');
    for (const [kept, replaced] of [[oldCottageDesign(), true], [{ ...oldCottageDesign(), states: [{ name: 'built', voxels: oldCottageDesign().states[0]!.voxels.slice(1) }] }, false]] as const) {
      writeFileSync(file, JSON.stringify({ designs: [{ ...kept, item: 20500 }], nextItem: 20501 }));
      const lib = new DesignLibrary(file, true), now = lib.get('thatched-cottage')!;
      expect(now.item).toBe(20500);
      expect(now.states[0]!.voxels.length).toBe(replaced ? d.states[0]!.voxels.length : kept.states[0]!.voxels.length);
      // (Kept so: opened again, the same.)
      expect(new DesignLibrary(file, true).get('thatched-cottage')!.states[0]!.voxels.length).toBe(now.states[0]!.voxels.length);
    }
    rmSync(dir, { recursive: true });
  });
});
