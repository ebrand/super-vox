import { BLOCK_SIZE } from './chunk.js';
import type { MaterialId } from './materials.js';

/**
 * Shapes made of cells (cubes of one size, on that size's grid; units): boxes, lines, and round
 * shapes (circles, domes, spheres). The object designer draws with them (see the client's
 * designEditor.ts), and creative players build with them in the world (see BuildOp).
 */

/** A box of units, [x0, x1) x [y0, y1) x [z0, z1). */
export interface Region {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export type Cell = { x: number; y: number; z: number };

/** The region spanning two cells of `size` (corners, units; either way round), both included. */
export function regionBetween(a: Cell, b: Cell, size: number): Region {
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), z0: Math.min(a.z, b.z),
    x1: Math.max(a.x, b.x) + size, y1: Math.max(a.y, b.y) + size, z1: Math.max(a.z, b.z) + size,
  };
}

/** The cells of `size` filling a region (its corners on that grid). */
export function cellsIn(r: Region, size: number): Cell[] {
  const out: Cell[] = [];
  for (let y = r.y0; y < r.y1; y += size) for (let z = r.z0; z < r.z1; z += size) for (let x = r.x0; x < r.x1; x += size) out.push({ x, y, z });
  return out;
}


/** Round shapes the designer draws (see shapeCells). */
export type RoundShape = 'circle' | 'dome' | 'sphere';

/**
 * The cells of `size` (units) making a round shape centred on cell `centre`, of `radius` (units,
 * between cell centres): a circle (a disk) across axis `axis` (0 x, 1 y, 2 z) through the centre;
 * a sphere around it; a dome, the sphere's half on the `sign` side (1 or -1) of that axis (the
 * centre's layer included, as its floor). Hollow: a ring, or a shell, one cell thick. A cell is in
 * if its centre is within the radius (and half a cell, so a radius of 0 is the centre cell alone).
 */
export function shapeCells(kind: RoundShape, centre: Cell, axis: 0 | 1 | 2, sign: 1 | -1, radius: number, size: number, hollow: boolean): Cell[] {
  const n = Math.max(0, Math.round(radius / size));
  const mid = { x: centre.x + size / 2, y: centre.y + size / 2, z: centre.z + size / 2 };
  return roundCells({ kind, centre: mid, axis, sign, outer: (n + 0.5) * size, thickness: hollow ? size : null, size });
}

/**
 * A round shape (see RoundShape) as cells of `size` (units): every cell whose centre is within
 * `outer` (units) of `centre` (any point, units: a cell's centre, or a corner between cells, so
 * even widths come out right), across `axis` for a circle (the layer `centre` is in), all round for
 * a sphere, on the `sign` side of `centre` (its layer included) for a dome. `thickness` (units):
 * only the cells within that of the outside (a ring, a shell); null: solid.
 */
export interface RoundSpec {
  kind: RoundShape;
  centre: { x: number; y: number; z: number };
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  outer: number;
  thickness: number | null;
  size: number;
}

export function roundCells(r: RoundSpec): Cell[] {
  const out: Cell[] = [];
  const keys = ['x', 'y', 'z'] as const, ax = keys[r.axis];
  const eps = 1e-6, outer2 = r.outer * r.outer + eps;
  const inner = r.thickness === null ? -1 : r.outer - r.thickness, inner2 = inner > 0 ? inner * inner + eps : -1;
  const s = r.size, half = s / 2;
  const lo = (v: number) => Math.floor((v - r.outer) / s) * s, hi = (v: number) => Math.floor((v + r.outer) / s) * s;
  // Walked a column at a time along the axis (for a circle: its one layer, the centre's): across
  // it, each column's cells are those whose centres lie between where the column enters the
  // shape and leaves it (and outside the hollow), worked out rather than tried one by one.
  const [a1, a2] = ([0, 1, 2] as const).filter((a) => a !== r.axis) as [0 | 1 | 2, 0 | 1 | 2];
  const k1 = keys[a1], k2 = keys[a2];
  const layer = Math.floor(r.centre[ax] / s) * s;
  const at = (u: number, v: number, w: number) => {
    // (+ 0: never -0, which Math.ceil makes of a hair below 0.)
    const c = { x: 0, y: 0, z: 0 };
    c[k1] = u + 0;
    c[k2] = v + 0;
    c[ax] = w + 0;
    return c;
  };
  for (let v = lo(r.centre[k2]); v <= hi(r.centre[k2]); v += s)
    for (let u = lo(r.centre[k1]); u <= hi(r.centre[k1]); u += s) {
      const d1 = u + half - r.centre[k1], d2 = v + half - r.centre[k2], across = d1 * d1 + d2 * d2;
      if (across > outer2) continue;
      if (r.kind === 'circle') {
        if (inner2 >= 0 && across <= inner2) continue;
        out.push(at(u, v, layer));
        continue;
      }
      // Along the axis: |d| up to `reach` (inside the outer), and over `gap` (outside the hollow).
      const reach = Math.sqrt(outer2 - across), gap = inner2 >= 0 && inner2 >= across ? Math.sqrt(inner2 - across) : -1;
      // (A dome: its half on the sign side, the centre's own layer as its floor.)
      const from = r.kind === 'dome' && r.sign > 0 ? Math.max(-reach, -half + eps) : -reach;
      const to = r.kind === 'dome' && r.sign < 0 ? Math.min(reach, half - eps) : reach;
      // Cells whose centre's offset d = w + half - c lies in [from, to], outside the hollow (|d| >
      // gap): below it and above it (one run, without a hollow), each run's ends worked out.
      const c = r.centre[ax];
      const run = (dLo: number, dHi: number) => {
        const w0 = Math.ceil((c + dLo - half) / s - 1e-9) * s, w1 = Math.floor((c + dHi - half) / s + 1e-9) * s;
        for (let w = w0; w <= w1; w += s) {
          const d = w + half - c, d2 = d * d + across;
          // (The exact tests, as cells are judged: the ends above can be a hair out.)
          if (d2 > outer2 || (inner2 >= 0 && d2 <= inner2)) continue;
          if (r.kind === 'dome' && d * r.sign < -half + eps) continue;
          out.push(at(u, v, w));
        }
      };
      if (gap < 0) run(from, to);
      else {
        run(from, Math.min(to, -gap));
        run(Math.max(from, gap), to);
      }
    }
  return out;
}

/**
 * Building in the world (creative: the build mode's tools), as players send it: a shape (a box,
 * which a line is too; or a round shape), of cells of `size` (units: 1/16 m to 1 m), filled with
 * `material`, or (`clear`) cleared of whatever's there. The server works out its cells just as the
 * player's game does (see buildCells), so only this is sent.
 */
export type BuildShape = { kind: 'box'; a: Cell; b: Cell } | { kind: 'round'; spec: Omit<RoundSpec, 'size'> };
export interface BuildOp {
  shape: BuildShape;
  size: number;
  material: MaterialId;
  clear: boolean;
}

/** The most a shape spans (units: 64 m), and the most cells it can have. */
export const BUILD_MAX_SPAN = 64 * BLOCK_SIZE;
export const BUILD_MAX_CELLS = 262_144;
const BUILD_SIZES = [1, 2, 4, 8, 16];

/** The cells of a build (units, each `op.size` across), or why it can't be built. */
export function buildCells(op: BuildOp): Cell[] | string {
  const s = op.size;
  if (!BUILD_SIZES.includes(s)) return `voxels are 1/16 m to 1 m across, not ${s} units`;
  const onGrid = (c: Cell) => [c.x, c.y, c.z].every((v) => Number.isInteger(v) && v % s === 0);
  if (op.shape.kind === 'box') {
    const { a, b } = op.shape;
    if (!onGrid(a) || !onGrid(b)) return 'a corner is off its voxels\' grid';
    const r = regionBetween(a, b, s);
    if (r.x1 - r.x0 > BUILD_MAX_SPAN || r.y1 - r.y0 > BUILD_MAX_SPAN || r.z1 - r.z0 > BUILD_MAX_SPAN) return 'too big: 64 m across at most';
    const n = ((r.x1 - r.x0) / s) * ((r.y1 - r.y0) / s) * ((r.z1 - r.z0) / s);
    if (n > BUILD_MAX_CELLS) return `too many voxels (${n}): ${BUILD_MAX_CELLS} at most (bigger voxels, or a smaller shape)`;
    return cellsIn(r, s);
  }
  const r = op.shape.spec;
  if (!['circle', 'dome', 'sphere'].includes(r.kind) || ![0, 1, 2].includes(r.axis) || ![1, -1].includes(r.sign)) return 'not a shape';
  if (![r.centre.x, r.centre.y, r.centre.z, r.outer].every(Number.isFinite) || r.outer < 0) return 'not a shape';
  if (r.outer * 2 > BUILD_MAX_SPAN) return 'too big: 64 m across at most';
  if (r.thickness !== null && !(Number.isFinite(r.thickness) && r.thickness > 0)) return 'not a shape';
  // (Rough count first, a little over: a solid sphere is about 0.52 of its cube, a dome half that;
  // refused before any are made.)
  const across = Math.ceil((r.outer * 2) / s) + 1;
  if (r.kind !== 'circle' && r.thickness === null && across ** 3 * (r.kind === 'dome' ? 0.27 : 0.53) > BUILD_MAX_CELLS * 1.1) return `too many voxels: ${BUILD_MAX_CELLS} at most (bigger voxels, or a smaller shape)`;
  const cells = roundCells({ ...r, size: s });
  if (cells.length > BUILD_MAX_CELLS) return `too many voxels (${cells.length}): ${BUILD_MAX_CELLS} at most (bigger voxels, or a smaller shape)`;
  return cells;
}
