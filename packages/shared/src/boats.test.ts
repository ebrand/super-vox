import { describe, expect, it } from 'vitest';
import { BOAT, boatHull, getOutAt, stepBoat, waterSurface, type BoatMotion } from './boats.js';
import { Material } from './materials.js';
import type { ObjectDesign } from './designs.js';

/** A 1 x 1 x 2 m rowboat (as drawn: its bow the front, +z): a 1/8 m hull, and a bench across its middle. */
function rowboat(): ObjectDesign {
  const P = Material.Planks, voxels: ObjectDesign['states'][number]['voxels'] = [];
  for (let z = 0; z < 32; z += 2) for (let x = 0; x < 16; x += 2) voxels.push({ x, y: 0, z, size: 2, material: P });
  for (let z = 0; z < 32; z += 2) for (let y = 2; y < 8; y += 2) for (const x of [0, 14]) voxels.push({ x, y, z, size: 2, material: P });
  for (let x = 2; x < 14; x += 2) voxels.push({ x, y: 4, z: 16, size: 2, material: P });
  return { id: 'boat', name: 'Boat', size: [1, 1, 2], item: 0, recipe: null, role: 'boat', states: [{ name: 's', voxels }] };
}

/** Sea at y < 0 (the top of the water at 0) for x < 160 (10 m); a bank 1 m high beyond; a rock at x 40..48, z -40..-32. */
const water = (x: number, y: number) => (x < 160 ? y < 0 && y >= -64 : false);
const solid = (x: number, y: number, z: number) => (x >= 160 ? y < 16 : y < -64) || (x >= 40 && x < 48 && z >= -40 && z < -32 && y < 16);
const surface = (x: number, y: number, z: number) => waterSurface((a, b) => water(a, b), x, y, z);

describe('boats', () => {
  it('take their hull and seat from the design', () => {
    const h = boatHull(rowboat());
    expect([h.halfW, h.halfL, h.height]).toEqual([8, 16, 8]);
    // (The bench's top, in the middle.)
    expect(h.seat).toBe(6);
  });

  it('find the water under them', () => {
    expect(surface(10, 0, 10)).toBe(0);
    expect(surface(10, 20, 10)).toBe(0);
    expect(surface(200, 0, 10)).toBeNull();
    expect(waterSurface(() => undefined, 0, 0, 0)).toBeUndefined();
  });

  it('speed up ahead, turn, and slow down by themselves, floating at their draft', () => {
    const hull = boatHull(rowboat());
    let b: BoatMotion = { x: 0, y: -10, z: 0, yaw: 0, speed: 0 };
    for (let i = 0; i < 40; i++) b = stepBoat(b, { forward: 1, turn: 0 }, 0.05, hull, surface, solid);
    // Two seconds at 4 m/s²: 7 m/s at most, going north (-z).
    expect(b.speed).toBeCloseTo(Math.min(BOAT.speed, 2 * BOAT.accel), 5);
    expect(b.z).toBeLessThan(-60);
    expect(b.x).toBeCloseTo(0, 6);
    expect(b.y).toBe(-BOAT.draft);
    const yaw = b.yaw;
    b = stepBoat(b, { forward: 1, turn: 1 }, 0.1, hull, surface, solid);
    expect(b.yaw).toBeGreaterThan(yaw);
    for (let i = 0; i < 100; i++) b = stepBoat(b, { forward: 0, turn: 0 }, 0.1, hull, surface, solid);
    expect(b.speed).toBe(0);
  });

  it('stop at the shore and at what sticks out of the water', () => {
    const hull = boatHull(rowboat());
    // Heading east (yaw -π/2) at the bank, 10 m off.
    let b: BoatMotion = { x: 100, y: -3, z: 0, yaw: -Math.PI / 2, speed: BOAT.speed };
    for (let i = 0; i < 100; i++) b = stepBoat(b, { forward: 1, turn: 0 }, 0.05, hull, surface, solid);
    expect(b.x + hull.halfW).toBeLessThanOrEqual(160);
    expect(b.x).toBeGreaterThan(140);
    // North into the rock (x 40..48 sticks up out of the water).
    b = { x: 44, y: -3, z: 0, yaw: 0, speed: 0 };
    for (let i = 0; i < 100; i++) b = stepBoat(b, { forward: 1, turn: 0 }, 0.05, hull, surface, solid);
    expect(b.z - hull.halfL).toBeGreaterThanOrEqual(-32 - 1e-6);
  });

  it("don't go over a bank that's level with the water: its hull stays over water", () => {
    const hull = boatHull(rowboat());
    // A quay at x >= 160 level with the water (solid to y 0, nothing above).
    const flush = (x: number, y: number) => (x >= 160 ? y < 0 : y < -64);
    let b: BoatMotion = { x: 100, y: -1, z: 0, yaw: -Math.PI / 2, speed: BOAT.speed };
    for (let i = 0; i < 100; i++) b = stepBoat(b, { forward: 1, turn: 0 }, 0.05, hull, surface, flush);
    // (Heading east, its length is along x: its bow at the quay.)
    expect(b.x + hull.halfL).toBeLessThanOrEqual(160 + 1);
    expect(b.x).toBeGreaterThan(140);
  });

  it('scrape along a wall at speed, but stop nose on to one', () => {
    const hull = boatHull(rowboat());
    // A basin (water x 0..128, z 0..144), its walls level with the water.
    const inside = (x: number, z: number) => x >= 0 && x < 128 && z >= 0 && z < 144;
    const pool = (x: number, y: number, z: number) => inside(x, z) && y < 0 && y >= -16;
    const walls = (x: number, y: number, z: number) => (inside(x, z) ? y < -16 : y < 0);
    const at = (x: number, y: number, z: number) => waterSurface(pool, x, y, z);
    // Heading south and a little west (into the west wall), from beside it.
    let b: BoatMotion = { x: 12, y: -1, z: 20, yaw: Math.PI - 0.3, speed: BOAT.speed };
    for (let i = 0; i < 20; i++) b = stepBoat(b, { forward: 1, turn: 0 }, 0.05, hull, at, walls);
    expect(b.speed).toBeGreaterThan(BOAT.speed * 0.9);
    expect(b.z).toBeGreaterThan(20 + 5 * 16);
    // Due south into the south wall: stopped.
    for (let i = 0; i < 60; i++) b = stepBoat({ ...b, yaw: Math.PI }, { forward: 0, turn: 0 }, 0.05, hull, at, walls);
    expect(b.speed).toBeLessThan(1);
    // Getting out there: not onto the basin's floor under the water (at the side, in the water).
    const [, feet] = getOutAt({ x: 60, y: -1, z: 60, yaw: 0 }, hull, walls);
    expect(feet).toBe(0);
  });

  it('let their rider out onto the bank beside them, else into the water', () => {
    const hull = boatHull(rowboat());
    // Moored along the bank (pointing north, the bank to its right: east).
    const [x, y] = getOutAt({ x: 150, y: -3, z: 0, yaw: 0 }, hull, solid);
    expect(x).toBeGreaterThanOrEqual(160);
    expect(y).toBe(16);
    // Out at sea: beside it, in the water.
    const [, wy] = getOutAt({ x: 0, y: -BOAT.draft, z: 0, yaw: 0 }, hull, solid);
    expect(wy).toBe(0);
  });
});
