import { describe, expect, it } from 'vitest';
import { FIRST_DESIGN_ITEM, Material, parseDesign } from '@super-vox/shared';
import { DesignEditor, aimSurface, cellsIn, clipRegion, draftOf, placeAgainst, regionBetween, roundCells, shapeCells } from './designEditor.js';

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
    expect(e.resize([17, 1, 1])).toBe(0);
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

describe('round shapes', () => {
  const C = { x: 16, y: 16, z: 16 };
  const key = (c: { x: number; y: number; z: number }) => `${c.x},${c.y},${c.z}`;
  it('make circles across any axis, spheres, and domes on either side', () => {
    expect(shapeCells('circle', C, 1, 1, 0, 4, false)).toEqual([C]);
    // Radius 1 cell: a plus and its corners (9); radius 2: 21 (corners out).
    expect(shapeCells('circle', C, 1, 1, 4, 4, false)).toHaveLength(9);
    const disk = shapeCells('circle', C, 1, 1, 8, 4, false);
    expect(disk).toHaveLength(21);
    expect(disk.every((c) => c.y === 16)).toBe(true);
    expect(shapeCells('circle', C, 0, 1, 8, 4, false).every((c) => c.x === 16)).toBe(true);
    // A sphere of radius 1 cell: 19; a dome its upper half and middle (9 + 5), or lower.
    expect(shapeCells('sphere', C, 1, 1, 4, 4, false)).toHaveLength(19);
    const up = shapeCells('dome', C, 1, 1, 4, 4, false), down = shapeCells('dome', C, 1, -1, 4, 4, false);
    expect(up).toHaveLength(14);
    expect(up.every((c) => c.y >= 16)).toBe(true);
    expect(down.every((c) => c.y <= 16)).toBe(true);
    // (The radius is snapped to whole cells.)
    expect(shapeCells('sphere', C, 1, 1, 5, 4, false)).toHaveLength(19);
  });

  it('are hollow as rings and shells one cell thick: the solid shape less its inside', () => {
    const solid = shapeCells('sphere', C, 1, 1, 12, 4, false), shell = shapeCells('sphere', C, 1, 1, 12, 4, true), core = shapeCells('sphere', C, 1, 1, 8, 4, false);
    const inShell = new Set(shell.map(key));
    expect(shell.length).toBeLessThan(solid.length);
    // Everything of the solid sphere is in the shell or within the smaller one.
    const coreKeys = new Set(core.map(key));
    expect(solid.every((c) => inShell.has(key(c)) || coreKeys.has(key(c)))).toBe(true);
    expect(shell.some((c) => key(c) === key(C))).toBe(false);
    const ring = shapeCells('circle', C, 1, 1, 8, 4, true);
    expect(ring.some((c) => key(c) === key(C))).toBe(false);
    expect(ring.length).toBeGreaterThan(8);
  });

  it('fill as one change, clipped to the box, and clear as one', () => {
    const e = new DesignEditor();
    e.resize([2, 2, 2]);
    // A sphere centred on the box's corner cell: only the part inside goes in.
    const cells = shapeCells('sphere', { x: 0, y: 0, z: 0 }, 1, 1, 8, 4, false);
    const { placed, skipped } = e.fill(cells, 4, P);
    expect(placed + skipped).toBe(cells.length);
    expect(placed).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
    expect(e.clearCells(cells, 4)).toBe(placed);
    expect(e.voxels).toHaveLength(0);
    e.undo();
    expect(e.voxels).toHaveLength(placed);
  });
});

describe('roundCells', () => {
  it('makes an 8 m ring 1 m thick, centred in an 8 m box (an even width): it fills the box edge to edge', () => {
    // 1/4 m voxels (4 units), centred on the box's middle (a corner between cells), 4 m out, 1 m thick.
    const ring = roundCells({ kind: 'circle', centre: { x: 64, y: 2, z: 64 }, axis: 1, sign: 1, outer: 64, thickness: 16, size: 4 });
    const xs = ring.map((c) => c.x), zs = ring.map((c) => c.z);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(124); // the last cell ends at 128: 8 m across
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(124);
    expect(new Set(ring.map((c) => c.y))).toEqual(new Set([0]));
    // Symmetric about the middle, and 1 m thick: no cell's centre within 3 m of it, all within 4 m.
    for (const c of ring) {
      const d = Math.hypot(c.x + 2 - 64, c.z + 2 - 64);
      expect(d).toBeGreaterThan(48);
      expect(d).toBeLessThanOrEqual(64);
      expect(ring.some((o) => o.x === 124 - c.x && o.z === c.z)).toBe(true);
    }
    // Solid, it's a disk: more cells, the middle too.
    const disk = roundCells({ kind: 'circle', centre: { x: 64, y: 2, z: 64 }, axis: 1, sign: 1, outer: 64, thickness: null, size: 4 });
    expect(disk.length).toBeGreaterThan(ring.length);
    expect(disk.some((c) => c.x === 60 && c.z === 60)).toBe(true);
  });

  it('makes thick shells too (a dome 2 voxels thick)', () => {
    const shell = roundCells({ kind: 'dome', centre: { x: 2, y: 2, z: 2 }, axis: 1, sign: 1, outer: 18, thickness: 8, size: 4 });
    for (const c of shell) {
      const d = Math.hypot(c.x + 2 - 2, c.y + 2 - 2, c.z + 2 - 2);
      expect(d).toBeGreaterThan(10);
      expect(c.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('extruding', () => {
  /** A 2 m box with a flat layer on its floor: an L of 1/4 m planks (3 along x, then 2 more along z from its end), a 1/8 m stone beside it, and a lone 1/4 m plank touching the L only at a corner. */
  function layer(): DesignEditor {
    const e = new DesignEditor({ id: null, name: 'x', size: [2, 2, 2], states: [{ name: 's', voxels: [] }], recipe: null });
    for (const [x, z] of [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8]]) e.place({ x: x!, y: 0, z: z!, size: 4, material: P });
    e.place({ x: 12, y: 2, z: 0, size: 2, material: S }); // its top level with theirs, joined to (8, 0) along part of its edge
    e.place({ x: 12, y: 0, z: 12, size: 4, material: P }); // only a corner on (8, 8)
    return e;
  }

  it('takes the whole flat face joined edge to edge (any sizes), not what only meets it at a corner', () => {
    const e = layer();
    const face = e.flatFace(0, 1, 1).map((i) => e.voxels[i]!).map((v) => `${v.x},${v.z}/${v.size}`).sort();
    expect(face).toEqual(['0,0/4', '12,0/2', '4,0/4', '8,0/4', '8,4/4', '8,8/4'].sort());
    // (Not level with it: not part of it.)
    e.place({ x: 14, y: 0, z: 0, size: 2, material: S });
    expect(e.flatFace(0, 1, 1).length).toBe(6);
    e.undo();
    // Covered on top: that one's face isn't open, and it splits the face.
    e.place({ x: 4, y: 4, z: 0, size: 4, material: P });
    expect(e.flatFace(0, 1, 1).length).toBe(1);
    expect(e.flatFace(1, 1, 1)).toEqual([]);
    // Its underside (on the box's floor) is a face too: the planks' (the stone's is higher up).
    expect(e.flatFace(0, 1, -1).length).toBe(5);
  });

  it('grows each up by whole copies of itself, keeping its material; and cuts back down', () => {
    const e = layer();
    const face = e.flatFace(0, 1, 1);
    const r = e.extrude(face, 1, 1, 8);
    // 1/4 m voxels: 2 more each (5 of them); the 1/8 m stone: 4 more.
    expect(r).toEqual({ placed: 5 * 2 + 4, removed: 0, skipped: 0 });
    expect(e.voxels.filter((v) => v.material === S).map((v) => v.y).sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
    expect(e.voxels.some((v) => v.x === 12 && v.z === 12 && v.y > 0)).toBe(false);
    // One change: undone at once.
    e.undo();
    expect(e.voxels.length).toBe(7);
    e.redo();
    // Cut 1/4 m back from the new top (y 12): the top layer of the L goes, the stone's top two.
    const top = e.flatFace(e.voxels.findIndex((v) => v.x === 0 && v.y === 8), 1, 1);
    expect(e.extrude(top, 1, 1, -4).removed).toBe(5 + 2);
    expect(Math.max(...e.voxels.map((v) => v.y + v.size))).toBe(8);
  });

  it('skips what has no room (the box, or something in the way), and mirrors', () => {
    const e = layer();
    e.place({ x: 0, y: 8, z: 0, size: 4, material: S });
    const r = e.extrude(e.flatFace(0, 1, 1), 1, 1, 8);
    expect(r.skipped).toBe(1);
    // Out of the box's top: nothing goes in.
    const tall = new DesignEditor({ id: null, name: 'x', size: [1, 1, 1], states: [{ name: 's', voxels: [] }], recipe: null });
    tall.place({ x: 0, y: 12, z: 0, size: 4, material: P });
    expect(tall.extrude(tall.flatFace(0, 1, 1), 1, 1, 8)).toEqual({ placed: 0, removed: 0, skipped: 2 });
    expect(tall.canUndo).toBe(true); // (the place only)
    // Mirroring: the mirror image grows too.
    const m = new DesignEditor({ id: null, name: 'x', size: [1, 1, 1], states: [{ name: 's', voxels: [] }], recipe: null });
    m.place({ x: 0, y: 0, z: 0, size: 4, material: P });
    m.mirror = true;
    expect(m.extrude(m.flatFace(0, 0, 1), 0, 1, 4).placed).toBe(2);
    expect(m.voxels.map((v) => v.x).sort((a, b) => a - b)).toEqual([0, 4, 8]);
  });
});
