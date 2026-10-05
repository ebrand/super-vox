import { BLOCK_SIZE, BLOCKS_PER_AXIS, blockIndex, emptyChunk, type Block, type Chunk } from './chunk.js';
import { blockFromVoxels, blockVoxels, type BlockVoxel } from './edit.js';
import { designExtent, designMaterial, VoxelOccupancy, type ObjectDesign } from './designs.js';
import { Material, type MaterialId } from './materials.js';
import type { Facing } from './objects.js';
import type { Plan, PlanElement } from './plans.js';

/**
 * A plan laid out (see Plan): every block of what it means to build, exact. Walls are their
 * design (a piece of wall, its top) repeated along them, square to the nearest of the four
 * directions (a wall drawn at an angle: a staircase of pieces), its front (as drawn, its +Z side)
 * away from the plot's middle unless the wall is flipped; towers their design on top; below
 * both, their design's bottom layer repeated straight down into the ground; buildings their
 * design, on a foundation. Elements of no design are plain stone. Each piece stands on the ground
 * where it is, so walls step with it. Positions are blocks (meters), y up.
 */
export type LayoutDesign = Pick<ObjectDesign, 'id' | 'size' | 'states'>;

/** Quarter turns clockwise (seen from above) of each facing (as designVoxels turns). */
const TURNS: Record<Facing, number> = { n: 0, e: 1, s: 2, w: 3 };
/** The facing whose front (as drawn, +Z) looks each way: +z, -x, -z, +x. */
const FRONT: Record<'+z' | '-x' | '-z' | '+x', Facing> = { '+z': 'n', '-x': 'e', '-z': 's', '+x': 'w' };

/**
 * A design as a piece of a keep, turned to `facing`. Across (x and z) it's measured and placed in
 * units, on a grid of its largest voxel (`grid`): a piece of quarter-meter voxels can go anywhere a
 * quarter meter apart (and repeats every so many quarter meters), one with a whole-meter voxel only
 * on whole meters. Up, in whole blocks. Its voxels (turned, from its least corner: the box its
 * voxels take on that grid, see designExtent; not the box it was drawn in), and its bottom layer
 * (its lowest voxels, at their own sizes) repeated up a whole block: what's built below it,
 * straight down. (Where the bottom layer starts partway up its lowest blocks, those are filled below
 * it the same way, so nothing's left open between the two.)
 */
export interface LayoutPiece {
  /** Units across x and z its positions are multiples of: its largest voxel. */
  grid: number;
  /** Its size: units along x, blocks up, units along z, turned. */
  size: [number, number, number];
  voxels: BlockVoxel[];
  /** Its bottom layer repeated up a block (y 0 to BLOCK_SIZE), x and z as voxels'. */
  footing: BlockVoxel[];
  material: MaterialId;
}

/** A piece's voxels and footing as blocks, placed `sx`, `sz` units (0 to BLOCK_SIZE - 1) past a block's corner. */
export interface PlacedPiece {
  blocks: { dx: number; dy: number; dz: number; block: Block }[];
  /** Per column it stands on: its footing there. */
  body: { dx: number; dz: number; block: Block }[];
}

const pieces = new WeakMap<LayoutDesign, Map<Facing, LayoutPiece | null>>();
const placings = new WeakMap<LayoutPiece, Map<number, PlacedPiece>>();

export function layoutPiece(design: LayoutDesign, facing: Facing): LayoutPiece | null {
  let byFacing = pieces.get(design);
  if (!byFacing) pieces.set(design, (byFacing = new Map()));
  if (byFacing.has(facing)) return byFacing.get(facing)!;
  const piece = makePiece(design, facing);
  byFacing.set(facing, piece);
  return piece;
}

function makePiece(design: LayoutDesign, facing: Facing): LayoutPiece | null {
  const e = designExtent(design);
  if (!e) return null;
  const B = BLOCK_SIZE, vs = design.states[0]!.voxels;
  const grid = Math.max(...vs.map((v) => v.size));
  // (From the grid line at or below its least voxel: every voxel stays on its own size's grid.)
  const ox = Math.floor(e.x0 / grid) * grid, oz = Math.floor(e.z0 / grid) * grid, by = Math.floor(e.y0 / B);
  let w = Math.ceil(e.x1 / grid) * grid - ox, d = Math.ceil(e.z1 / grid) * grid - oz;
  const h = Math.ceil(e.y1 / B) - by, bottom = e.y0 - by * B;
  let voxels: BlockVoxel[] = vs.map((v) => ({ ...v, x: v.x - ox, y: v.y - by * B, z: v.z - oz }));
  for (let t = 0; t < TURNS[facing]; t++) {
    const depth = d;
    voxels = voxels.map((v) => ({ ...v, x: depth - v.z - v.size, z: v.x }));
    [w, d] = [d, w];
  }
  // The bottom layer repeated up a block; and under it, in its lowest blocks.
  const footing: BlockVoxel[] = [];
  for (const v of voxels) if (v.y === bottom) for (let y = 0; y < B; y += v.size) footing.push({ ...v, y });
  voxels = [...footing.filter((v) => v.y < bottom), ...voxels];
  return { grid, size: [w, h, d], voxels, footing, material: designMaterial(design as ObjectDesign) };
}

/** A piece placed `sx`, `sz` units past a block's corner (see PlacedPiece); made once for each. */
export function placePiece(p: LayoutPiece, sx: number, sz: number): PlacedPiece {
  let byShift = placings.get(p);
  if (!byShift) placings.set(p, (byShift = new Map()));
  const key = sx + BLOCK_SIZE * sz;
  let placed = byShift.get(key);
  if (placed) return placed;
  const B = BLOCK_SIZE;
  const group = (list: BlockVoxel[]) => {
    const out = new Map<string, BlockVoxel[]>();
    for (const v of list) {
      const x = v.x + sx, z = v.z + sz, dx = Math.floor(x / B), dy = Math.floor(v.y / B), dz = Math.floor(z / B), k = `${dx},${dy},${dz}`;
      let at = out.get(k);
      if (!at) out.set(k, (at = []));
      at.push({ ...v, x: x - dx * B, y: v.y - dy * B, z: z - dz * B });
    }
    return [...out].map(([k, list]) => {
      const [dx, dy, dz] = k.split(',').map(Number) as [number, number, number];
      return { dx, dy, dz, block: blockFromVoxels(list) };
    });
  };
  placed = { blocks: group(p.voxels), body: group(p.footing).map(({ dx, dz, block }) => ({ dx, dz, block })) };
  byShift.set(key, placed);
  return placed;
}

/** `v` to the nearest multiple of `grid`. */
const snap = (v: number, grid: number) => Math.round(v / grid) * grid;

/** Which way a wall's design faces (see Facing): its front away from the plot's middle (or toward it, flipped). */
export function wallFacing(e: Extract<PlanElement, { kind: 'wall' }>, plot: { x0: number; z0: number; x1: number; z1: number }): Facing {
  const alongX = Math.abs(e.x1 - e.x0) >= Math.abs(e.z1 - e.z0);
  // (Which side of the wall's middle the plot's middle is on.)
  const out = alongX ? (e.z0 + e.z1) / 2 >= (plot.z0 + plot.z1) / 2 : (e.x0 + e.x1) / 2 >= (plot.x0 + plot.x1) / 2;
  const front = alongX ? (out !== !!e.flip ? '+z' : '-z') : out !== !!e.flip ? '+x' : '-x';
  return FRONT[front];
}

/** The way a facing's front looks, in words (north is -z). */
export const FACING_OUT: Record<Facing, string> = { n: 'south', e: 'west', s: 'north', w: 'east' };

type Cell = { solid: MaterialId } | { block: Block; voxels?: BlockVoxel[]; occupied?: VoxelOccupancy };

/** Blocks being laid out, by "x,y,z" (blocks). */
export class Layout {
  readonly cells = new Map<string, Cell>();

  /** Fills a box of blocks [x0, x1) x [y0, y1) x [z0, z1) solid (over anything but what's solid already). */
  solid(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: MaterialId, keep?: (x: number, z: number) => boolean): void {
    for (let x = x0; x < x1; x++)
      for (let z = z0; z < z1; z++) {
        if (keep && !keep(x, z)) continue;
        for (let y = y0; y < y1; y++) this.cells.set(`${x},${y},${z}`, { solid: material });
      }
  }

  /** Puts a block's voxels at (x, y, z): into an empty block, and beside what's there in another (not over it). */
  private put(x: number, y: number, z: number, block: Block): void {
    if (!block) return;
    const key = `${x},${y},${z}`;
    const there = this.cells.get(key);
    if (!there) {
      this.cells.set(key, { block });
      return;
    }
    if ('solid' in there || there.block === block) return;
    if (!there.voxels) {
      there.voxels = blockVoxels(there.block);
      there.occupied = new VoxelOccupancy(there.voxels);
    }
    for (const v of blockVoxels(block))
      if (!there.occupied!.overlaps(v)) {
        there.voxels.push(v);
        there.occupied!.add(v);
      }
  }

  /** A piece's body (its footing, see LayoutPiece) under it at (x, z) units, from block y0 up to y1. */
  body(p: LayoutPiece, x: number, y0: number, z: number, y1: number, keep?: (x: number, z: number) => boolean): void {
    const bx = Math.floor(x / BLOCK_SIZE), bz = Math.floor(z / BLOCK_SIZE);
    for (const c of placePiece(p, x - bx * BLOCK_SIZE, z - bz * BLOCK_SIZE).body) {
      if (keep && !keep(bx + c.dx, bz + c.dz)) continue;
      for (let y = y0; y < y1; y++) this.put(bx + c.dx, y, bz + c.dz, c.block);
    }
  }

  /** Places a piece with its least corner at (x, z) units and block y: beside what's there, never over it. */
  piece(p: LayoutPiece, x: number, y: number, z: number, keep?: (x: number, z: number) => boolean): void {
    const bx = Math.floor(x / BLOCK_SIZE), bz = Math.floor(z / BLOCK_SIZE);
    for (const b of placePiece(p, x - bx * BLOCK_SIZE, z - bz * BLOCK_SIZE).blocks) {
      if (keep && !keep(bx + b.dx, bz + b.dz)) continue;
      this.put(bx + b.dx, y + b.dy, bz + b.dz, b.block);
    }
  }

  /** The block at (x, y, z). */
  blockAt(x: number, y: number, z: number): Block {
    const c = this.cells.get(`${x},${y},${z}`);
    if (!c) return null;
    if ('solid' in c) return { kind: 'uniform', size: BLOCK_SIZE, material: c.solid };
    return c.voxels ? blockFromVoxels(c.voxels) : c.block;
  }

  get size(): number {
    return this.cells.size;
  }

  /** The chunks it fills (see Chunk), each only what's laid out (air elsewhere). */
  chunks(): Chunk[] {
    const out = new Map<string, Chunk>();
    const solids = new Map<MaterialId, Block>();
    const N = BLOCKS_PER_AXIS;
    for (const [key, c] of this.cells) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const cx = Math.floor(x / N), cy = Math.floor(y / N), cz = Math.floor(z / N), ck = `${cx},${cy},${cz}`;
      let chunk = out.get(ck);
      if (!chunk) out.set(ck, (chunk = emptyChunk({ cx, cy, cz })));
      let block: Block;
      if ('solid' in c) {
        // (One block object for each material: shared, as chunks share them.)
        block = solids.get(c.solid) ?? null;
        if (!block) solids.set(c.solid, (block = { kind: 'uniform', size: BLOCK_SIZE, material: c.solid }));
      } else block = c.voxels ? blockFromVoxels(c.voxels) : c.block;
      chunk.blocks[blockIndex(x - cx * N, y - cy * N, z - cz * N)] = block;
    }
    return [...out.values()];
  }
}

type Ground = (x: number, z: number) => number | null;

/** The ground's lowest and highest (m) under the blocks [x0, x1) x [z0, z1) where `keep`; 0 where nothing's known. */
function groundUnder(groundAt: Ground, x0: number, z0: number, x1: number, z1: number, keep?: (x: number, z: number) => boolean): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let x = x0; x < x1; x++)
    for (let z = z0; z < z1; z++) {
      if (keep && !keep(x, z)) continue;
      const g = groundAt(x + 0.5, z + 0.5);
      if (g === null) continue;
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/** How far into the ground (m) walls, towers and foundations go below its lowest point under them. */
export const LAYOUT_FOOTING = 1;

/**
 * Where a wall's pieces go: each `along` units along it and `across` deep, least corners (units),
 * on a grid of `grid` units. Drawn at an angle, each is across where the line is at its middle: a
 * staircase, as fine as the grid lets it be.
 */
export function wallSections(e: Extract<PlanElement, { kind: 'wall' }>, along: number, across: number, grid = BLOCK_SIZE): { x: number; z: number; alongX: boolean }[] {
  const U = BLOCK_SIZE, alongX = Math.abs(e.x1 - e.x0) >= Math.abs(e.z1 - e.z0);
  const [a0, a1, c0, c1] = (alongX ? [e.x0, e.x1, e.z0, e.z1] : [e.z0, e.z1, e.x0, e.x1]).map((m) => m * U) as [number, number, number, number];
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  // Out past each end by half its depth (so walls meeting at a corner close it), whole pieces.
  const n = Math.max(1, Math.ceil((hi - lo + across) / along));
  const start = snap((lo + hi) / 2 - (n * along) / 2, grid);
  const out: { x: number; z: number; alongX: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * along, mid = a + along / 2;
    const t = Math.min(1, Math.max(0, (mid - a0) / (a1 - a0)));
    const c = snap(c0 + t * (c1 - c0) - across / 2, grid);
    out.push(alongX ? { x: a, z: c, alongX } : { x: c, z: a, alongX });
  }
  return out;
}

/** The blocks (x0, z0, x1, z1) units [x0, x1) x [z0, z1) are in. */
const blocksOver = (x0: number, z0: number, x1: number, z1: number): [number, number, number, number] => {
  const B = BLOCK_SIZE;
  return [Math.floor(x0 / B), Math.floor(z0 / B), Math.ceil(x1 / B), Math.ceil(z1 / B)];
};

/**
 * Lays out `plan` on a plot (meters) over the ground (`groundAt`: meters, at a point; null where
 * it isn't known), with the designs it's made of (`designOf`; one not there: plain).
 */
export function layoutPlan(plan: Plan, plot: { x0: number; z0: number; x1: number; z1: number }, designOf: (id: string) => LayoutDesign | undefined, groundAt: Ground): Layout {
  const out = new Layout(), U = BLOCK_SIZE;
  const pieceOf = (e: PlanElement, facing: Facing) => {
    const d = e.design ? designOf(e.design) : undefined;
    return d ? layoutPiece(d, facing) : null;
  };
  // Inside towers, nothing of walls (that run into them): what's in a tower is the tower's.
  const towers = plan.elements.filter((e): e is Extract<PlanElement, { kind: 'tower' }> => e.kind === 'tower');
  const outsideTowers = (x: number, z: number) => towers.every((t) => (x + 0.5 - t.x) ** 2 + (z + 0.5 - t.z) ** 2 >= t.radius ** 2);
  /** The columns (blocks) a piece at (x, z) units stands on. */
  const standsOn = (p: LayoutPiece, x: number, z: number) => {
    const bx = Math.floor(x / U), bz = Math.floor(z / U);
    const on = new Set(placePiece(p, x - bx * U, z - bz * U).body.map((c) => `${bx + c.dx},${bz + c.dz}`));
    return (cx: number, cz: number) => on.has(`${cx},${cz}`);
  };
  // Bodies first, then designs (which go beside what's there, never over it).
  const tops: (() => void)[] = [];
  for (const e of plan.elements) {
    if (e.kind === 'wall') {
      const facing = wallFacing(e, plot), p = pieceOf(e, facing);
      const alongX = Math.abs(e.x1 - e.x0) >= Math.abs(e.z1 - e.z0);
      // (A plain wall: stone, in meter pieces, so it steps finely.)
      const [sx, sy, sz] = p ? p.size : alongX ? [U, 0, e.thickness * U] : [e.thickness * U, 0, U];
      const along = alongX ? sx : sz, across = alongX ? sz : sx;
      for (const s of wallSections(e, along, across, p?.grid ?? U)) {
        const [x0, z0, x1, z1] = blocksOver(s.x, s.z, s.x + sx, s.z + sz);
        const [lo, hi] = groundUnder(groundAt, x0, z0, x1, z1, outsideTowers);
        const bottom = Math.floor(lo) - LAYOUT_FOOTING, top = Math.ceil(hi) + e.height, capAt = Math.max(bottom, top - sy);
        if (!p) {
          out.solid(x0, bottom, z0, x1, capAt, z1, Material.Stone, outsideTowers);
          continue;
        }
        out.body(p, s.x, bottom, s.z, capAt, outsideTowers);
        tops.push(() => out.piece(p, s.x, capAt, s.z, outsideTowers));
      }
    } else if (e.kind === 'tower') {
      const p = pieceOf(e, 'n');
      if (p) {
        // (Centered on its middle, as near as its grid lets it be.)
        const [w, h, d] = p.size, x = snap(e.x * U - w / 2, p.grid), z = snap(e.z * U - d / 2, p.grid);
        const [lo, hi] = groundUnder(groundAt, ...blocksOver(x, z, x + w, z + d), standsOn(p, x, z));
        const bottom = Math.floor(lo) - LAYOUT_FOOTING, top = Math.ceil(hi) + e.height, capAt = Math.max(bottom, top - h);
        out.body(p, x, bottom, z, capAt);
        tops.push(() => out.piece(p, x, capAt, z));
      } else {
        const r = e.radius, x0 = Math.floor(e.x - r), z0 = Math.floor(e.z - r), x1 = Math.ceil(e.x + r), z1 = Math.ceil(e.z + r);
        const inside = (x: number, z: number) => (x + 0.5 - e.x) ** 2 + (z + 0.5 - e.z) ** 2 < r * r;
        const [lo, hi] = groundUnder(groundAt, x0, z0, x1, z1, inside);
        out.solid(x0, Math.floor(lo) - LAYOUT_FOOTING, z0, x1, Math.ceil(hi) + e.height, z1, Material.Stone, inside);
      }
    } else {
      const p = pieceOf(e, 'n');
      const [x1, z1] = p ? blocksOver(e.x0 * U, e.z0 * U, e.x0 * U + p.size[0], e.z0 * U + p.size[2]).slice(2) as [number, number] : [e.x1, e.z1];
      const [lo, hi] = groundUnder(groundAt, e.x0, e.z0, x1, z1);
      const bottom = Math.floor(lo) - LAYOUT_FOOTING, floor = Math.ceil(hi);
      if (!p) out.solid(e.x0, bottom, e.z0, e.x1, floor + e.height, e.z1, Material.Stone);
      else {
        // (Its design on a stone foundation, under what it stands on, up to the ground's highest.)
        out.solid(e.x0, bottom, e.z0, x1, floor, z1, Material.Stone, standsOn(p, e.x0 * U, e.z0 * U));
        tops.push(() => out.piece(p, e.x0 * U, floor, e.z0 * U));
      }
    }
  }
  for (const t of tops) t();
  return out;
}
