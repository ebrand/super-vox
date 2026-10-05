import { describe, expect, it } from 'vitest';
import { blockVoxels, type BlockVoxel } from './edit.js';
import { BLOCK_SIZE, blockIndex, BLOCKS_PER_AXIS } from './chunk.js';
import { layoutPiece, layoutPlan, wallFacing, wallSections, type LayoutDesign } from './layout.js';
import { Material } from './materials.js';
import type { Plan, PlanElement } from './plans.js';

const S: number = Material.Stone, F: number = Material.PaleStone;
const plot = { x0: 100, z0: 100, x1: 300, z1: 260 }; // its middle: (200, 180)
const flat = () => 10;
const B = BLOCK_SIZE;
const cube = (x: number, y: number, z: number, material = S): BlockVoxel => ({ x: x * B, y: y * B, z: z * B, size: B, material });

/**
 * A crenellated wall top 4 m along (x), 2 m high, 2 m deep (front: +z), drawn 1 m in from its
 * box's corner: a solid course of stone, and on it merlons at x 0 and 2, their front (z 1) pale.
 */
function crenels(): LayoutDesign {
  const voxels: BlockVoxel[] = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) voxels.push(cube(x + 1, 1, z + 1));
  for (const x of [0, 2]) voxels.push(cube(x + 1, 2, 1), cube(x + 1, 2, 2, F));
  return { id: 'crenels', size: [6, 4, 4], states: [{ name: 's', voxels }] };
}

/** A ring 1 m thick, 6 m across, 1 m high, as a tower top. */
function ring(): LayoutDesign {
  const voxels: BlockVoxel[] = [];
  for (let x = 0; x < 6; x++)
    for (let z = 0; z < 6; z++) {
      const d = Math.hypot(x + 0.5 - 3, z + 0.5 - 3);
      if (d <= 3 && d > 2) voxels.push(cube(x, 0, z));
    }
  return { id: 'ring', size: [6, 1, 6], states: [{ name: 's', voxels }] };
}

const wall = (over: Partial<Extract<PlanElement, { kind: 'wall' }>> = {}): PlanElement => ({ kind: 'wall', id: 'w', x0: 110, z0: 120, x1: 130, z1: 120, thickness: 2, height: 6, design: 'crenels', ...over });
const designs = new Map([crenels(), ring()].map((d) => [d.id, d]));
const lay = (elements: PlanElement[], ground: (x: number, z: number) => number | null = flat) => layoutPlan({ elements } as Plan, plot, (id) => designs.get(id), ground);
const material = (l: ReturnType<typeof lay>, x: number, y: number, z: number) => {
  const b = l.blockAt(x, y, z);
  if (!b) return null;
  const ms = new Set(blockVoxels(b).map((v) => v.material));
  return ms.size === 1 ? [...ms][0]! : 'mixed';
};

describe('layout', () => {
  it('a design as a piece: the blocks its voxels take, turned', () => {
    const p = layoutPiece(crenels(), 'n')!;
    expect(p.span).toEqual([4, 2, 2]);
    expect(p.material).toBe(S);
    // Its front (pale) at +z facing north; at -x facing east (a quarter turn clockwise), and so on.
    const front = (f: 'n' | 'e' | 's' | 'w') => layoutPiece(crenels(), f)!.blocks.filter((b) => b.block && blockVoxels(b.block)[0]!.material === F).map((b) => [b.dx, b.dz]);
    expect(front('n')).toEqual([[0, 1], [2, 1]]);
    expect(layoutPiece(crenels(), 'e')!.span).toEqual([2, 2, 4]);
    expect(front('e').every(([x]) => x === 0)).toBe(true);
    expect(front('s').every(([, z]) => z === 0)).toBe(true);
    expect(front('w').every(([x]) => x === 1)).toBe(true);
    expect([...p.base]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('turns walls\' fronts away from the plot\'s middle, or toward it flipped', () => {
    const w = wall() as Extract<PlanElement, { kind: 'wall' }>;
    expect(wallFacing(w, plot)).toBe('s'); // north of the middle: its front looks north (-z)
    expect(wallFacing({ ...w, flip: true }, plot)).toBe('n');
    expect(wallFacing({ ...w, z0: 250, z1: 250 }, plot)).toBe('n');
    expect(wallFacing({ ...w, x0: 110, z0: 120, x1: 110, z1: 200 }, plot)).toBe('e'); // west: looks west
    expect(wallFacing({ ...w, x0: 290, z0: 120, x1: 290, z1: 200 }, plot)).toBe('w');
  });

  it('repeats a wall\'s design along it, on a solid wall as high as planned, into the ground', () => {
    const l = lay([wall()]);
    // 20 m, out a metre past each end: 6 pieces of 4 m, from x 108 to 132; 2 m deep, z 119-120.
    expect(wallSections(wall() as Extract<PlanElement, { kind: 'wall' }>, 4, 2).map((s) => [s.x, s.z])).toEqual([108, 112, 116, 120, 124, 128].map((x) => [x, 119]));
    // The ground at 10: its top at 16 (6 m), the design the top 2 m; solid below, from 9 (a metre in).
    for (let x = 108; x < 132; x++)
      for (const z of [119, 120]) {
        for (let y = 9; y < 15; y++) expect(material(l, x, y, z)).toBe(S);
        expect(material(l, x, 8, z)).toBeNull();
        // The top course: merlons at every other metre (turned half about: at 1 and 3 of each 4),
        // their fronts (pale) north, at z 119.
        const merlon = (x - 108) % 4 === 1 || (x - 108) % 4 === 3;
        expect(material(l, x, 15, z)).toBe(!merlon ? null : z === 119 ? F : S);
        expect(material(l, x, 16, z)).toBeNull();
      }
    expect(material(l, 107, 12, 119)).toBeNull();
    expect(material(l, 132, 12, 119)).toBeNull();
    expect(material(l, 120, 12, 118)).toBeNull();
    // Flipped: the fronts to the south.
    const flipped = lay([wall({ flip: true })]);
    expect(material(flipped, 108, 15, 120)).toBe(F);
    expect(material(flipped, 108, 15, 119)).toBe(S);
  });

  it('steps with the ground, a piece at a time', () => {
    // The ground rising a metre every 4 m east (its highest under each piece: what it stands on).
    const l = lay([wall()], (x) => Math.floor((x - 108) / 4));
    for (let i = 0; i < 6; i++) {
      const x = 109 + i * 4;
      expect(material(l, x, i + 5, 119)).toBe(F); // a merlon, its top the ground's + 6 m
      expect(material(l, x, i + 6, 119)).toBeNull();
      expect(material(l, x, i - 1, 119)).toBe(S);
      expect(material(l, x, i - 2, 119)).toBeNull();
    }
  });

  it('lays a wall drawn at an angle as a staircase of pieces square to the nearer direction', () => {
    const w = wall({ x1: 130, z1: 130 }) as Extract<PlanElement, { kind: 'wall' }>;
    const sections = wallSections(w, 4, 2);
    expect(sections.every((s) => s.alongX)).toBe(true);
    // Each across where the line is at its middle: 10 m up over 20 along, half a metre a metre.
    for (const s of sections) {
      const t = Math.min(1, Math.max(0, (s.x + 2 - 110) / 20));
      expect(s.z).toBe(Math.round(120 + t * 10 - 1));
    }
    expect(new Set(sections.map((s) => s.z)).size).toBeGreaterThan(3);
    // Steeper than 45°: along z instead, each piece turned (2 m across in x, 4 along z).
    const steep = wallSections(wall({ x1: 115, z1: 140 }) as Extract<PlanElement, { kind: 'wall' }>, 4, 2);
    expect(steep.every((s) => !s.alongX)).toBe(true);
    const l = lay([wall({ x1: 115, z1: 140 })]);
    const s0 = steep[1]!;
    expect(material(l, s0.x, 12, s0.z)).toBe(S);
    expect(material(l, s0.x + 1, 12, s0.z + 3)).toBe(S);
    expect(material(l, s0.x + 2, 12, s0.z)).toBeNull();
  });

  it('builds a tower below its top as the top\'s bottom layer is (a ring: hollow), plain towers solid', () => {
    const t: PlanElement = { kind: 'tower', id: 't', x: 150, z: 150, radius: 3, height: 12, design: 'ring' };
    const l = lay([t]);
    // Top at 22 (10 + 12): the ring its top metre, the ring straight down to 9 below.
    expect(material(l, 147, 21, 150)).toBe(S);
    expect(material(l, 147, 9, 150)).toBe(S);
    expect(material(l, 147, 22, 150)).toBeNull();
    expect(material(l, 150, 15, 150)).toBeNull(); // inside: hollow
    const plain = lay([{ kind: 'tower', id: 't', x: 150, z: 150, radius: 3, height: 12 }]);
    expect(material(plain, 150, 15, 150)).toBe(S);
    expect(material(plain, 147, 21, 150)).toBe(S);
    expect(material(plain, 147, 22, 150)).toBeNull();
    expect(material(plain, 146, 15, 150)).toBeNull(); // outside its 3 m radius
  });

  it('builds below a top its bottom layer, at its own voxel sizes, repeated down (and under it, where it starts partway up)', () => {
    // A thin ring-like wall: its bottom layer half-metre voxels (pale) along the front half of each
    // column, starting a half metre up its block; stone 1 m voxels above.
    const voxels: BlockVoxel[] = [];
    for (let x = 0; x < 4; x++) {
      for (const hx of [0, 8]) voxels.push({ x: x * B + hx, y: 8, z: 8, size: 8, material: F });
      voxels.push(cube(x, 1, 0));
    }
    const thin: LayoutDesign = { id: 'thin', size: [4, 2, 1], states: [{ name: 's', voxels }] };
    const p = layoutPiece(thin, 'n')!;
    expect(p.span).toEqual([4, 2, 1]);
    // Each column's body: two half-metre voxels across, two up, in its front half (z 8).
    const body = blockVoxels(p.body[0]!);
    expect(body.map((v) => [v.x, v.y, v.z, v.size, v.material]).sort()).toEqual([[0, 0, 8, 8, F], [0, 8, 8, 8, F], [8, 0, 8, 8, F], [8, 8, 8, 8, F]].sort());
    // Its lowest block filled under the bottom layer too (y 0 under y 8).
    const lowest = p.blocks.find((b) => b.dx === 0 && b.dy === 0)!;
    expect(blockVoxels(lowest.block).filter((v) => v.y === 0 && v.size === 8)).toHaveLength(2);
    // Laid out (facing south, turned half about: the front half at z 0): the body is that, not solid metres.
    const l = layoutPlan({ elements: [wall({ design: 'thin', thickness: 1 })] }, plot, (id) => (id === 'thin' ? thin : undefined), flat);
    const sec = wallSections(wall() as Extract<PlanElement, { kind: 'wall' }>, 4, 1)[0]!;
    const b = l.blockAt(sec.x, 12, sec.z)!;
    expect(blockVoxels(b).map((v) => [v.size, v.z, v.material])).toEqual([[8, 0, F], [8, 0, F], [8, 0, F], [8, 0, F]]);
    expect(material(l, sec.x, 9, sec.z)).toBe(F); // down into the ground
    expect(material(l, sec.x, 8, sec.z)).toBeNull();
  });

  it('keeps walls out of the towers they run into', () => {
    const t: PlanElement = { kind: 'tower', id: 't', x: 130, z: 120, radius: 3, height: 12, design: 'ring' };
    const l = lay([wall(), t]);
    expect(material(l, 130, 12, 119)).toBeNull(); // in the tower: empty
    expect(material(l, 126, 12, 119)).toBe(S); // the wall, just outside it
    expect(material(l, 127, 12, 119)).toBe(S); // the tower's ring
  });

  it('builds plain buildings solid, and designed ones on a foundation', () => {
    const b: PlanElement = { kind: 'building', id: 'b', x0: 140, z0: 140, x1: 146, z1: 146, height: 5 };
    const l = lay([b], (x) => (x < 143 ? 10 : 12));
    expect(material(l, 140, 16, 140)).toBe(S); // the ground's highest (12) + 5, its top metre
    expect(material(l, 140, 17, 140)).toBeNull();
    expect(material(l, 140, 9, 140)).toBe(S);
    expect(material(l, 146, 12, 140)).toBeNull();
    const designed = lay([{ ...b, design: 'ring', x1: 146, z1: 146 }], (x) => (x < 143 ? 10 : 12));
    expect(material(designed, 140, 12, 142)).toBe(S); // the ring, on the ground's highest
    expect(material(designed, 140, 13, 142)).toBeNull();
    expect(material(designed, 140, 9, 142)).toBe(S); // its foundation, under the ring only
    expect(material(designed, 143, 11, 143)).toBeNull();
  });

  it('puts pieces beside one another where they share a block, never over', () => {
    // Two 1/2 m voxel pieces: one in a block's low half, one its whole low corner and its high half.
    const low: LayoutDesign = { id: 'low', size: [1, 1, 1], states: [{ name: 's', voxels: [{ x: 0, y: 0, z: 0, size: 8, material: S }] }] };
    const two: LayoutDesign = { id: 'two', size: [1, 1, 1], states: [{ name: 's', voxels: [{ x: 0, y: 0, z: 0, size: 8, material: F }, { x: 0, y: 8, z: 0, size: 8, material: F }] }] };
    const l = layoutPlan({ elements: [] }, plot, () => undefined, flat);
    l.piece(layoutPiece(low, 'n')!, 0, 0, 0);
    l.piece(layoutPiece(two, 'n')!, 0, 0, 0);
    const vs = blockVoxels(l.blockAt(0, 0, 0)).map((v) => [v.y, v.material]);
    expect(vs).toEqual([[0, S], [8, F]]);
  });

  it('fills chunks with what it lays out', () => {
    const l = lay([wall()]);
    const chunks = l.chunks();
    let n = 0;
    for (const c of chunks)
      c.blocks.forEach((b, i) => {
        if (!b) return;
        n++;
        const N = BLOCKS_PER_AXIS, x = (i % N) + c.cx * N, z = (Math.floor(i / N) % N) + c.cz * N, y = Math.floor(i / (N * N)) + c.cy * N;
        expect(blockIndex(x - c.cx * N, y - c.cy * N, z - c.cz * N)).toBe(i);
        expect(l.blockAt(x, y, z)).not.toBeNull();
      });
    expect(n).toBe(l.size);
    // Chunks at x 96-111, 112-127, 128-143 (blocks), y 0-15 and 16-31 would hold a wall 9-15 high: y 0-15 only.
    expect(chunks.map((c) => `${c.cx},${c.cy},${c.cz}`).sort()).toEqual(['6,0,7', '7,0,7', '8,0,7']);
  });
});
