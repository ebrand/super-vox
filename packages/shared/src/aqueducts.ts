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
 * floor falling `fall` per block along it (in whole blocks: a step down each time it's fallen a
 * block's worth), checked against the ground (`groundAt`: the ground's top over a block, units):
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
  let maxHeight = 0, heightAt = 0, maxCut = 0, cutAt = 0, run = 0;
  for (let i = 1; i < line.length; i++) {
    const [x, z] = line[i]!, [px, pz] = line[i - 1]!;
    run += Math.hypot(x - px, z - pz);
    // (Down a block each time it's fallen a block's worth: so many blocks along, at this fall.)
    const floor = start.floor - Math.floor(run * fall) * B;
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

/** The voxel aqueducts are modelled in (units: 1/4 m), and how much of its footing goes under the ground (units: so it doesn't stand on a ledge). */
const Q = BLOCK_SIZE / 4;
/** Its walls' thickness and its floor's (units), and how high its walls stand over its floor (units). */
const WALL = 2 * Q, SLAB = 2 * Q, WALL_TOP = 4 * Q;
/** How high over its floor it's cleared where it cuts into the ground (units). */
const CLEAR_OVER = 3 * BLOCK_SIZE;

/**
 * What a run of channel cells takes to build, modelled in 1/4 m voxels (merged into 1/2 m and 1 m
 * ones wherever a cube's all one material): a floor 1/2 m thick under the channel, of dressed stone;
 * walls 1/2 m thick each side (round the channel's outline, whichever way it goes), a metre over its
 * floor, cobblestone with a coping of dressed stone; under it all, down to the ground, a solid
 * footing where it's low (AQUEDUCT_FOOTING_M), else piers every AQUEDUCT_PIER_EVERY_M with round
 * arches between them (their rings dressed stone). Where the ground's in its way it's cut: cleared
 * over its outline, from its floor's underside up to CLEAR_OVER over its floor. `own`: channel cells
 * already its (their walls aren't built across the new ones). `keys`: for each cell, points (units)
 * that must stay solid for its water to pass (its floor, and its walls where it has them).
 */
export function aqueductPieces(cells: readonly ChannelCell[], groundAt: (bx: number, bz: number) => number, own: readonly ChannelCell[] = []): { place: AqueductPiece[]; clear: AqueductPiece[]; keys: [number, number, number][][] } {
  const B = BLOCK_SIZE, M = UNITS_PER_METER, N = B / Q;
  const channel = new Map<string, ChannelCell>();
  for (const c of [...own, ...cells]) channel.set(`${c.bx},${c.bz}`, c);
  const isChannel = (bx: number, bz: number) => channel.has(`${bx},${bz}`);
  // How far along each cell is (m), and its way (for where along it a voxel is: arches).
  const along: number[] = [0];
  for (let i = 1; i < cells.length; i++) along.push(along[i - 1]! + Math.hypot(cells[i]!.bx - cells[i - 1]!.bx, cells[i]!.bz - cells[i - 1]!.bz) * (B / M));
  const wayOf = (i: number) => {
    const a = cells[Math.max(0, i - 1)]!, b = cells[Math.min(cells.length - 1, i + 1)]!, d = Math.hypot(b.bx - a.bx, b.bz - a.bz) || 1;
    return { x: (b.bx - a.bx) / d, z: (b.bz - a.bz) / d };
  };
  // Each quarter-metre column of its outline (the channel, and WALL round it): the cell it's
  // nearest (its floor, and how far along it is, m), and whether it's in the channel.
  const columns = new Map<string, { qx: number; qz: number; cell: number; s: number; inChannel: boolean }>();
  cells.forEach((c, i) => {
    const cx = (c.bx + 0.5) * B, cz = (c.bz + 0.5) * B, way = wayOf(i);
    for (let qx = c.bx * N - WALL / Q; qx < (c.bx + 1) * N + WALL / Q; qx++)
      for (let qz = c.bz * N - WALL / Q; qz < (c.bz + 1) * N + WALL / Q; qz++) {
        const bx = Math.floor(qx / N), bz = Math.floor(qz / N);
        const inChannel = isChannel(bx, bz);
        // (Another cell's channel: theirs to say.)
        if (inChannel && (bx !== c.bx || bz !== c.bz)) continue;
        const x = (qx + 0.5) * Q, z = (qz + 0.5) * Q, d = Math.hypot(x - cx, z - cz);
        const k = `${qx},${qz}`, had = columns.get(k);
        if (had && !inChannel && (had.inChannel || Math.hypot(x - (cells[had.cell]!.bx + 0.5) * B, z - (cells[had.cell]!.bz + 0.5) * B) <= d)) continue;
        columns.set(k, { qx, qz, cell: i, s: along[i]! + ((x - cx) * way.x + (z - cz) * way.z) / M, inChannel });
      }
  });
  const solid = new Map<string, MaterialId>(), air = new Set<string>();
  const put = (qx: number, qy: number, qz: number, m: MaterialId) => solid.set(`${qx},${qy},${qz}`, m);
  const P = AQUEDUCT_PIER_EVERY_M, PIER_HALF = 0.5, R = (P - 2 * PIER_HALF) / 2;
  for (const col of columns.values()) {
    const c = cells[col.cell]!, f = c.floor, slabBottom = f - SLAB, top = col.inChannel ? f : f + WALL_TOP;
    for (let y = slabBottom; y < top; y += Q) {
      // (Dressed stone: the channel's floor, and the walls' top course.)
      const dressed = col.inChannel || y >= f + WALL_TOP - Q;
      put(col.qx, y / Q, col.qz, dressed ? AQUEDUCT_DRESSED : AQUEDUCT_RUBBLE);
    }
    // Cleared: where it goes (whatever's there), and over it where the ground's higher (from its
    // underside up; a block more than the ground's smooth height, as voxels stand a little over it).
    const g = groundAt(Math.floor(col.qx / N), Math.floor(col.qz / N));
    for (let y = slabBottom; y < Math.min(f + CLEAR_OVER, Math.max(f + WALL_TOP, g + B)); y += Q) air.add(`${col.qx},${y / Q},${col.qz}`);
    // Under it, down to the ground: a footing if it's low; else a pier, or an arch's spandrel over its curve.
    const under = slabBottom - g;
    if (under <= 0) continue;
    const low = under <= AQUEDUCT_FOOTING_M * M;
    const toPier = Math.abs(col.s - Math.round(col.s / P) * P), mid = Math.abs(col.s - (Math.floor(col.s / P) + 0.5) * P);
    for (let y = slabBottom - Q; y >= g - Q; y -= Q) {
      const depth = (slabBottom - y) / M;
      if (low || toPier <= PIER_HALF) {
        put(col.qx, y / Q, col.qz, AQUEDUCT_RUBBLE);
        continue;
      }
      // (The arch: open under a half circle between the piers' faces, its crown 1/2 m under the floor.)
      const curve = 0.5 + R - Math.sqrt(Math.max(0, R * R - mid * mid));
      if (depth > curve) break;
      put(col.qx, y / Q, col.qz, depth > curve - Q / M ? AQUEDUCT_DRESSED : AQUEDUCT_RUBBLE);
    }
  }
  const keys = channelKeys(cells, own);
  // (Where it goes is cleared too, whatever's there: then built, as the clearing comes first.)
  for (const k of solid.keys()) air.add(k);
  return { place: merged(solid), clear: merged(new Map([...air].map((k) => [k, Material.Air]))), keys };
}

/**
 * What each of `cells` needs standing for its water to pass (points, units): its floor under its
 * middle, and its walls beside it (each side of it that isn't channel: `own`'s cells count as
 * channel too).
 */
export function channelKeys(cells: readonly ChannelCell[], own: readonly ChannelCell[] = []): [number, number, number][][] {
  const B = BLOCK_SIZE, channel = new Set([...own, ...cells].map((c) => `${c.bx},${c.bz}`));
  return cells.map((c) => {
    const cx = (c.bx + 0.5) * B, cz = (c.bz + 0.5) * B;
    const out: [number, number, number][] = [[cx, c.floor - Q / 2, cz]];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (!channel.has(`${c.bx + dx},${c.bz + dz}`)) out.push([cx + dx * (B / 2 + Q / 2), c.floor + Q / 2, cz + dz * (B / 2 + Q / 2)]);
    return out;
  });
}

/** Quarter-metre voxels ("qx,qy,qz" → material) as pieces: a block's, merged into one 1 m voxel if all one material; else each 1/2 m octant that is; else as they are. */
function merged(voxels: ReadonlyMap<string, MaterialId>): AqueductPiece[] {
  const B = BLOCK_SIZE, N = B / Q, H = N / 2;
  const blocks = new Map<string, Map<string, MaterialId>>();
  for (const [k, m] of voxels) {
    const [qx, qy, qz] = k.split(',').map(Number) as [number, number, number];
    const bk = `${Math.floor(qx / N)},${Math.floor(qy / N)},${Math.floor(qz / N)}`;
    (blocks.get(bk) ?? blocks.set(bk, new Map()).get(bk)!).set(k, m);
  }
  const out: AqueductPiece[] = [];
  for (const [bk, inside] of blocks) {
    const [bx, by, bz] = bk.split(',').map(Number) as [number, number, number];
    const at = (x: number, y: number, z: number) => inside.get(`${bx * N + x},${by * N + y},${bz * N + z}`);
    /** The one material all of a cube (quarters x0.., `n` a side) is, or null. */
    const all = (x0: number, y0: number, z0: number, n: number): MaterialId | null => {
      const m = at(x0, y0, z0);
      if (m === undefined) return null;
      for (let y = y0; y < y0 + n; y++) for (let z = z0; z < z0 + n; z++) for (let x = x0; x < x0 + n; x++) if (at(x, y, z) !== m) return null;
      return m;
    };
    const whole = all(0, 0, 0, N);
    if (whole !== null) {
      out.push({ x: bx * B, y: by * B, z: bz * B, size: B, material: whole });
      continue;
    }
    for (let oy = 0; oy < N; oy += H)
      for (let oz = 0; oz < N; oz += H)
        for (let ox = 0; ox < N; ox += H) {
          const half = all(ox, oy, oz, H);
          if (half !== null) {
            out.push({ x: bx * B + ox * Q, y: by * B + oy * Q, z: bz * B + oz * Q, size: H * Q, material: half });
            continue;
          }
          for (let y = oy; y < oy + H; y++)
            for (let z = oz; z < oz + H; z++)
              for (let x = ox; x < ox + H; x++) {
                const m = at(x, y, z);
                if (m !== undefined) out.push({ x: bx * B + x * Q, y: by * B + y * Q, z: bz * B + z * Q, size: Q, material: m });
              }
        }
  }
  return out;
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
