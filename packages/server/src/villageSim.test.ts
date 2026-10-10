import { describe, expect, it } from 'vitest';
import { BLOCK_VOLUME, CROP_STAGE_MS, FOUNDERS, Item, START_COINS, villageOffers, GATES, Material, RIPE, UNITS_PER_METER, WALL_AT, WALL_M, WALL_SECTIONS, cottageStage, cropStage, inGate, villagePlot, wallStage, VILLAGER_SEAT, type Station, type VillagePiece } from '@super-vox/shared';
import { VillageSim, type VillageWorld } from './villageSim.js';
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
    expect(sim.villagerOf(1_000_000 + 1)?.village.id).toBe(100);
    expect(sim.villagerOf(1_000_000 + 99)).toBeNull();
  });
});
