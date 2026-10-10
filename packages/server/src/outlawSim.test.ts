import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, CAMP_APART_M, CAMP_MAX, MOBS, Material, OUTLAW_FAR_M, OUTLAW_NEAR_M, UNITS_PER_METER, campStage, campfireDesign, designFor, parseDesign, pickDesign, type Outlaw, type VillagePiece } from '@super-vox/shared';
import { DesignLibrary } from './designs.js';
import { OutlawSim, type OutlawMobs, type OutlawWorld } from './outlawSim.js';

const M = UNITS_PER_METER;

/** Flat land at 10 m, 16 km square, a village at (8000, 8000) m; what's built, recorded. */
function world() {
  const built: { clear: VillagePiece[]; place: VillagePiece[] }[] = [];
  let saved: unknown = null;
  const w: OutlawWorld = {
    config: { widthUnits: 16000 * M, depthUnits: 16000 * M },
    terrainAt: () => ({ h: 10 * M, water: false, tree: false, land: true }),
    buildWorks: async (clear, place) => {
      built.push({ clear: [...clear], place: [...place] });
      return [];
    },
    editedNear: () => false,
    settlements: () => [{ x: 8000 * M, z: 8000 * M, village: true }],
    saveOutlaws: (s) => (saved = s),
  };
  return { w, built, saved: () => saved };
}

/** Creatures as MobManager keeps them: just where, and health; `kill` takes one away (as a death would). */
function mobs() {
  const all = new Map<number, { x: number; y: number; z: number; health: number; home: { x: number; z: number } | null }>();
  let next = 1_000_000;
  const m: OutlawMobs & { all: typeof all } = {
    all,
    addOutlaw: (o: Outlaw, home) => {
      const id = next++;
      all.set(id, { x: o.x, y: o.y, z: o.z, health: o.health, home });
      return { id };
    },
    remove: (id) => void all.delete(id),
    get: (id) => all.get(id),
  };
  return m;
}

/** Steps `s` seconds (ten a second) from `t0`, writes done each second. */
async function run(sim: OutlawSim, s: number, t0: number, players: { x: number; z: number }[], m: OutlawMobs): Promise<number> {
  let now = t0;
  for (let i = 0; i < s * 10; i++) {
    now += 100;
    sim.step(0.1, now, players, m);
    if (i % 10 === 0) await sim.written();
  }
  return now;
}

const T0 = 1_800_000_000_000;

describe('outlaws', () => {
  it('loners come (away from villages), drift together, set up a camp (a fire pit, then a lean-to), and take in loners near it', async () => {
    const { w, built } = world(), m = mobs();
    // Two loners, as kept, 20 m apart, far from the village; a third 200 m off.
    const loner = (id: number, x: number, z: number): Outlaw => ({ id, name: `o${id}`, look: '', x: x * M, y: 10 * M, z: z * M, health: 20, camp: null, archer: false });
    let r = 7;
    const random = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    const sim = new OutlawSim(w, { outlaws: [loner(1, 3000, 3000), loner(2, 3020, 3000), loner(3, 3200, 3000)], camps: [], cells: ['1,1', '0,0', '0,1', '1,0', '2,2', '0,2', '2,0', '1,2', '2,1'], next: 10 }, random);
    // (A player far off: they stay records.)
    const far = [{ x: 12000 * M, z: 12000 * M }];
    let now = await run(sim, 5, T0, far, m);
    const camps = sim.list();
    expect(camps).toHaveLength(1);
    const c = camps[0]!;
    expect(Math.hypot(c.x - 8000 * M, c.z - 8000 * M)).toBeGreaterThan(CAMP_APART_M * M);
    expect(c.stage).toBe(1);
    expect(built.some((b) => b.place.some((p) => p.material === Material.TorchFlame) && b.place.some((p) => p.material === Material.Coal))).toBe(true);
    // In time, the lean-to; the third, near enough, joins (and walks over).
    now = await run(sim, 200, now, far, m);
    expect(sim.list()[0]!.stage).toBe(2);
    expect(built.some((b) => b.place.some((p) => p.material === Material.Planks))).toBe(true);
    // (The three: its; and by its fire. Newcomers it's had meanwhile may be on their way.)
    const three = sim.people().filter((o) => o.id <= 3);
    expect(three.every((o) => o.camp === c.id)).toBe(true);
    expect(three.every((o) => Math.hypot(o.x - c.x, o.z - c.z) < 20 * M)).toBe(true);
    expect(m.all.size).toBe(0);
    // (No more in a camp than it holds.)
    expect(sim.people().filter((o) => o.camp === c.id).length).toBeLessThanOrEqual(CAMP_MAX);
  });

  it('near a player, creatures (kept about their camp); killed, gone (and told); the player gone, records again', async () => {
    const { w, saved } = world(), m = mobs();
    const sim = new OutlawSim(w, {
      outlaws: [1, 2].map((id) => ({ id, name: `o${id}`, look: '', x: (3000 + id) * M, y: 10 * M, z: 3000 * M, health: 20, camp: 5, archer: id === 2 })),
      camps: [{ id: 5, name: 'Rookery', x: 3000 * M, y: 10 * M, z: 3000 * M, stage: 2, founded: 0, roam: null }],
      cells: ['1,1', '0,0', '0,1', '1,0', '2,2', '0,2', '2,0', '1,2', '2,1'], next: 10,
      // (No newcomers, no band going off: just these two.)
    }, () => 0.5);
    const deaths: Outlaw[] = [];
    sim.onDeath = (o) => deaths.push(o);
    const near = [{ x: (3000 + OUTLAW_NEAR_M - 20) * M, z: 3000 * M }];
    let now = await run(sim, 1, T0, near, m);
    expect(m.all.size).toBe(2);
    const [first, second] = [...m.all.keys()];
    expect(sim.ofMob(second!)?.archer).toBe(true);
    expect(m.all.get(first!)!.home).toMatchObject({ x: 3000 * M, z: 3000 * M });
    // One killed (its creature gone): dead, told, not a record.
    m.all.get(first!)!.x += 3 * M;
    m.all.delete(first!);
    now = await run(sim, 1, now, near, m);
    expect(deaths.map((o) => o.id)).toEqual([1]);
    expect(sim.people().map((o) => o.id)).toEqual([2]);
    // The other hurt, moved; the player off: a record again, where it was, as hurt as it was (healing).
    m.all.get(second!)!.health = 7;
    m.all.get(second!)!.x = 3010 * M;
    now = await run(sim, 1, now, [{ x: (3000 + OUTLAW_FAR_M + 40) * M, z: 3000 * M }], m);
    expect(m.all.size).toBe(0);
    const o = sim.people()[0]!;
    // (Where it was, and a second's walk on as a record.)
    expect(Math.abs(o.x / M - 3010)).toBeLessThan(2);
    expect(o.health).toBeGreaterThanOrEqual(7);
    expect(o.health).toBeLessThan(MOBS.outlaw.health);
    // Kept, and read again.
    sim.persist();
    const again = new OutlawSim(w, JSON.parse(JSON.stringify(saved())));
    expect(again.people().map((p) => p.name)).toEqual(['o2']);
    expect(again.list().map((c) => c.name)).toEqual(['Rookery']);
    void now;
  });

  it('camp pieces are designs (built in, to change in the designer: flames only there); a camp is built of the one for it', () => {
    const lib = new DesignLibrary(null, true);
    expect(lib.list().map((d) => d.role).sort()).toEqual(['campfire', 'cottage', 'lean-to', 'railway-station']);
    expect(designFor('campfire')?.id).toBe('outlaw-campfire');
    // (Flames: not for objects of their own.)
    expect(parseDesign({ ...campfireDesign(), id: 'lamp', role: undefined, item: 20000 })).toMatch(/flames are only for what the game builds/);
    // Built of it: its voxels, where its frame says (its middle the fire's; y 0 the ground's top block).
    const B = BLOCK_SIZE, ground = () => 10;
    const { clear, place } = campStage(100, 200, 1, ground, designFor('campfire'));
    expect(place).toHaveLength(designFor('campfire')!.states[0]!.voxels.length);
    expect(place.find((p) => p.material === Material.Coal)).toMatchObject({ x: 100 * B, y: 9 * B, z: 200 * B, size: B });
    expect(place.filter((p) => p.material === Material.TorchFlame).every((p) => p.y >= 10 * B && p.size < B)).toBe(true);
    // (Its coal's block cleared first: it's in the ground.)
    expect(clear.some((c) => c.x === 100 * B && c.y === 9 * B && c.z === 200 * B)).toBe(true);
    // Another campfire designed: camps are one or the other.
    lib.put({ ...campfireDesign(), id: 'big-fire', name: 'Big fire' });
    const picks = new Set(Array.from({ length: 30 }, (_, i) => pickDesign('campfire', i)?.id));
    expect(picks).toEqual(new Set(['outlaw-campfire', 'big-fire']));
  });
});
