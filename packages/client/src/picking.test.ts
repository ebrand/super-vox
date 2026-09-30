import { describe, expect, it } from 'vitest';
import { digBox, placementBox, raycastVoxels, type RayHit, type SolidAt } from './picking.js';

/** Ground: every cell with y < 0 is solid; one pillar at x 10..13, z 0..3, y 0..7. */
const world: SolidAt = (x, y, z) => y < 0 || (x >= 10 && x < 14 && z >= 0 && z < 4 && y < 8);

describe('raycastVoxels', () => {
  it('hits the ground straight down with an upward normal', () => {
    const h = raycastVoxels([5.5, 20.5, 5.5], [0, -1, 0], 100, world)!;
    expect(h.cell).toEqual([5, -1, 5]);
    expect(h.normal).toEqual([0, 1, 0]);
    expect(h.point[1]).toBeCloseTo(0, 12);
    expect(h.distance).toBeCloseTo(20.5, 12);
  });

  it('hits the side of the pillar with the right face', () => {
    const h = raycastVoxels([0.5, 3.5, 1.5], [1, 0, 0], 100, world)!;
    expect(h.cell).toEqual([10, 3, 1]);
    expect(h.normal).toEqual([-1, 0, 0]);
    const back = raycastVoxels([20.5, 3.5, 1.5], [-1, 0, 0], 100, world)!;
    expect(back.cell).toEqual([13, 3, 1]);
    expect(back.normal).toEqual([1, 0, 0]);
  });

  it('agrees with a fine brute-force march on diagonal rays', () => {
    let s = 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let k = 0; k < 300; k++) {
      const o: [number, number, number] = [rand() * 30 - 5, 1 + rand() * 20, rand() * 30 - 5];
      const d: [number, number, number] = [rand() * 2 - 1, -rand(), rand() * 2 - 1];
      const h = raycastVoxels(o, d, 200, world);
      // March in tiny steps to find the first solid cell.
      const len = Math.hypot(...d);
      // The starting cell never counts, like raycastVoxels.
      const start = o.map(Math.floor).join(',');
      let ref: number[] | null = null;
      for (let t = 0; t < 200; t += 0.0005) {
        const p = [o[0] + (d[0] / len) * t, o[1] + (d[1] / len) * t, o[2] + (d[2] / len) * t].map(Math.floor);
        if (p.join(',') !== start && world(p[0]!, p[1]!, p[2]!)) { ref = p; break; }
      }
      expect(h?.cell ?? null).toEqual(ref);
    }
  });

  it('stops at unloaded chunks and at the maximum distance', () => {
    const unloadedBeyond5: SolidAt = (x, y, z) => (x > 5 ? undefined : world(x, y, z));
    expect(raycastVoxels([0.5, 3.5, 1.5], [1, 0, 0], 100, unloadedBeyond5)).toBeNull();
    expect(raycastVoxels([5.5, 20.5, 5.5], [0, -1, 0], 10, world)).toBeNull();
  });

  it('ignores the cell it starts in', () => {
    // From inside the pillar's top cell going up there is nothing else to hit.
    expect(raycastVoxels([11.5, 7.5, 1.5], [0, 1, 0], 100, world)).toBeNull();
    // Lower in the pillar, the next cell up is solid and is hit.
    expect(raycastVoxels([11.5, 3.5, 1.5], [0, 1, 0], 100, world)?.cell).toEqual([11, 4, 1]);
  });
});

describe('placementBox', () => {
  const top = (x: number, z: number): RayHit => ({ cell: [Math.floor(x), -1, Math.floor(z)], normal: [0, 1, 0], point: [x, 0, z], distance: 1 });
  const on1m = { x: 0, y: -16, z: 0, size: 16 };

  it('sits on top of the target, snapped to its size', () => {
    expect(placementBox(top(5.2, 9.9), on1m, 4)).toEqual({ x: 4, y: 0, z: 8, size: 4 });
    expect(placementBox(top(15.9, 15.9), on1m, 8)).toEqual({ x: 8, y: 0, z: 8, size: 8 });
  });

  it('goes below or beside the target for downward and sideways faces', () => {
    const below: RayHit = { cell: [3, 5, 3], normal: [0, -1, 0], point: [3.5, 5, 3.5], distance: 1 };
    expect(placementBox(below, { x: 2, y: 5, z: 2, size: 2 }, 2)).toEqual({ x: 2, y: 3, z: 2, size: 2 });
    const side: RayHit = { cell: [10, 3, 1], normal: [-1, 0, 0], point: [10, 3.5, 1.5], distance: 1 };
    expect(placementBox(side, { x: 10, y: 0, z: 0, size: 4 }, 2)).toEqual({ x: 8, y: 2, z: 0, size: 2 });
  });

  it('places in 1/16 m steps centred on the hit point when fine, crossing gridlines freely', () => {
    expect(placementBox(top(5.3, 9.9), on1m, 8, true)).toEqual({ x: 1, y: 0, z: 6, size: 8 });
    // Near the block edge it now straddles the gridline (the server splits it).
    expect(placementBox(top(15.8, 0.2), on1m, 8, true)).toEqual({ x: 12, y: 0, z: -4, size: 8 });
    // Every 1/16 m position is reachable as the crosshair moves.
    const xs = new Set<number>();
    for (let px = 0; px < 16; px += 0.25) xs.add(placementBox(top(px, 8), on1m, 8, true).x);
    expect([...xs].sort((a, b) => a - b)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('aligned placement never crosses a gridline for the standard sizes', () => {
    for (const size of [1, 2, 4, 8, 16]) {
      for (let px = -16; px < 16; px += 0.37) {
        const b = placementBox(top(px, -px), { x: Math.floor(px / 16) * 16, y: -16, z: Math.floor(-px / 16) * 16, size: 16 }, size);
        expect(Math.floor(b.x / 16)).toBe(Math.floor((b.x + size - 1) / 16));
        expect(Math.floor(b.z / 16)).toBe(Math.floor((b.z + size - 1) / 16));
      }
    }
  });

  it('may cross a gridline along the normal (on top of a small voxel near the top of a block)', () => {
    const h: RayHit = { cell: [0, 12, 0], normal: [0, 1, 0], point: [0.5, 13, 0.5], distance: 1 };
    expect(placementBox(h, { x: 0, y: 12, z: 0, size: 1 }, 8)).toEqual({ x: 0, y: 13, z: 0, size: 8 });
  });
});

describe('digBox', () => {
  const top = (x: number, z: number): RayHit => ({ cell: [Math.floor(x), -1, Math.floor(z)], normal: [0, 1, 0], point: [x, 0, z], distance: 1 });

  it('sits just below the face aimed at, aligned or fine', () => {
    expect(digBox(top(5.2, 9.9), { x: 0, y: -16, z: 0, size: 16 }, 8)).toEqual({ x: 0, y: -8, z: 8, size: 8 });
    expect(digBox(top(5.3, 9.9), { x: 0, y: -16, z: 0, size: 16 }, 8, true)).toEqual({ x: 1, y: -8, z: 6, size: 8 });
  });

  it('slides freely across gridlines sideways when fine', () => {
    expect(digBox(top(15.8, 0.2), { x: 0, y: -16, z: 0, size: 16 }, 8, true)).toEqual({ x: 12, y: -8, z: -4, size: 8 });
  });

  it('goes into the solid for sideways and downward faces too', () => {
    const side: RayHit = { cell: [10, 3, 1], normal: [-1, 0, 0], point: [10, 3.5, 1.5], distance: 1 };
    expect(digBox(side, { x: 10, y: 0, z: 0, size: 4 }, 2)).toEqual({ x: 10, y: 2, z: 0, size: 2 });
    const below: RayHit = { cell: [3, 5, 3], normal: [0, -1, 0], point: [3.5, 5, 3.5], distance: 1 };
    expect(digBox(below, { x: 2, y: 5, z: 2, size: 2 }, 4)).toEqual({ x: 0, y: 5, z: 0, size: 4 });
  });

  it('may extend past the target and across gridlines', () => {
    // Aiming at the top of a 1/16 m voxel at y = 4 with a 1 m box: y = 5 - 16 = -11.
    const h: RayHit = { cell: [0, 4, 0], normal: [0, 1, 0], point: [0.5, 5, 0.5], distance: 1 };
    expect(digBox(h, { x: 0, y: 4, z: 0, size: 1 }, 16)).toEqual({ x: 0, y: -11, z: 0, size: 16 });
  });
});
