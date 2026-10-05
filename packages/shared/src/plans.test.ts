import { describe, expect, it } from 'vitest';
import { cleanPlan, planTotals, refusePlan, type Plan } from './plans.js';

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
      { elements: [building({ x1: 141 })] },
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
