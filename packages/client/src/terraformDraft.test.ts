import { describe, expect, it } from 'vitest';
import type { TerrainStroke } from '@super-vox/shared';
import { TerraformDraft, changedBox, dabsAlong } from './terraformDraft.js';

const s = (x: number): TerrainStroke => ({ kind: 'raise', x, z: 0, radius: 10, amount: 2, softness: 0.5 });

describe('TerraformDraft', () => {
  it('undoes and redoes whole groups (a drag at a time)', () => {
    const d = new TerraformDraft();
    d.begin([s(1)]);
    d.begin([s(2)]);
    d.extend([s(3), s(4)]);
    expect(d.strokes.map((t) => t.x)).toEqual([1, 2, 3, 4]);
    expect(d.count).toBe(4);
    expect(d.undo()).toBe(true);
    expect(d.strokes.map((t) => t.x)).toEqual([1]);
    expect(d.canRedo).toBe(true);
    expect(d.redo()).toBe(true);
    expect(d.strokes.map((t) => t.x)).toEqual([1, 2, 3, 4]);
    expect(d.redo()).toBe(false);
    d.undo();
    d.undo();
    expect(d.strokes).toEqual([]);
    expect(d.undo()).toBe(false);
  });

  it('forgets what was undone once something new is drawn', () => {
    const d = new TerraformDraft();
    d.begin([s(1)]);
    d.undo();
    d.begin([s(9)]);
    expect(d.canRedo).toBe(false);
    expect(d.strokes.map((t) => t.x)).toEqual([9]);
  });

  it('clears, and the clearing can be undone', () => {
    const d = new TerraformDraft();
    d.begin([s(1), s(2)]);
    d.clear();
    expect(d.strokes).toEqual([]);
    d.undo();
    expect(d.strokes.map((t) => t.x)).toEqual([1, 2]);
  });

  it('stores and reads back, refusing anything malformed', () => {
    const d = new TerraformDraft();
    d.begin([s(1)]);
    d.begin([s(2), s(3)]);
    const back = TerraformDraft.parse(JSON.parse(JSON.stringify(d)));
    expect(back.strokes).toEqual(d.strokes);
    back.undo();
    expect(back.strokes).toEqual(d.strokes); // (history isn't stored)
    expect(TerraformDraft.parse([[{ kind: 'melt' }]]).count).toBe(0);
    expect(TerraformDraft.parse('nope').count).toBe(0);
  });
});

describe('dabsAlong', () => {
  it('spaces dabs evenly along a path, carrying the remainder across segments', () => {
    const a = dabsAlong({ x: 0, z: 0 }, { x: 10, z: 0 }, 4);
    expect(a.points).toEqual([{ x: 4, z: 0 }, { x: 8, z: 0 }]);
    expect(a.carried).toBeCloseTo(2, 9);
    // The next segment carries on 4 m after the dab at x 8.
    const b = dabsAlong({ x: 10, z: 0 }, { x: 10, z: 10 }, 4, a.carried);
    expect(b.points[0]!.x).toBe(10);
    expect(b.points[0]!.z).toBeCloseTo(2, 9);
    expect(b.points.length).toBe(3);
    expect(dabsAlong({ x: 0, z: 0 }, { x: 1, z: 0 }, 4).points).toEqual([]);
  });
});

describe('changedBox', () => {
  it('boxes the strokes added or taken away, with their reach', () => {
    const a = s(1), b = s(2), c = { ...s(50), z: 30, radius: 5 };
    expect(changedBox([a, b], [a, b])).toBeNull();
    expect(changedBox([a], [a, b])).toEqual({ x0: -8, z0: -10, x1: 12, z1: 10 });
    expect(changedBox([a, b], [a])).toEqual({ x0: -8, z0: -10, x1: 12, z1: 10 });
    expect(changedBox([a, b], [a, c])).toEqual({ x0: -8, z0: -10, x1: 55, z1: 35 });
  });
});
