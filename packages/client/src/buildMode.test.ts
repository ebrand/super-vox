import { describe, expect, it } from 'vitest';
import { Material, blockFromVoxels, buildCells, type BlockReader, type BuildOp, type Cell } from '@super-vox/shared';
import { BUILD_TOOLS, BuildMode, type Ray } from './buildMode.js';

const S = 4; // 1/4 m cells
const stone = Material.Stone;
/** The ground's top (y = 0), aimed at near (100, 200): the cell above it is (100, 0, 200). */
const ground = { point: [101.3, 0, 202.7], normal: [0, 1, 0] };
/** A ray from `from` through `to`. */
const ray = (from: number[], to: number[]): Ray => ({ origin: from, dir: to.map((v, i) => v - from[i]!) });
const eye = [90, 40, 190];

describe('BuildMode', () => {
  it('a box: base clicked out on the ground, then raised by aiming up the corner clicked', () => {
    const b = new BuildMode();
    expect(b.click(ground, ray(eye, ground.point), S, stone, false)).toBeNull();
    expect(b.active).toBe(true);
    // Aim at (130.5, 2, 221) on the plane through the start cell's middle: the cell (128, 0, 220).
    const base = ray(eye, [130.5, 2, 221]);
    b.move(base, S);
    expect(b.op(S, stone)).toMatchObject({ shape: { kind: 'box', a: { x: 100, y: 0, z: 200 }, b: { x: 128, y: 0, z: 220 } } });
    expect(b.click(null, base, S, stone, false)).toBeNull(); // on to its height
    expect(b.stage).toContain('height');
    // Up the line through that corner's middle (130, *, 222): from the side, at y = 2 + 10.
    const up = ray([150, 2, 222], [130, 12, 222]);
    b.move(up, S);
    const op = b.click(null, up, S, stone, false) as BuildOp;
    expect(op).toEqual({ shape: { kind: 'box', a: { x: 100, y: 0, z: 200 }, b: { x: 128, y: 12, z: 220 } }, size: S, material: stone, clear: false });
    expect(b.active).toBe(false);
    // 8 x 4 x 6 cells.
    expect((buildCells(op) as Cell[]).length).toBe(8 * 4 * 6);
  });

  it('a box raised downward, and kept at one layer when aimed at its base', () => {
    const b = new BuildMode();
    b.click(ground, ray(eye, ground.point), S, stone, false);
    const base = ray(eye, [130.5, 2, 221]);
    b.click(null, base, S, stone, false);
    expect(b.op(S, stone)!.shape).toMatchObject({ b: { y: 0 } }); // still flat
    b.move(ray([150, 2, 222], [130, -6, 222]), S); // 8 below: 2 cells down
    expect(b.op(S, stone)!.shape).toMatchObject({ b: { x: 128, y: -8, z: 220 } });
  });

  it('a line: along whichever axis the aim passes nearest', () => {
    const b = new BuildMode();
    b.tool = 'line';
    b.click(ground, ray(eye, ground.point), S, stone, false);
    // Aim at (122, 2.5, 202.5): along x, 20 units (5 cells) on.
    b.move(ray(eye, [122, 2.5, 202.5]), S);
    expect(b.op(S, stone)!.shape).toEqual({ kind: 'box', a: { x: 100, y: 0, z: 200 }, b: { x: 120, y: 0, z: 200 } });
    // Now up: from the side, at the column above the start.
    b.move(ray([102, 30, 230], [102, 30, 202]), S);
    expect(b.op(S, stone)!.shape).toEqual({ kind: 'box', a: { x: 100, y: 0, z: 200 }, b: { x: 100, y: 28, z: 200 } });
    const op = b.click(null, ray([102, 30, 230], [102, 30, 202]), S, stone, false) as BuildOp;
    expect((buildCells(op) as Cell[]).length).toBe(8);
  });

  it('round shapes: centred on the cell clicked, out to the cell aimed at, across the face clicked', () => {
    const b = new BuildMode();
    b.tool = 'dome';
    b.click(ground, ray(eye, ground.point), S, stone, false);
    // 5 cells out along x, on the plane through the start's middle (y = 2).
    b.move(ray(eye, [122.5, 2, 203]), S);
    const op = b.op(S, stone)!;
    expect(op.shape).toEqual({ kind: 'round', spec: { kind: 'dome', centre: { x: 102, y: 2, z: 202 }, axis: 1, sign: 1, outer: 22, thickness: null } });
    const cells = buildCells(op) as Cell[];
    // Its floor is the layer above the ground; the cell aimed at is in, the next one out isn't.
    expect(Math.min(...cells.map((c) => c.y))).toBe(0);
    expect(cells).toContainEqual({ x: 120, y: 0, z: 200 });
    expect(cells).not.toContainEqual({ x: 124, y: 0, z: 200 });
    expect(Math.max(...cells.map((c) => c.y))).toBe(20);
    // Hollow, 2 thick: a shell.
    b.hollow = true;
    b.thickness = 2;
    const shell = buildCells(b.op(S, stone)!) as Cell[];
    expect(shell.length).toBeLessThan(cells.length);
    expect(shell).not.toContainEqual({ x: 100, y: 0, z: 200 });
    expect(shell).toContainEqual({ x: 120, y: 0, z: 200 });
  });

  it('a circle on a wall stands across the wall\'s axis', () => {
    const b = new BuildMode();
    b.tool = 'circle';
    // A wall facing -x at x = 100: the cell in front of it is x = 96.
    b.click({ point: [100, 50.5, 210.2], normal: [-1, 0, 0] }, ray([80, 50, 210], [100, 50.5, 210.2]), S, stone, false);
    b.move(ray([80, 50, 210], [98, 50, 222]), S);
    const op = b.op(S, stone)!;
    expect(op.shape).toMatchObject({ kind: 'round', spec: { axis: 0, sign: -1, centre: { x: 98 } } });
    const cells = buildCells(op) as Cell[];
    expect(new Set(cells.map((c) => c.x))).toEqual(new Set([96]));
  });

  it('clearing (Shift as it starts) starts in what was aimed at, not beside it', () => {
    const b = new BuildMode();
    b.click(ground, ray(eye, ground.point), S, stone, true);
    const op = b.op(S, stone)!;
    expect(op.clear).toBe(true);
    expect(op.shape).toMatchObject({ kind: 'box', a: { x: 100, y: -4, z: 200 } });
  });

  it('right-click (cancel) and changing tool drop what was started; nothing aimed at starts nothing', () => {
    const b = new BuildMode();
    expect(b.click(null, ray(eye, [0, 0, 0]), S, stone, false)).toBeNull();
    expect(b.active).toBe(false);
    b.click(ground, ray(eye, ground.point), S, stone, false);
    b.cancel();
    expect(b.active).toBe(false);
    b.click(ground, ray(eye, ground.point), S, stone, false);
    b.nextTool();
    expect(b.active).toBe(false);
    expect(b.tool).toBe('circle');
    for (let i = 0; i < BUILD_TOOLS.length - 1; i++) b.nextTool(); // (round to where it started)
    expect(b.tool).toBe('box');
  });

  it('cells of a 1 m size snap to the 1 m grid', () => {
    const b = new BuildMode();
    b.click(ground, ray(eye, ground.point), 16, stone, false);
    b.move(ray(eye, [140, 8, 230]), 16);
    expect(b.op(16, stone)!.shape).toEqual({ kind: 'box', a: { x: 96, y: 0, z: 192 }, b: { x: 128, y: 0, z: 224 } });
  });
});

describe('BuildMode extrude', () => {
  /** Stone blocks 1 m: x 6..8, y 0, z 12 (block coordinates); the one at x 8 broken to 1/4 m. */
  const reader: BlockReader = (bx, by, bz) => {
    if (by !== 0 || bz !== 12 || bx < 6 || bx > 8) return null;
    if (bx < 8) return { kind: 'uniform', size: 16, material: stone };
    return blockFromVoxels(Array.from({ length: 64 }, (_, i) => ({ x: (i % 4) * 4, y: (Math.floor(i / 4) % 4) * 4, z: Math.floor(i / 16) * 4, size: 4, material: stone })));
  };
  const top = { point: [100.5, 16, 200.5], normal: [0, 1, 0] };

  it('takes the face clicked, then the depth aimed out or in, in steps of its smallest voxel', () => {
    const b = new BuildMode();
    b.reader = reader;
    b.tool = 'extrude';
    expect(b.stage).toMatch(/click a face/);
    const face = b.faceAt(top);
    expect(typeof face === 'string' ? face : face.face.length).toBe(2 + 16);
    expect(b.click(top, ray(eye, top.point), S, stone, false)).toBeNull();
    expect(b.extrusion!.step).toBe(4);
    // Aimed at the face itself: nothing yet (a click says so, and keeps it).
    expect(b.click(null, ray([130, 16, 200.5], [100.5, 16, 200.5]), S, stone, false)).toMatch(/aim out/);
    expect(b.active).toBe(true);
    // Up the line through the point clicked: 1.3 m up, 1.25 m in quarter-metre steps... 21 units: 20.
    b.move(ray([130, 37, 200.5], [100.5, 37, 200.5]), S);
    expect(b.extrusion!.depth).toBe(20);
    b.move(ray([130, 6, 200.5], [100.5, 6, 200.5]), S);
    expect(b.extrusion!.depth).toBe(-8);
    expect(b.click(null, ray([130, 6, 200.5], [100.5, 6, 200.5]), S, stone, false)).toEqual({ kind: 'extrude', x: 100, y: 15, z: 200, axis: 1, sign: 1, depth: -8 });
    expect(b.active).toBe(false);
  });

  it('says why a face cannot be taken', () => {
    const b = new BuildMode();
    b.reader = reader;
    b.tool = 'extrude';
    expect(b.click({ point: [100.5, 40, 200.5], normal: [0, 1, 0] }, ray(eye, [100, 40, 200]), S, stone, false)).toMatch(/nothing/);
    expect(b.active).toBe(false);
  });
});
