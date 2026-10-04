import { describe, expect, it } from 'vitest';
import { FIRST_DESIGN_ITEM, Material, parseDesign } from '@super-vox/shared';
import { DesignEditor, aimSurface, cellsIn, clipRegion, draftOf, placeAgainst, regionBetween } from './designEditor.js';

const P = Material.Planks, S = Material.Stone;

describe('DesignEditor', () => {
  it('places voxels by the rules: inside the box, on their own grid, not overlapping', () => {
    const e = new DesignEditor();
    expect(e.place({ x: 0, y: 0, z: 0, size: 8, material: P })).toBeNull();
    expect(e.place({ x: 4, y: 0, z: 0, size: 4, material: P })).toBe('something is there');
    expect(e.place({ x: 8, y: 0, z: 0, size: 16, material: P })).toBe('outside the box'); // 1 m box
    expect(e.place({ x: 8, y: 2, z: 0, size: 4, material: P })).toBe('off its grid');
    expect(e.place({ x: 8, y: 0, z: 0, size: 8, material: S })).toBeNull();
    expect(e.voxels.length).toBe(2);
    // Painted, removed.
    e.paint(1, Material.DarkMetal);
    expect(e.voxels[1]!.material).toBe(Material.DarkMetal);
    e.remove(0);
    expect(e.voxels).toEqual([{ x: 8, y: 0, z: 0, size: 8, material: Material.DarkMetal }]);
  });

  it('mirrors across its middle (when there is room), and undoes and redoes', () => {
    const e = new DesignEditor();
    e.resize([3, 1, 1]);
    e.mirror = true;
    e.place({ x: 0, y: 0, z: 0, size: 4, material: P });
    expect(e.voxels.map((v) => v.x)).toEqual([0, 44]);
    // In the middle: its own mirror image (once).
    e.place({ x: 16, y: 0, z: 0, size: 16, material: P });
    expect(e.voxels.length).toBe(3);
    e.paint(0, S);
    expect(e.voxels.map((v) => v.material)).toEqual([S, S, P]);
    e.remove(1);
    expect(e.voxels.map((v) => v.x)).toEqual([16]);
    e.undo();
    expect(e.voxels.map((v) => v.x)).toEqual([0, 44, 16]);
    e.undo();
    e.undo();
    expect(e.voxels.map((v) => v.x)).toEqual([0, 44]);
    e.redo();
    expect(e.voxels.length).toBe(3);
    // A change after undoing: nothing to redo.
    e.undo();
    e.place({ x: 0, y: 4, z: 0, size: 4, material: P });
    expect(e.canRedo).toBe(false);
  });

  it('resizes (dropping what no longer fits, in every state), and has states', () => {
    const e = new DesignEditor();
    e.resize([4, 4, 4]);
    e.place({ x: 48, y: 0, z: 0, size: 16, material: P });
    e.place({ x: 0, y: 0, z: 0, size: 16, material: P });
    expect(e.addState('open')).toBe(true);
    expect(e.state).toBe(1);
    expect(e.voxels.length).toBe(2); // a copy
    e.remove(0);
    expect(e.resize([2, 4, 4])).toBe(1); // the far one, in the first state
    expect(e.draft.states.map((s) => s.voxels.length)).toEqual([1, 1]);
    expect(e.resize([5, 1, 1])).toBe(0);
    expect(e.draft.size).toEqual([2, 4, 4]);
    e.renameState(0, 'shut');
    e.removeState(1);
    expect(e.draft.states.map((s) => s.name)).toEqual(['shut']);
    e.removeState(0); // not the last
    expect(e.draft.states.length).toBe(1);
  });

  it('saves what the server takes, with an id made from its name (not one taken)', () => {
    const e = new DesignEditor();
    e.set((d) => (d.name = 'Oak Bench!'));
    e.place({ x: 0, y: 0, z: 0, size: 2, material: P });
    expect(e.body().id).toBe('oak-bench');
    expect(e.body(new Set(['oak-bench', 'oak-bench-2'])).id).toBe('oak-bench-3');
    const design = parseDesign({ ...e.body(), item: FIRST_DESIGN_ITEM });
    expect(design).toMatchObject({ id: 'oak-bench', name: 'Oak Bench!' });
    // Saved: it keeps its id, renamed.
    e.saved('oak-bench');
    e.set((d) => (d.name = 'Bench'));
    expect(e.body(new Set(['oak-bench'])).id).toBe('oak-bench');
    expect(draftOf(design as never).id).toBe('oak-bench');
  });
});

describe('lines and boxes', () => {
  it('spans two cells either way round, and fills it with cells of one size', () => {
    const r = regionBetween({ x: 8, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 4);
    expect(r).toEqual({ x0: 0, y0: 0, z0: 0, x1: 12, y1: 4, z1: 8 });
    expect(cellsIn(r, 4).length).toBe(3 * 1 * 2);
    // A column: one cell across.
    expect(cellsIn(regionBetween({ x: 4, y: 12, z: 4 }, { x: 4, y: 0, z: 4 }, 4), 4).map((c) => c.y)).toEqual([0, 4, 8, 12]);
    expect(clipRegion({ x0: -4, y0: 0, z0: 0, x1: 20, y1: 4, z1: 4 }, [16, 16, 16])).toEqual({ x0: 0, y0: 0, z0: 0, x1: 16, y1: 4, z1: 4 });
    expect(clipRegion({ x0: 16, y0: 0, z0: 0, x1: 20, y1: 4, z1: 4 }, [16, 16, 16])).toBeNull();
  });

  it('fills what is free as one change (mirrored too), and clears a region as one', () => {
    const e = new DesignEditor();
    e.resize([2, 1, 1]);
    e.place({ x: 4, y: 0, z: 0, size: 4, material: S });
    // A row of 1/4 m along x across the left half: one taken, three go in.
    const row = cellsIn(regionBetween({ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, 4), 4);
    expect(e.fill(row, 4, P)).toEqual({ placed: 3, skipped: 1 });
    expect(e.voxels.length).toBe(4);
    e.undo();
    expect(e.voxels.length).toBe(1); // one step
    e.redo();
    // Nothing free: no change at all.
    expect(e.fill(row, 4, P)).toEqual({ placed: 0, skipped: 4 });
    // Mirrored: the right half too.
    e.mirror = true;
    e.fill(cellsIn(regionBetween({ x: 0, y: 4, z: 0 }, { x: 4, y: 4, z: 0 }, 4), 4), 4, P);
    expect(e.voxels.filter((v) => v.y === 4).map((v) => v.x).sort((a, b) => a - b)).toEqual([0, 4, 24, 28]);
    // Cleared: everything touching the left 1/2 m at the bottom (and its mirror image).
    expect(e.clearRegion({ x0: 0, y0: 0, z0: 0, x1: 8, y1: 4, z1: 4 })).toBe(2);
    expect(e.voxels.filter((v) => v.y === 0).map((v) => v.x).sort((a, b) => a - b)).toEqual([8, 12]);
    e.undo();
    expect(e.voxels.filter((v) => v.y === 0).length).toBe(4);
    // A big voxel just touched: it goes whole.
    const f = new DesignEditor();
    f.place({ x: 0, y: 0, z: 0, size: 16, material: P });
    expect(f.clearRegion({ x0: 15, y0: 15, z0: 15, x1: 16, y1: 16, z1: 16 })).toBe(1);
  });
});

describe('moving a selection', () => {
  it('moves what is wholly inside, and the selection with it, a step at a time as one change each', () => {
    const e = new DesignEditor();
    e.resize([2, 2, 1]);
    e.place({ x: 0, y: 0, z: 0, size: 4, material: P });
    e.place({ x: 4, y: 0, z: 0, size: 4, material: S });
    e.place({ x: 24, y: 0, z: 0, size: 8, material: S }); // outside the selection
    e.place({ x: 8, y: 8, z: 0, size: 8, material: P }); // only partly inside
    e.selection = { x0: 0, y0: 0, z0: 0, x1: 12, y1: 12, z1: 4 };
    expect(e.selected()).toEqual({ inside: [0, 1], partly: 1 });
    expect(e.moveStep(1)).toBe(4); // (the biggest voxel in it)
    expect(e.moveStep(8)).toBe(8);
    // Up 1/4 m: both, and the selection.
    expect(e.move(1, 1, 4)).toBeNull();
    const at = () => e.voxels.filter((v) => v.size === 4).map((v) => [v.x, v.y, v.z]).sort();
    expect(at()).toEqual([[0, 4, 0], [4, 4, 0]]);
    expect(e.selection).toEqual({ x0: 0, y0: 4, z0: 0, x1: 12, y1: 16, z1: 4 });
    // Right by 1/2 m (the size chosen): two steps' worth in one.
    expect(e.move(0, 1, 8)).toBeNull();
    expect(at()).toEqual([[12, 4, 0], [8, 4, 0]].sort());
    // Undone: back, the selection too.
    e.undo();
    expect(at()).toEqual([[0, 4, 0], [4, 4, 0]]);
    expect(e.selection).toEqual({ x0: 0, y0: 4, z0: 0, x1: 12, y1: 16, z1: 4 });
    e.redo();
    expect(e.selection).toEqual({ x0: 8, y0: 4, z0: 0, x1: 20, y1: 16, z1: 4 });
  });

  it("won't leave the box or go through what isn't selected, and changes nothing trying", () => {
    const e = new DesignEditor();
    e.resize([2, 1, 1]);
    e.place({ x: 0, y: 0, z: 0, size: 8, material: P });
    e.place({ x: 16, y: 0, z: 0, size: 8, material: S });
    e.selection = { x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 };
    expect(e.move(0, -1, 4)).toBe("it would leave the object's box");
    expect(e.move(2, -1, 4)).toBe("it would leave the object's box");
    expect(e.move(0, 1, 4)).toBeNull(); // (a 1/2 m step: the voxel's size)
    expect(e.move(0, 1, 4)).toBe('something is in the way');
    expect(e.voxels.map((v) => v.x).sort((a, b) => a - b)).toEqual([8, 16]);
    e.undo();
    expect(e.voxels.map((v) => v.x).sort((a, b) => a - b)).toEqual([0, 16]);
    expect(e.canUndo).toBe(true); // (the placements; the refused moves added nothing)
    // Nothing selected, or nothing wholly in it.
    e.selection = null;
    expect(e.move(0, 1, 4)).toBe('nothing selected');
    e.selection = { x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 4 };
    expect(e.move(0, 1, 4)).toBe('nothing wholly inside the selection to move');
    // A smaller box: the selection is clipped to it.
    e.selection = { x0: 8, y0: 0, z0: 0, x1: 32, y1: 8, z1: 8 };
    e.resize([1, 1, 1]);
    expect(e.selection).toEqual({ x0: 8, y0: 0, z0: 0, x1: 16, y1: 8, z1: 8 });
  });
});

describe('placeAgainst', () => {
  it('puts a voxel against the face clicked, on its grid', () => {
    // The floor at (5.3, 0, 9.9): a 4-unit voxel at (4, 0, 8).
    expect(placeAgainst([5.3, 0, 9.9], [0, 1, 0], 4)).toEqual({ x: 4, y: 0, z: 8 });
    // The +x face of a voxel ending at x = 8: the next one out.
    expect(placeAgainst([8, 3, 3], [1, 0, 0], 2)).toEqual({ x: 8, y: 2, z: 2 });
    // Its -x face: the one before.
    expect(placeAgainst([8, 3, 3], [-1, 0, 0], 2)).toEqual({ x: 6, y: 2, z: 2 });
  });
});

describe('aimSurface', () => {
  const box = [32, 32, 32];
  const floor = { axis: 1 as const, at: 0 };
  it('finds the floor looking down, and the far wall looking across', () => {
    expect(aimSurface([10, 50, 10], [0, -1, 0], box, floor)).toEqual({ point: [10, 0, 10], normal: [0, 1, 0], on: 'plane' });
    // Looking across (toward -z) from the front at y 8: the back wall, z 0, facing us.
    expect(aimSurface([10, 8, 60], [0, 0, -1], box, floor)).toEqual({ point: [10, 8, 0], normal: [0, 0, 1], on: 'wall' });
    // Looking up from below the floor: the ceiling's the far side.
    expect(aimSurface([10, -20, 10], [0, 1, 0], box, floor)!.on).toBe('plane'); // (crosses the floor plane first)
    expect(aimSurface([10, -20, 10], [0, 1, 0], box, { axis: 1, at: 40 })).toMatchObject({ point: [10, 32, 10], normal: [0, -1, 0], on: 'wall' });
    // Missing the box: nothing.
    expect(aimSurface([100, 50, 10], [0, -1, 0], box, floor)).toBeNull();
  });

  it('finds a raised or upright plane first when the ray crosses it inside the box', () => {
    const p = aimSurface([10, 50, 10], [0, -1, 0], box, { axis: 1, at: 12 })!;
    expect(p).toEqual({ point: [10, 12, 10], normal: [0, 1, 0], on: 'plane' });
    // Built against it (a 4-unit voxel): on top of it, at y 12.
    expect(placeAgainst(p.point, p.normal, 4)).toEqual({ x: 8, y: 12, z: 8 });
    // An upright plane facing the front (across z) at z 16, looked at from the front: in front of it.
    const q = aimSurface([10, 8, 60], [0, 0, -1], box, { axis: 2, at: 16 })!;
    expect(q).toEqual({ point: [10, 8, 16], normal: [0, 0, 1], on: 'plane' });
    expect(placeAgainst(q.point, q.normal, 4)).toEqual({ x: 8, y: 8, z: 16 });
    // From behind it: the voxel's on our side (z 12).
    const r = aimSurface([10, 8, -40], [0, 0, 1], box, { axis: 2, at: 16 })!;
    expect(placeAgainst(r.point, r.normal, 4)).toEqual({ x: 8, y: 8, z: 12 });
    // A plane outside where the ray is in the box: the far wall instead.
    expect(aimSurface([10, 50, 10], [0.3, -1, 0], box, { axis: 0, at: 4 })!.on).toBe('wall');
  });
});
