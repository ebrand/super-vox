import { BLOCK_SIZE } from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import { UNITS_PER_METER } from './units.js';

/**
 * Aqueducts: stone channels carrying water from a large natural body of water (a lake, a big river,
 * high up) across country, falling gently all the way, on piers over low ground and cut through
 * rises (see planAqueduct). Each is treated as a pipe, not as moving water: while it's whole it's
 * running, its water (drawn by the client, not voxels) standing in its channel from its head as far
 * as the first break (a piece of it dug or knocked down: see Aqueduct.runs), and at its outlet (once
 * finished) it waters the land round about.
 *
 * Its head is built near the water it draws on (an underground conduit to it is taken as given: see
 * intakeOk): within INTAKE_REACH_M of it, the head's channel floor at least INTAKE_DEPTH_M below the
 * water's surface, the water large enough (SOURCE_MIN_COLUMNS).
 */

/** How steeply it may fall (drop over run), steepest last: the slopes laid at. */
export const AQUEDUCT_FALLS = [1 / 200, 1 / 100, 1 / 50, 1 / 20] as const;
/** A segment's shortest and longest (m). */
export const AQUEDUCT_MIN_SEGMENT_M = 4;
export const AQUEDUCT_MAX_SEGMENT_M = 400;
/** Highest its floor may stand over the ground (m, on piers), and deepest it may cut into it (m, its floor under the ground's top). */
export const AQUEDUCT_MAX_HEIGHT_M = 24;
export const AQUEDUCT_MAX_CUT_M = 12;
/** Up to this high over the ground (m) it stands on a solid footing; higher, on piers this far apart (m). */
export const AQUEDUCT_FOOTING_M = 2;
export const AQUEDUCT_PIER_EVERY_M = 6;
/** Its head: this near natural water (m), its floor this far under the water's surface (m) at least; the water this big at least (columns of it, sampled every SOURCE_STEP_M, within SOURCE_REACH_M of the head). */
export const INTAKE_REACH_M = 32;
export const INTAKE_DEPTH_M = 1;
export const SOURCE_REACH_M = 48;
export const SOURCE_STEP_M = 4;
export const SOURCE_MIN_COLUMNS = 40;
/** How deep its water stands in its channel (units, over the floor), and how high its walls are (units). */
export const CHANNEL_WATER = 12;
export const CHANNEL_WALL = BLOCK_SIZE;
/** What it's built of: cobblestone, dressed stone where it shows (its floor, its walls' coping, its arches' rings). Built of 1/4 m voxels (see aqueductPieces). */
export const AQUEDUCT_RUBBLE: MaterialId = Material.Cobblestone;
export const AQUEDUCT_DRESSED: MaterialId = Material.Stone;

/** A cell of its channel: its block (x, z), and its floor's top (units: where its water stands on). */
export interface ChannelCell {
  bx: number;
  bz: number;
  floor: number;
}

/** An aqueduct as kept: its channel's cells in order (head first), and whether it's finished (an outlet basin at its end). */
export interface Aqueduct {
  id: number;
  name: string;
  cells: ChannelCell[];
  /** Its pools (see poolCells): its head's cistern, and once it's finished, its outlet basin; water in the head's always, in the outlet's while it runs. */
  head: ChannelCell[];
  outlet: ChannelCell[];
  finished: boolean;
  /** Its water reaches this many of its cells from its head (all of them: running to its end; fewer: broken there). */
  runs: number;
  /** Its straight runs, a segment each (its channel along the line between their end cells' middles): none for one built before it had them (its channel square round each cell). */
  legs?: ChannelLeg[];
}

/** A straight run of an aqueduct's channel: from its cell `first` to its cell `last` (their middles), falling `fall` a block. */
export interface ChannelLeg {
  first: number;
  last: number;
  fall: number;
}

/** Whether an aqueduct's water reaches its end (and, finished, its outlet waters the land). */
export function running(a: Aqueduct): boolean {
  return a.runs >= a.cells.length && a.cells.length > 0;
}

/**
 * A segment's channel cells, from block (bx0, bz0) to (bx1, bz1): the blocks a line between their
 * middles passes through, each sharing a face with the next (so water in them is joined).
 */
export function channelLine(bx0: number, bz0: number, bx1: number, bz1: number): [number, number][] {
  const out: [number, number][] = [[bx0, bz0]];
  let x = bx0, z = bz0;
  const dx = bx1 - bx0, dz = bz1 - bz0, sx = Math.sign(dx), sz = Math.sign(dz), ax = Math.abs(dx), az = Math.abs(dz);
  // (Stepping along whichever of x and z the line crosses into next: a supercover, faces only.)
  let tx = ax ? 0.5 / ax : Infinity, tz = az ? 0.5 / az : Infinity;
  const ix = ax ? 1 / ax : Infinity, iz = az ? 1 / az : Infinity;
  while (x !== bx1 || z !== bz1) {
    if (tx < tz || (tx === tz && ax >= az)) {
      x += sx;
      tx += ix;
    } else {
      z += sz;
      tz += iz;
    }
    out.push([x, z]);
  }
  return out;
}

/** A planned segment: its cells (the first is the start's, already there), the ground under each (units), and what it takes. */
export interface AqueductPlan {
  cells: ChannelCell[];
  ground: number[];
  length: number;
  /** Highest it stands over the ground and deepest it cuts (m), and how far along (m). */
  maxHeight: number;
  heightAt: number;
  maxCut: number;
  cutAt: number;
  fall: number;
}

/**
 * Plans a segment from `start` (its cell: the head, or an aqueduct's end) to block (bx, bz), its
 * floor falling `fall` per block along it (a quarter metre down each time it's fallen that much), checked against the ground (`groundAt`: the ground's top over a block, units):
 * not standing over it higher than AQUEDUCT_MAX_HEIGHT_M, nor cutting into it deeper than
 * AQUEDUCT_MAX_CUT_M. Or why not.
 */
export function planAqueduct(start: ChannelCell, bx: number, bz: number, fall: number, groundAt: (bx: number, bz: number) => number): AqueductPlan | string {
  const B = BLOCK_SIZE, M = UNITS_PER_METER;
  if (!(AQUEDUCT_FALLS as readonly number[]).includes(fall)) return 'it falls 1 in 200, 100, 50 or 20';
  const length = Math.hypot(bx - start.bx, bz - start.bz) * (B / M);
  if (length < AQUEDUCT_MIN_SEGMENT_M) return `too short (${AQUEDUCT_MIN_SEGMENT_M} m at least)`;
  if (length > AQUEDUCT_MAX_SEGMENT_M) return `too long: ${Math.round(length)} m (${AQUEDUCT_MAX_SEGMENT_M} m at most a segment)`;
  const line = channelLine(start.bx, start.bz, bx, bz);
  const cells: ChannelCell[] = [start], ground: number[] = [groundAt(start.bx, start.bz)];
  let maxHeight = 0, heightAt = 0, maxCut = 0, cutAt = 0;
  const dx = bx - start.bx, dz = bz - start.bz, d2 = dx * dx + dz * dz;
  for (let i = 1; i < line.length; i++) {
    const [x, z] = line[i]!;
    // (How far along the line its middle is, blocks: its floor there, as its channel's columns have it, see aqueductColumns.)
    const run = (Math.max(0, Math.min(1, ((x - start.bx) * dx + (z - start.bz) * dz) / d2)) * Math.sqrt(d2));
    const floor = runFloor(start.floor, fall, run);
    const g = groundAt(x, z);
    cells.push({ bx: x, bz: z, floor });
    ground.push(g);
    const along = (run * B) / M, over = (floor - g) / M, under = (g - floor) / M;
    if (over > maxHeight) (maxHeight = over), (heightAt = along);
    if (under > maxCut) (maxCut = under), (cutAt = along);
  }
  if (maxHeight > AQUEDUCT_MAX_HEIGHT_M) return `${Math.round(maxHeight)} m over the ground ${Math.round(heightAt)} m along (${AQUEDUCT_MAX_HEIGHT_M} m at most): go round the valley, or fall more slowly`;
  if (maxCut > AQUEDUCT_MAX_CUT_M) return `cut ${Math.round(maxCut)} m into the ground ${Math.round(cutAt)} m along (${AQUEDUCT_MAX_CUT_M} m at most; tunnels come later): go round the hill, or fall faster`;
  return { cells, ground, length, maxHeight, heightAt, maxCut, cutAt, fall };
}

/** A piece to build (units: its least corner; `size` across: 1/4, 1/2 or 1 m). */
export interface AqueductPiece {
  x: number;
  y: number;
  z: number;
  size: number;
  material: MaterialId;
}

/** The voxel aqueducts are modelled in (units: 1/4 m). */
const Q = BLOCK_SIZE / 4;
/** Its walls' thickness and its floor's (units), and how high its walls stand over its floor (units); half its channel's width (units). */
const WALL = 2 * Q, SLAB = 2 * Q, WALL_TOP = 4 * Q, HALF = BLOCK_SIZE / 2;
/** How high over its floor it's cleared where it cuts into the ground (units). */
const CLEAR_OVER = 3 * BLOCK_SIZE;

/** A floor `s` blocks along a straight run from one at `floor0` (units), falling `fall` a block: down a quarter metre each time it's fallen that much. */
export function runFloor(floor0: number, fall: number, s: number): number {
  return floor0 - Math.floor((s * fall * BLOCK_SIZE) / Q + 1e-9) * Q;
}

/** An aqueduct's shape: its channel's cells, its pools, and its straight runs (see Aqueduct.legs). */
export type AqueductShape = Pick<Aqueduct, 'cells' | 'head' | 'outlet'> & { legs?: readonly ChannelLeg[] };

/**
 * What an aqueduct's channel is made up of: straight runs (a channel HALF each side of a line between
 * two cells' middles, its floor falling along it), and squares of channel (its pools; and each cell
 * of an aqueduct built before it had runs, see Aqueduct.legs). `cell`: whose water it is (see wet):
 * -1 the head's (always), cells.length the outlet's.
 */
type Part =
  | { kind: 'run'; x0: number; z0: number; dx: number; dz: number; len: number; floor0: number; fall: number; s0: number; cells: number[]; ts: number[] }
  | { kind: 'square'; x0: number; z0: number; x1: number; z1: number; floor: number; cell: number; s0: number; wx: number; wz: number };

function partsOf(a: AqueductShape): Part[] {
  const B = BLOCK_SIZE, M = UNITS_PER_METER, parts: Part[] = [];
  const mid = (c: ChannelCell) => [(c.bx + 0.5) * B, (c.bz + 0.5) * B] as const;
  // How far along each cell is (m): for where its piers go.
  const inRun = new Map<number, ChannelLeg>();
  for (const l of a.legs ?? []) for (let i = l.first; i <= l.last; i++) if (i > l.first || l.first === 0) inRun.set(i, l);
  const along: number[] = [];
  a.cells.forEach((c, i) => {
    const l = inRun.get(i);
    if (i === 0) along.push(0);
    else if (l && i > l.first) {
      const [x0, z0] = mid(a.cells[l.first]!), [x1, z1] = mid(a.cells[l.last]!), [x, z] = mid(c), len = Math.hypot(x1 - x0, z1 - z0) || 1;
      along.push(along[l.first]! + ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / len / M);
    } else along.push(along[i - 1]! + Math.hypot(c.bx - a.cells[i - 1]!.bx, c.bz - a.cells[i - 1]!.bz) * (B / M));
  });
  const pool = (cells: readonly ChannelCell[], cell: number, s0: number) => {
    if (!cells.length) return;
    const xs = cells.map((c) => c.bx), zs = cells.map((c) => c.bz);
    parts.push({ kind: 'square', x0: Math.min(...xs) * B, z0: Math.min(...zs) * B, x1: (Math.max(...xs) + 1) * B, z1: (Math.max(...zs) + 1) * B, floor: cells[0]!.floor, cell, s0, wx: 1, wz: 0 });
  };
  pool(a.head, -1, 0);
  pool(a.outlet, a.cells.length, along.at(-1) ?? 0);
  // (Cells of no run: squares, each its way along.)
  a.cells.forEach((c, i) => {
    if (inRun.has(i) || (i === 0 && a.head.length)) return;
    const p = a.cells[Math.max(0, i - 1)]!, n = a.cells[Math.min(a.cells.length - 1, i + 1)]!, d = Math.hypot(n.bx - p.bx, n.bz - p.bz) || 1;
    parts.push({ kind: 'square', x0: c.bx * B, z0: c.bz * B, x1: (c.bx + 1) * B, z1: (c.bz + 1) * B, floor: c.floor, cell: i, s0: along[i]!, wx: (n.bx - p.bx) / d, wz: (n.bz - p.bz) / d });
  });
  for (const l of a.legs ?? []) {
    const [x0, z0] = mid(a.cells[l.first]!), [x1, z1] = mid(a.cells[l.last]!), len = Math.hypot(x1 - x0, z1 - z0) || 1;
    const cells: number[] = [], ts: number[] = [];
    for (let i = l.first; i <= l.last; i++) {
      const [x, z] = mid(a.cells[i]!);
      cells.push(i);
      ts.push(Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / (len * len))));
    }
    parts.push({ kind: 'run', x0, z0, dx: x1 - x0, dz: z1 - z0, len, floor0: a.cells[l.first]!.floor, fall: l.fall, s0: along[l.first]!, cells, ts });
  }
  return parts;
}

/** A quarter-metre column of an aqueduct: its floor (units), whether it's channel (else wall), whose water (see Part), how far along (m), and which part. */
export interface AqueductColumn {
  qx: number;
  qz: number;
  floor: number;
  channel: boolean;
  cell: number;
  s: number;
  part: number;
  /** One of those asked for (else one already there, built again beside them: see aqueductColumns). */
  mine: boolean;
}

/** The column at quarter-metre (qx, qz), of `parts`: the part it's nearest the channel of; null if it's further than a wall's thickness from all of them. */
function columnAt(parts: readonly Part[], qx: number, qz: number): AqueductColumn | null {
  const B = BLOCK_SIZE, M = UNITS_PER_METER, x = (qx + 0.5) * Q, z = (qz + 0.5) * Q;
  let best: AqueductColumn | null = null, be = Infinity;
  parts.forEach((p, k) => {
    if (p.kind === 'square') {
      // (Out from a square: the further of across and along, as walls go round it square.)
      // (Inside one, it's the square's: a pool's water is the pool's, whatever run starts in it.)
      const inside = x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1;
      const e = inside ? -BLOCK_SIZE : Math.max(p.x0 - x, x - p.x1, p.z0 - z, z - p.z1, 0);
      if (e > WALL || e >= be) return;
      const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
      be = e;
      best = { qx, qz, floor: p.floor, channel: inside, cell: p.cell, s: p.s0 + ((x - cx) * p.wx + (z - cz) * p.wz) / M, part: k, mine: true };
      return;
    }
    const t = Math.max(0, Math.min(1, ((x - p.x0) * p.dx + (z - p.z0) * p.dz) / (p.len * p.len)));
    const d = Math.hypot(x - (p.x0 + t * p.dx), z - (p.z0 + t * p.dz)), e = d - HALF;
    if (e > WALL || e >= be) return;
    be = e;
    // (Whose water: the cell of the run it's nearest along it.)
    let lo = 0, hi = p.ts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p.ts[m]! <= t) lo = m;
      else hi = m;
    }
    const cell = Math.abs(p.ts[hi]! - t) < Math.abs(p.ts[lo]! - t) ? p.cells[hi]! : p.cells[lo]!;
    best = { qx, qz, floor: runFloor(p.floor0, p.fall, (t * p.len) / B), channel: e <= 0, cell, s: p.s0 + (t * p.len) / M, part: k, mine: true };
  });
  return best;
}

/**
 * An aqueduct's quarter-metre columns (its channel, and its walls round it), of those parts of it
 * `mine` says are (the rest are there already: a column nearer theirs is theirs); and with them,
 * not `mine`, the rest of its columns in the same blocks (built again: clearing a block's quarter
 * metre takes whatever voxel's there, a half or whole metre of the wall beside it too). The
 * channel's a metre wide, along each straight run's line (not its cells': else, at an angle, it
 * zig-zags), its floor stepping down a quarter metre at a time; walls 1/2 m thick each side, round
 * its ends.
 */
export function aqueductColumns(a: AqueductShape, mine: (part: { cell: number; run: boolean; first: number }) => boolean = () => true): AqueductColumn[] {
  const parts = partsOf(a), R = HALF + WALL, out: AqueductColumn[] = [];
  const seen = new Set<number>();
  const look = (qx: number, qz: number) => {
    const key = qx * 4_194_304 + qz;
    if (seen.has(key)) return;
    seen.add(key);
    const c = columnAt(parts, qx, qz);
    if (c && mineOf[c.part]) out.push(c);
    else seen.delete(key);
  };
  const mineOf = parts.map((p) => mine(p.kind === 'run' ? { cell: p.cells.at(-1)!, run: true, first: p.cells[0]! } : { cell: p.cell, run: false, first: p.cell }));
  parts.forEach((p, k) => {
    if (!mineOf[k]) return;
    if (p.kind === 'square') {
      for (let qx = Math.floor((p.x0 - WALL) / Q); qx < Math.ceil((p.x1 + WALL) / Q); qx++) for (let qz = Math.floor((p.z0 - WALL) / Q); qz < Math.ceil((p.z1 + WALL) / Q); qz++) look(qx, qz);
      return;
    }
    // (Along its line a quarter metre at a time, the squares round each point.)
    const n = Math.ceil(p.len / Q), r = Math.ceil(R / Q) + 1;
    for (let i = 0; i <= n; i++) {
      const cx = Math.floor((p.x0 + (p.dx * i) / n) / Q), cz = Math.floor((p.z0 + (p.dz * i) / n) / Q);
      for (let qx = cx - r; qx <= cx + r; qx++) for (let qz = cz - r; qz <= cz + r; qz++) look(qx, qz);
    }
  });
  if (mineOf.every(Boolean)) return out;
  const N = BLOCK_SIZE / Q, blocks = new Set(out.map((c) => `${Math.floor(c.qx / N)},${Math.floor(c.qz / N)}`));
  for (const b of blocks) {
    const [bx, bz] = b.split(',').map(Number) as [number, number];
    for (let qx = bx * N; qx < (bx + 1) * N; qx++)
      for (let qz = bz * N; qz < (bz + 1) * N; qz++) {
        const key = qx * 4_194_304 + qz;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = columnAt(parts, qx, qz);
        if (c) out.push({ ...c, mine: false });
      }
  }
  return out;
}

/** Each column's voxels (quarter-metre y, bottom up): what's built, and from where up it's cleared (see aqueductPieces). */
function columnVoxels(col: AqueductColumn, groundAt: (bx: number, bz: number) => number, put: (qy: number, m: MaterialId) => void): { clearFrom: number; clearTo: number } {
  const B = BLOCK_SIZE, M = UNITS_PER_METER, N = B / Q;
  const f = col.floor, slabBottom = f - SLAB, top = col.channel ? f : f + WALL_TOP;
  for (let y = slabBottom; y < top; y += Q) {
    // (Dressed stone: the channel's floor, and the walls' top course.)
    put(y / Q, col.channel || y >= f + WALL_TOP - Q ? AQUEDUCT_DRESSED : AQUEDUCT_RUBBLE);
  }
  // Cleared: where it goes (whatever's there), and over it where the ground's higher (from its
  // underside up; a block more than the ground's smooth height, as voxels stand a little over it).
  const g = groundAt(Math.floor(col.qx / N), Math.floor(col.qz / N));
  const clear = { clearFrom: slabBottom, clearTo: Math.max(top, Math.min(f + CLEAR_OVER, Math.max(f + WALL_TOP, g + B))) };
  // Under it, down to the ground: a footing if it's low; else a pier, or an arch's spandrel over its curve.
  const under = slabBottom - g;
  if (under <= 0) return clear;
  const P = AQUEDUCT_PIER_EVERY_M, PIER_HALF = 0.5, R = (P - 2 * PIER_HALF) / 2;
  const low = under <= AQUEDUCT_FOOTING_M * M;
  const toPier = Math.abs(col.s - Math.round(col.s / P) * P), mid = Math.abs(col.s - (Math.floor(col.s / P) + 0.5) * P);
  for (let y = slabBottom - Q; y >= g - Q; y -= Q) {
    const depth = (slabBottom - y) / M;
    if (low || toPier <= PIER_HALF) {
      put(y / Q, AQUEDUCT_RUBBLE);
      continue;
    }
    // (The arch: open under a half circle between the piers' faces, its crown 1/2 m under the floor.)
    const curve = 0.5 + R - Math.sqrt(Math.max(0, R * R - mid * mid));
    if (depth > curve) break;
    put(y / Q, depth > curve - Q / M ? AQUEDUCT_DRESSED : AQUEDUCT_RUBBLE);
  }
  return clear;
}

/**
 * What columns of an aqueduct (see aqueductColumns) take to build, modelled in 1/4 m voxels (merged
 * into 1/2 m and 1 m ones wherever a cube's all one material): a floor 1/2 m thick under the channel,
 * of dressed stone; walls a metre over its floor, cobblestone with a coping of dressed stone; under
 * it all, down to the ground, a solid footing where it's low (AQUEDUCT_FOOTING_M), else piers every
 * AQUEDUCT_PIER_EVERY_M with round arches between them (their rings dressed stone). Where the ground's
 * in its way it's cut: cleared over its outline, from its floor's underside up to CLEAR_OVER over
 * its floor.
 */
export function aqueductPieces(columns: readonly AqueductColumn[], groundAt: (bx: number, bz: number) => number): { place: AqueductPiece[]; clear: AqueductPiece[] } {
  const solid = new VoxelBlocks(), air = new VoxelBlocks();
  for (const col of columns) {
    const { clearFrom, clearTo } = columnVoxels(col, groundAt, (qy, m) => solid.set(col.qx, qy, col.qz, m));
    for (let y = clearFrom; y < clearTo; y += Q) air.set(col.qx, y / Q, col.qz, Material.Air);
  }
  // (Where it goes is cleared too, whatever's there: then built, as the clearing comes first.)
  solid.each((qx, qy, qz) => air.set(qx, qy, qz, Material.Air));
  return { place: solid.merged(), clear: air.merged() };
}

/** Quarter-metre voxels, a block's (4 by 4 by 4) to an array (its material + 1; 0 for none). */
class VoxelBlocks {
  private readonly blocks = new Map<number, { bx: number; by: number; bz: number; m: Uint16Array }>();

  set(qx: number, qy: number, qz: number, material: MaterialId): void {
    const bx = Math.floor(qx / 4), by = Math.floor(qy / 4), bz = Math.floor(qz / 4);
    // (A block's key: x and z to 2^18 blocks (262 km), y within ±2^15.)
    const key = ((bx + 131_072) * 65_536 + (by + 32_768)) * 262_144 + (bz + 131_072);
    let b = this.blocks.get(key);
    if (!b) this.blocks.set(key, (b = { bx, by, bz, m: new Uint16Array(64) }));
    b.m[qx - bx * 4 + 4 * (qz - bz * 4 + 4 * (qy - by * 4))] = material + 1;
  }

  each(f: (qx: number, qy: number, qz: number) => void): void {
    for (const b of this.blocks.values())
      for (let i = 0; i < 64; i++) if (b.m[i]) f(b.bx * 4 + (i & 3), b.by * 4 + (i >> 4), b.bz * 4 + ((i >> 2) & 3));
  }

  /** As pieces: a block's, merged into one 1 m voxel if all one material; else each 1/2 m octant that is; else as they are. */
  merged(): AqueductPiece[] {
    const B = BLOCK_SIZE, out: AqueductPiece[] = [];
    for (const { bx, by, bz, m } of this.blocks.values()) {
      const at = (x: number, y: number, z: number) => m[x + 4 * (z + 4 * y)]!;
      /** The one material (+1) all of a cube (quarters x0.., `n` a side) is, or 0. */
      const all = (x0: number, y0: number, z0: number, n: number): number => {
        const v = at(x0, y0, z0);
        if (!v) return 0;
        for (let y = y0; y < y0 + n; y++) for (let z = z0; z < z0 + n; z++) for (let x = x0; x < x0 + n; x++) if (at(x, y, z) !== v) return 0;
        return v;
      };
      const whole = all(0, 0, 0, 4);
      if (whole) {
        out.push({ x: bx * B, y: by * B, z: bz * B, size: B, material: whole - 1 });
        continue;
      }
      for (let oy = 0; oy < 4; oy += 2)
        for (let oz = 0; oz < 4; oz += 2)
          for (let ox = 0; ox < 4; ox += 2) {
            const half = all(ox, oy, oz, 2);
            if (half) {
              out.push({ x: bx * B + ox * Q, y: by * B + oy * Q, z: bz * B + oz * Q, size: 2 * Q, material: half - 1 });
              continue;
            }
            for (let y = oy; y < oy + 2; y++)
              for (let z = oz; z < oz + 2; z++)
                for (let x = ox; x < ox + 2; x++) {
                  const v = at(x, y, z);
                  if (v) out.push({ x: bx * B + x * Q, y: by * B + y * Q, z: bz * B + z * Q, size: Q, material: v - 1 });
                }
          }
    }
    return out;
  }
}

/** What columns of an aqueduct take (units³ of each material): as aqueductPieces would build, without making its pieces; those built again (not `mine`) aside. */
export function aqueductCost(columns: readonly AqueductColumn[], groundAt: (bx: number, bz: number) => number): Map<MaterialId, number> {
  const n = new Map<MaterialId, number>();
  for (const col of columns) if (col.mine) columnVoxels(col, groundAt, (_qy, m) => n.set(m, (n.get(m) ?? 0) + 1));
  return new Map([...n].map(([m, k]) => [m, k * Q ** 3]));
}

/** Of an aqueduct's water (see AqueductView): its channel's columns (quarter metres), each with its floor (units), and whether its water's there. */
export function aqueductWater(a: Aqueduct): { qx: number; qz: number; floor: number }[] {
  const end = running(a);
  return aqueductColumns(a)
    .filter((c) => c.channel && (c.cell === -1 || (c.cell >= a.cells.length ? end : c.cell < a.runs)))
    .map((c) => ({ qx: c.qx, qz: c.qz, floor: c.floor }));
}

/**
 * What each of an aqueduct's cells needs standing for its water to pass (points, units): its floor
 * under it, and its walls beside it (where there's no channel there). On a straight run: under the
 * run's line where the cell's middle is along it, and its walls square to the line.
 */
export function channelKeys(a: AqueductShape): [number, number, number][][] {
  const B = BLOCK_SIZE, parts = partsOf(a);
  const of = (x: number, z: number) => columnAt(parts, Math.floor(x / Q), Math.floor(z / Q));
  const runOf = new Map<number, Extract<Part, { kind: 'run' }>>();
  for (const p of parts) if (p.kind === 'run') p.cells.forEach((c, k) => (k > 0 || c === 0) && runOf.set(c, p));
  const channel = new Set([...a.head, ...a.outlet, ...a.cells].map((c) => `${c.bx},${c.bz}`));
  return a.cells.map((c, i) => {
    const run = runOf.get(i), out: [number, number, number][] = [];
    const key = (x: number, z: number, wall: boolean) => {
      const col = of(x, z);
      if (!col || col.channel === wall) return;
      out.push([(col.qx + 0.5) * Q, wall ? col.floor + Q / 2 : col.floor - Q / 2, (col.qz + 0.5) * Q]);
    };
    if (!run) {
      // (A square of channel: its middle, and its sides that aren't channel.)
      const cx = (c.bx + 0.5) * B, cz = (c.bz + 0.5) * B;
      key(cx, cz, false);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (!channel.has(`${c.bx + dx},${c.bz + dz}`)) key(cx + dx * (B / 2 + Q / 2), cz + dz * (B / 2 + Q / 2), true);
      return out;
    }
    const t = run.ts[run.cells.indexOf(i)]!, x = run.x0 + t * run.dx, z = run.z0 + t * run.dz, nx = -run.dz / run.len, nz = run.dx / run.len, w = HALF + WALL / 2;
    key(x, z, false);
    key(x + nx * w, z + nz * w, true);
    key(x - nx * w, z - nz * w, true);
    return out;
  });
}

/** A pool at an aqueduct's head (its cistern) or a finished one's end (its outlet basin): 3 by 3 channel cells round `at`, at its floor. */
export function poolCells(at: ChannelCell): ChannelCell[] {
  const out: ChannelCell[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push({ bx: at.bx + dx, bz: at.bz + dz, floor: at.floor });
  return out;
}

/** A finished, running aqueduct's outlet waters the land this near it (m): wheat there grows WATERED_GROWTH times as fast, sand takes saplings, and dry ground greens (see GREENER). */
export const WATERED_M = 24;
export const WATERED_GROWTH = 1.5;
/** What watered ground becomes, a step at a time: desert sand to sand to dirt to grass; dry grass to meadow. */
export const GREENER: Readonly<Partial<Record<MaterialId, MaterialId>>> = {
  [Material.DesertSand]: Material.Sand,
  [Material.Sand]: Material.Dirt,
  [Material.Dirt]: Material.Grass,
  [Material.DryGrass]: Material.Meadow,
};
/** Saplings take on these too, where watered (see PLANTABLE for anywhere). */
export const WATERED_PLANTABLE: ReadonlySet<MaterialId> = new Set<MaterialId>([Material.Sand, Material.DesertSand]);

/** Where watered land's watered from: each finished, running aqueduct's outlet's middle (units: x, z). */
export function wateringOutlets(aqueducts: readonly Aqueduct[]): { x: number; z: number }[] {
  return aqueducts.filter((a) => a.finished && running(a) && a.outlet.length).map((a) => {
    const n = a.outlet.length;
    return { x: (a.outlet.reduce((s, c) => s + c.bx, 0) / n + 0.5) * BLOCK_SIZE, z: (a.outlet.reduce((s, c) => s + c.bz, 0) / n + 0.5) * BLOCK_SIZE };
  });
}

/** Whether (x, z) (units) is watered by one of `outlets` (see wateringOutlets). */
export function watered(outlets: readonly { x: number; z: number }[], x: number, z: number): boolean {
  const r = WATERED_M * UNITS_PER_METER;
  return outlets.some((o) => Math.hypot(o.x - x, o.z - z) <= r);
}
