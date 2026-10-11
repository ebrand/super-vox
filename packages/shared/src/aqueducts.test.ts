import { describe, expect, it } from 'vitest';
import { AQUEDUCT_DRESSED, AQUEDUCT_FALLS, AQUEDUCT_RUBBLE, aqueductColumns, aqueductCost, aqueductPieces, aqueductWater, channelKeys, channelLine, planAqueduct, poolCells, type Aqueduct, type AqueductPiece, type AqueductShape, type ChannelCell } from './aqueducts.js';

const B = 16;
/** Which material's at a point (units), of pieces; undefined: nothing. */
const at = (pieces: readonly AqueductPiece[], x: number, y: number, z: number) =>
  pieces.find((p) => x >= p.x && x < p.x + p.size && y >= p.y && y < p.y + p.size && z >= p.z && z < p.z + p.size)?.material;
/** An aqueduct of `cells` (no pools), one straight run end to end, level. */
const straight = (cells: ChannelCell[]): AqueductShape => ({ cells, head: [], outlet: [], legs: [{ first: 0, last: cells.length - 1, fall: 0 }] });
const pieces = (a: AqueductShape, ground: (bx: number, bz: number) => number) => aqueductPieces(aqueductColumns(a), ground);

describe('aqueducts', () => {
  it("a channel's cells share a face each with the next, whichever way it goes", () => {
    for (const [x1, z1] of [[10, 0], [0, -7], [9, 4], [-5, 12], [3, 3]] as const) {
      const line = channelLine(0, 0, x1, z1);
      expect(line[0]).toEqual([0, 0]);
      expect(line.at(-1)).toEqual([x1, z1]);
      for (let i = 1; i < line.length; i++) expect(Math.abs(line[i]![0] - line[i - 1]![0]) + Math.abs(line[i]![1] - line[i - 1]![1])).toBe(1);
    }
  });

  it('falls a quarter metre each time it has fallen a quarter metre, at the slope chosen; refused too high over a valley or too deep into a hill', () => {
    const start: ChannelCell = { bx: 0, bz: 0, floor: 100 * B };
    const flat = () => 90 * B;
    const plan = planAqueduct(start, 250, 0, 1 / 50, flat);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.cells).toHaveLength(251);
    expect(plan.cells.at(-1)!.floor).toBe(95 * B); // (250 m at 1 in 50: 5 m)
    expect(plan.cells.every((c, i) => i === 0 || c.floor <= plan.cells[i - 1]!.floor)).toBe(true);
    expect(plan.maxHeight).toBe(10);
    expect(planAqueduct(start, 10, 0, 1 / 30, flat)).toMatch(/1 in 200/);
    expect(planAqueduct(start, 2, 0, AQUEDUCT_FALLS[0], flat)).toMatch(/too short/);
    expect(planAqueduct(start, 100, 0, AQUEDUCT_FALLS[0], () => 60 * B)).toMatch(/40 m over the ground/);
    expect(planAqueduct(start, 100, 0, AQUEDUCT_FALLS[0], (bx) => (bx > 50 ? 120 * B : 90 * B))).toMatch(/cut 21 m into the ground/);
  });

  it('is built of quarter-metre stone: a dressed floor, walls each side with a coping, the channel open; merged where it can be', () => {
    const cells: ChannelCell[] = Array.from({ length: 12 }, (_, i) => ({ bx: i, bz: 0, floor: 10 * B }));
    const a = straight(cells), { place } = pieces(a, () => 9 * B + 8); // (the ground just under the floor's underside: a low footing)
    const keys = channelKeys(a);
    for (const p of place) {
      expect([4, 8, 16]).toContain(p.size);
      // (On its own grid, however far below zero.)
      for (const v of [p.x, p.y, p.z]) expect(((v % p.size) + p.size) % p.size).toBe(0);
    }
    const mid = 5 * B + 8;
    // The channel open over its floor; its floor dressed stone; walls a metre high each side, topped with dressed stone.
    expect(at(place, mid, 10 * B + 4, 8)).toBeUndefined();
    expect(at(place, mid, 10 * B - 4, 8)).toBe(AQUEDUCT_DRESSED);
    for (const z of [-4, 20]) {
      expect(at(place, mid, 10 * B + 4, z)).toBe(AQUEDUCT_RUBBLE);
      expect(at(place, mid, 10 * B + 14, z)).toBe(AQUEDUCT_DRESSED);
      expect(at(place, mid, 10 * B + 18, z)).toBeUndefined();
    }
    // (1/2 m walls: nothing beyond them.)
    expect(at(place, mid, 10 * B + 4, -12)).toBeUndefined();
    // Each cell's keys: in what's built.
    for (const k of keys.flat()) expect(at(place, k[0], k[1], k[2])).toBeDefined();
    expect(keys[5]).toHaveLength(3); // (its floor, and a wall each side)
  });

  it('stands on piers with arches between them where it is high; a solid footing where it is low', () => {
    const cells: ChannelCell[] = Array.from({ length: 13 }, (_, i) => ({ bx: i, bz: 0, floor: 20 * B }));
    const { place } = pieces(straight(cells), () => 10 * B);
    const z = 8, under = 20 * B - 8 - 4;
    // A pier at the start (0 m) and at 6 m, solid down to the ground; between them, at 3 m, open a metre down.
    expect(at(place, 8, 12 * B, z)).toBe(AQUEDUCT_RUBBLE);
    expect(at(place, 6 * B + 8, 12 * B, z)).toBe(AQUEDUCT_RUBBLE);
    expect(at(place, 3 * B + 8, under, z)).toBeDefined(); // (the arch's crown, right under the floor)
    expect(at(place, 3 * B + 8, 20 * B - 2 * B, z)).toBeUndefined();
    expect(at(place, 3 * B + 8, 12 * B, z)).toBeUndefined();
    // Low: solid all the way.
    const low = pieces(straight(cells), () => 19 * B);
    expect(at(low.place, 3 * B + 8, 19 * B + 4, z)).toBe(AQUEDUCT_RUBBLE);
  });

  it('a pool (a head cistern, an outlet basin) is three by three cells of channel, walled round', () => {
    const pool = poolCells({ bx: 5, bz: 5, floor: 4 * B });
    expect(pool).toHaveLength(9);
    const { place } = pieces({ cells: [pool[4]!], head: pool, outlet: [] }, () => 3 * B);
    expect(at(place, 5 * B + 8, 4 * B + 4, 5 * B + 8)).toBeUndefined();
    expect(at(place, 4 * B - 4, 4 * B + 4, 5 * B + 8)).toBeDefined();
  });

  it('at an angle, follows its line (stepping a quarter metre, not a metre); its water as far as it runs; costed as built', () => {
    // 40 blocks east, 15 south: falling 1 in 20.
    const plan = planAqueduct({ bx: 0, bz: 0, floor: 50 * B }, 40, 15, 1 / 20, () => 40 * B);
    if (typeof plan === 'string') throw new Error(plan);
    const a: Aqueduct = { id: 1, name: 'A', cells: plan.cells, head: [], outlet: [], finished: false, runs: plan.cells.length, legs: [{ first: 0, last: plan.cells.length - 1, fall: 1 / 20 }] };
    const floors = [...new Set(plan.cells.map((c) => c.floor))];
    // (A quarter metre at a time: 2.1 m down over its 42.7 m.)
    expect(floors.every((f, i) => i === 0 || floors[i - 1]! - f === 4)).toBe(true);
    const cols = aqueductColumns(a), { place } = aqueductPieces(cols, () => 40 * B);
    // Across its line, wherever along it: a metre of channel, half a metre of wall each side.
    const len = Math.hypot(40, 15) * B, ux = (40 * B) / len, uz = (15 * B) / len;
    for (const t of [0.2, 0.37, 0.5, 0.81]) {
      const x = 8 + t * 40 * B, z = 8 + t * 15 * B, f = cols.find((c) => c.qx === Math.floor(x / 4) && c.qz === Math.floor(z / 4))!.floor;
      for (const [off, open] of [[0, true], [5, true], [-5, true], [11, false], [-11, false], [18, null], [-18, null]] as const) {
        const px = x - uz * off, pz = z + ux * off, m = at(place, px, f + 4, pz);
        if (open === true) expect(m).toBeUndefined();
        else if (open === false) expect(m).toBe(AQUEDUCT_RUBBLE);
        else expect(at(place, px, f + 4, pz)).toBeUndefined();
      }
    }
    // Its keys: in what's built.
    for (const k of channelKeys(a).flat()) expect(at(place, k[0], k[1], k[2])).toBeDefined();
    // Its water: over its channel, as far as it runs.
    const all = aqueductWater(a), half = aqueductWater({ ...a, runs: 20 });
    expect(all.length).toBeGreaterThan(Math.floor(len / 4) * 4 * 0.9);
    expect(half.length).toBeLessThan(all.length / 2);
    // What it costs: what's built, by volume.
    const cost = aqueductCost(cols, () => 40 * B), built = new Map<number, number>();
    for (const p of place) built.set(p.material, (built.get(p.material) ?? 0) + p.size ** 3);
    expect(cost).toEqual(built);
  });
});
