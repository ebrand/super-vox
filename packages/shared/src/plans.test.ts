import { describe, expect, it } from 'vitest';
import { cleanPlan, madeOf, pieceSize, planTotals, refusePlan, type Plan } from './plans.js';
import { designBase } from './designs.js';

const plot = { x0: 100, z0: 100, x1: 300, z1: 260 };
const wall = (over = {}) => ({ kind: 'wall' as const, id: 'w1', x0: 120, z0: 120, x1: 180, z1: 120, thickness: 2, height: 6, ...over });
const tower = (over = {}) => ({ kind: 'tower' as const, id: 't1', x: 120, z: 120, radius: 4, height: 12, ...over });
const building = (over = {}) => ({ kind: 'building' as const, id: 'b1', x0: 140, z0: 140, x1: 160, z1: 150, height: 6, ...over });

describe('plans', () => {
  it('take walls, towers and buildings inside the plot, in whole metres and sensible sizes', () => {
    expect(refusePlan({ elements: [] }, plot)).toBeNull();
    expect(refusePlan({ elements: [wall(), tower(), building()] }, plot)).toBeNull();
  });

  it('refuse what lies outside the plot, half metres, odd sizes, repeats and unknown things', () => {
    const bad: unknown[] = [
      null,
      { elements: 'x' },
      { elements: [wall({ x1: 400 })] },
      { elements: [wall({ x1: 120.5 })] },
      { elements: [wall({ x1: 120, z1: 120 })] },
      { elements: [wall({ thickness: 20 })] },
      { elements: [tower({ x: 102 })] }, // its radius reaches past the plot's edge
      { elements: [tower({ height: 100 })] },
      { elements: [building({ x1: 140 })] },
      { elements: [building({ z1: 300 })] },
      { elements: [wall(), wall()] },
      { elements: [{ kind: 'moat', id: 'm' }] },
      { elements: [wall({ id: '' })] },
    ];
    for (const p of bad) expect(refusePlan(p, plot)).not.toBeNull();
  });

  it('keep only the fields elements have, and add up', () => {
    const p = { elements: [{ ...wall(), evil: 1 }, tower(), building()] } as unknown as Plan;
    const clean = cleanPlan(p);
    expect(clean.elements[0]).toEqual(wall());
    expect(planTotals(clean)).toEqual({ wallLength: 60, towers: 1, buildings: 1, floorArea: 200 });
  });
});

describe('elements made of designs', () => {
  const design = (size: [number, number, number]) => ({ id: 'piece', size, states: [] });
  it('take their size from the design: walls its height and depth, towers its height and footprint, buildings both', () => {
    // A wall: the design caps it, so it's at least as high; higher ones stay as high (solid below the cap).
    expect(madeOf(wall(), design([4, 2, 3]))).toEqual({ ...wall(), design: 'piece', height: 6, thickness: 3 });
    expect(madeOf(wall({ height: 1 }), design([4, 2, 3]))).toEqual({ ...wall(), design: 'piece', height: 2, thickness: 3 });
    expect(madeOf(wall({ height: 12 }), design([4, 2, 3]))).toMatchObject({ height: 12 });
    // A tower too: the design caps it (as wide as its footprint).
    expect(madeOf(tower(), design([10, 4, 6]))).toEqual({ ...tower(), design: 'piece', height: 12, radius: 5 });
    expect(madeOf(tower(), design([10, 16, 6]))).toEqual({ ...tower(), design: 'piece', height: 16, radius: 5 });
    expect(madeOf(building(), design([12, 5, 9]))).toEqual({ ...building(), design: 'piece', height: 5, x1: 152, z1: 149 });
    // And back to plain: the design gone, sizes kept.
    expect(madeOf(madeOf(wall(), design([4, 8, 3])), null)).toEqual({ ...wall(), height: 8, thickness: 3 });
  });

  it('keep the design in the plan (a good id only)', () => {
    const p = { elements: [madeOf(wall(), design([4, 8, 3]))] };
    expect(refusePlan(p, plot)).toBeNull();
    expect(cleanPlan(p).elements[0]).toMatchObject({ design: 'piece' });
    expect(refusePlan({ elements: [{ ...wall(), design: 'Bad Id!' }] }, plot)).toMatch(/design/);
  });
});

describe('pieces measured by their voxels', () => {
  it('an 8 m ring tower top drawn in a 9 m box: an 8 m tower, built below as the ring is', () => {
    // A ring 1 m thick, 8 m across, 2 m high, in a 9 x 2 x 9 m box (1 m voxels, from 0.5 m in: here
    // 1 m in on the low sides, the box's last metre empty), centred on (4, 4).
    const voxels = [];
    for (let y = 0; y < 2; y++)
      for (let z = 0; z < 8; z++)
        for (let x = 0; x < 8; x++) {
          const d = Math.hypot(x + 0.5 - 4, z + 0.5 - 4);
          if (d <= 4 && d > 3) voxels.push({ x: x * 16, y: y * 16, z: z * 16, size: 16, material: 27 });
        }
    const top = { id: 'ring-top', size: [9, 2, 9] as [number, number, number], states: [{ name: 's', voxels }] };
    expect(pieceSize(top)).toEqual([8, 2, 8]);
    expect(madeOf(tower(), top)).toMatchObject({ radius: 4, height: 12 });
    const base = designBase(top)!;
    expect([base.width, base.depth]).toEqual([8, 8]);
    // The ring's columns, not the middle.
    expect(base.columns[0 + 8 * 4]).toBe(1);
    expect(base.columns[4 + 8 * 4]).toBe(0);
  });
});
