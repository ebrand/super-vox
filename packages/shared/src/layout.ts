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
 * away from the plot's middle unless the wall is flipped, solid below it down into the ground;
 * towers their design on top, below it straight down what its bottom layer is; buildings their
 * design, on a foundation. Elements of no design are plain stone. Each piece stands on the ground
 * where it is, so walls step with it. Positions are blocks (metres), y up.
 */
export type LayoutDesign = Pick<ObjectDesign, 'id' | 'size' | 'states'>;

/** Quarter turns clockwise (seen from above) of each facing (as designVoxels turns). */
const TURNS: Record<Facing, number> = { n: 0, e: 1, s: 2, w: 3 };
/** The facing whose front (as drawn, +Z) looks each way: +z, -x, -z, +x. */
const FRONT: Record<'+z' | '-x' | '-z' | '+x', Facing> = { '+z': 'n', '-x': 'e', '-z': 's', '+x': 'w' };

/**
 * A design as a piece of a keep, turned to `facing`: the whole blocks its voxels take (see
 * designExtent; not the box it was drawn in), each block's voxels, and its bottom layer as
 * columns (see designBase).
 */
export interface LayoutPiece {
  /** Blocks along x, y and z, turned. */
  span: [number, number, number];
  blocks: { dx: number; dy: number; dz: number; block: Block }[];
  /** Columns (dx + span[0] * dz) its lowest layer of voxels stands on. */
  base: Uint8Array;
  material: MaterialId;
}

const pieces = new WeakMap<LayoutDesign, Map<Facing, LayoutPiece | null>>();

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
  const B = BLOCK_SIZE;
  const bx = Math.floor(e.x0 / B), by = Math.floor(e.y0 / B), bz = Math.floor(e.z0 / B);
  let w = Math.ceil(e.x1 / B) - bx, d = Math.ceil(e.z1 / B) - bz;
  const h = Math.ceil(e.y1 / B) - by, bottom = e.y0 - by * B;
  let voxels: BlockVoxel[] = design.states[0]!.voxels.map((v) => ({ ...v, x: v.x - bx * B, y: v.y - by * B, z: v.z - bz * B }));
  for (let t = 0; t < TURNS[facing]; t++) {
    const depth = d * B;
    voxels = voxels.map((v) => ({ ...v, x: depth - v.z - v.size, z: v.x }));
    [w, d] = [d, w];
  }
  const local = new Map<number, BlockVoxel[]>();
  const base = new Uint8Array(w * d);
  for (const v of voxels) {
    const dx = Math.floor(v.x / B), dy = Math.floor(v.y / B), dz = Math.floor(v.z / B);
    const k = (dy * d + dz) * w + dx;
    let list = local.get(k);
    if (!list) local.set(k, (list = []));
    list.push({ ...v, x: v.x - dx * B, y: v.y - dy * B, z: v.z - dz * B });
    if (v.y === bottom) base[dx + w * dz] = 1;
  }
  const blocks = [...local].map(([k, list]) => ({ dx: k % w, dz: Math.floor(k / w) % d, dy: Math.floor(k / (w * d)), block: blockFromVoxels(list) }));
  return { span: [w, h, d], blocks, base, material: designMaterial(design as ObjectDesign) };
}

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

  /** Places a piece with its least corner at block (x, y, z): into empty blocks, and beside what's there in others (not over it). */
  piece(p: LayoutPiece, x: number, y: number, z: number, keep?: (x: number, z: number) => boolean): void {
    for (const b of p.blocks) {
      if (!b.block || (keep && !keep(x + b.dx, z + b.dz))) continue;
      const key = `${x + b.dx},${y + b.dy},${z + b.dz}`;
      const there = this.cells.get(key);
      if (!there) {
        this.cells.set(key, { block: b.block });
        continue;
      }
      if ('solid' in there) continue;
      // (Another piece's voxels there: this one's go in where they don't overlap them.)
      if (!there.voxels) {
        there.voxels = blockVoxels(there.block);
        there.occupied = new VoxelOccupancy(there.voxels);
      }
      for (const v of blockVoxels(b.block))
        if (!there.occupied!.overlaps(v)) {
          there.voxels.push(v);
          there.occupied!.add(v);
        }
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

/** Where a wall's pieces go: each `along` blocks along it and `across` deep, least corners (blocks). */
export function wallSections(e: Extract<PlanElement, { kind: 'wall' }>, along: number, across: number): { x: number; z: number; alongX: boolean }[] {
  const alongX = Math.abs(e.x1 - e.x0) >= Math.abs(e.z1 - e.z0);
  const [a0, a1, c0, c1] = alongX ? [e.x0, e.x1, e.z0, e.z1] : [e.z0, e.z1, e.x0, e.x1];
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  // Out past each end by half its depth (so walls meeting at a corner close it), whole pieces.
  const n = Math.max(1, Math.ceil((hi - lo + across) / along));
  const start = Math.round((lo + hi) / 2 - (n * along) / 2);
  const out: { x: number; z: number; alongX: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * along, mid = a + along / 2;
    // (Across, where the line is at the piece's middle: a staircase, drawn at an angle.)
    const t = Math.min(1, Math.max(0, (mid - a0) / (a1 - a0)));
    const c = Math.round(c0 + t * (c1 - c0) - across / 2);
    out.push(alongX ? { x: a, z: c, alongX } : { x: c, z: a, alongX });
  }
  return out;
}

/**
 * Lays out `plan` on a plot (metres) over the ground (`groundAt`: metres, at a point; null where
 * it isn't known), with the designs it's made of (`designOf`; one not there: plain).
 */
export function layoutPlan(plan: Plan, plot: { x0: number; z0: number; x1: number; z1: number }, designOf: (id: string) => LayoutDesign | undefined, groundAt: Ground): Layout {
  const out = new Layout();
  const pieceOf = (e: PlanElement, facing: Facing) => {
    const d = e.design ? designOf(e.design) : undefined;
    return d ? layoutPiece(d, facing) : null;
  };
  // Inside towers, nothing of walls (that run into them): what's in a tower is the tower's.
  const towers = plan.elements.filter((e): e is Extract<PlanElement, { kind: 'tower' }> => e.kind === 'tower');
  const outsideTowers = (x: number, z: number) => towers.every((t) => (x + 0.5 - t.x) ** 2 + (z + 0.5 - t.z) ** 2 >= t.radius ** 2);
  // Bodies first, then designs (which go beside what's there, never over it).
  const tops: (() => void)[] = [];
  for (const e of plan.elements) {
    if (e.kind === 'wall') {
      const facing = wallFacing(e, plot), p = pieceOf(e, facing);
      const alongX = Math.abs(e.x1 - e.x0) >= Math.abs(e.z1 - e.z0);
      // (A plain wall: stone, in metre pieces, so it steps finely.)
      const [sx, sy, sz] = p ? p.span : alongX ? [1, 0, e.thickness] : [e.thickness, 0, 1];
      const along = alongX ? sx : sz, across = alongX ? sz : sx;
      for (const s of wallSections(e, along, across)) {
        const [lo, hi] = groundUnder(groundAt, s.x, s.z, s.x + sx, s.z + sz, outsideTowers);
        const bottom = Math.floor(lo) - LAYOUT_FOOTING, top = Math.ceil(hi) + e.height, capAt = Math.max(bottom, top - sy);
        out.solid(s.x, bottom, s.z, s.x + sx, capAt, s.z + sz, p?.material ?? Material.Stone, outsideTowers);
        if (p) tops.push(() => out.piece(p, s.x, capAt, s.z, outsideTowers));
      }
    } else if (e.kind === 'tower') {
      const p = pieceOf(e, 'n');
      if (p) {
        const [w, h, d] = p.span, x = Math.round(e.x - w / 2), z = Math.round(e.z - d / 2);
        const onBase = (bx: number, bz: number) => !!p.base[bx - x + w * (bz - z)];
        const [lo, hi] = groundUnder(groundAt, x, z, x + w, z + d, onBase);
        const bottom = Math.floor(lo) - LAYOUT_FOOTING, top = Math.ceil(hi) + e.height, capAt = Math.max(bottom, top - h);
        out.solid(x, bottom, z, x + w, capAt, z + d, p.material, onBase);
        tops.push(() => out.piece(p, x, capAt, z));
      } else {
        const r = e.radius, x0 = Math.floor(e.x - r), z0 = Math.floor(e.z - r), x1 = Math.ceil(e.x + r), z1 = Math.ceil(e.z + r);
        const inside = (x: number, z: number) => (x + 0.5 - e.x) ** 2 + (z + 0.5 - e.z) ** 2 < r * r;
        const [lo, hi] = groundUnder(groundAt, x0, z0, x1, z1, inside);
        out.solid(x0, Math.floor(lo) - LAYOUT_FOOTING, z0, x1, Math.ceil(hi) + e.height, z1, Material.Stone, inside);
      }
    } else {
      const p = pieceOf(e, 'n');
      const [w, , d] = p ? p.span : [e.x1 - e.x0, 0, e.z1 - e.z0];
      const [lo, hi] = groundUnder(groundAt, e.x0, e.z0, e.x0 + w, e.z0 + d);
      const bottom = Math.floor(lo) - LAYOUT_FOOTING, floor = Math.ceil(hi);
      if (!p) out.solid(e.x0, bottom, e.z0, e.x1, floor + e.height, e.z1, Material.Stone);
      else {
        // (Its design on a stone foundation, under what it stands on, up to the ground's highest.)
        out.solid(e.x0, bottom, e.z0, e.x0 + w, floor, e.z0 + d, Material.Stone, (x, z) => !!p.base[x - e.x0 + w * (z - e.z0)]);
        tops.push(() => out.piece(p, e.x0, floor, e.z0));
      }
    }
  }
  for (const t of tops) t();
  return out;
}
