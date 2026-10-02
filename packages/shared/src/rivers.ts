/**
 * Rivers and lakes on a heightfield grid. Water drains from every cell toward the sea (or the
 * world's edge) along the lowest route: basins are filled to their spill height first (priority
 * flood), the big ones becoming lakes and the rest filled in. Where enough water has gathered
 * (by area, weighted by how wet each cell is) a river runs, wider and deeper the more it carries,
 * along a smoothed path; at sample time it cuts its channel and a valley around it.
 */

const NO_LAKE = NaN;

export interface HydrologyInput {
  /** Ground height per cell (units), row-major cols x rows; basins that don't become lakes are raised in place. */
  elevation: Float32Array;
  cols: number;
  rows: number;
  /** Cell size (units). */
  cell: number;
  /** Sea level (units): cells at or below drain into it. */
  sea: number;
  wrap: boolean;
  /** Per cell 0..1, how much water it adds (null: 1 everywhere). */
  wetness: Float32Array | null;
  /** 0 (none) .. 100 (many small streams); 50 is a moderate network. */
  rivers: number;
  /** 0 (basins filled in) .. 100 (even small basins hold lakes). */
  lakes: number;
  seed: number;
}

/** A stretch of river between two points (units), with its water surface height at each end. */
export interface RiverSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Water surface at a and b (units). */
  sa: number;
  sb: number;
  /** Width of the water and depth at the middle (units). */
  width: number;
  depth: number;
}

export interface Hydrology {
  segments: RiverSegment[];
  /** Per cell: the lake's water surface (units), NaN where there's no lake. */
  lakeLevel: Float32Array;
  /** Lakes and the cells they cover. */
  lakeCount: number;
  lakeCells: number;
  /** Cells of river. */
  riverCells: number;
}

const M = 16;
/** Valley sides rise this much per unit out from the river's edge. */
export const BANK_SLOPE = 0.3;
/** How far beyond its edge a river shapes the ground (units). */
export const VALLEY_REACH = 96 * M;
/**
 * Over the outer part of that reach, from this far out, the valley gives way to the ground, so it
 * ends where the ground is instead of cutting off. (On a stream falling faster than BANK_SLOPE,
 * the valley there can still be well below the ground, and a cut-off left a step of metres.)
 */
const VALLEY_FADE = VALLEY_REACH / 2;
/** Banks this much further away than the nearest count e^-1 as much toward the valley's level (units). */
const VALLEY_BLEND = 6 * M;
/** Widest river (units). */
const MAX_WIDTH = 50 * M;
/** A basin must be this deep (units) to hold a lake. */
const LAKE_MIN_DEPTH = 1 * M;

/** Cells drained into a river's head, by the rivers setting (0: no rivers). */
export function riverThreshold(rivers: number): number {
  return rivers <= 0 ? Infinity : 4000 * 0.5 ** (rivers / 10);
}

/** Smallest lake (cells), by the lakes setting (0: no lakes). */
export function lakeMinCells(lakes: number): number {
  return lakes <= 0 ? Infinity : 2000 * 0.5 ** (lakes / 10);
}

/**
 * River width and depth (units) for water gathered from `drained` cells of size `cell`: wider than
 * real rivers of such small basins (a few km2 on these worlds), so the main ones read as rivers.
 */
export function riverSize(drained: number, cell: number): { width: number; depth: number } {
  const km2 = (drained * cell * cell) / (M * M) / 1e6;
  const width = Math.min(MAX_WIDTH, (2 + 12 * Math.sqrt(km2)) * M);
  return { width, depth: 0.4 * M + 0.08 * width };
}

/** A binary min-heap of cell indices by key. */
class Heap {
  private readonly idx: number[] = [];
  private readonly key: number[] = [];
  get size(): number {
    return this.idx.length;
  }
  push(i: number, k: number): void {
    const a = this.idx, b = this.key;
    let n = a.length;
    a.push(i);
    b.push(k);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (b[p]! <= k) break;
      a[n] = a[p]!;
      b[n] = b[p]!;
      n = p;
    }
    a[n] = i;
    b[n] = k;
  }
  pop(): number {
    const a = this.idx, b = this.key;
    const top = a[0]!;
    const li = a.pop()!, lk = b.pop()!;
    const n = a.length;
    if (n > 0) {
      let j = 0;
      for (;;) {
        let c = 2 * j + 1;
        if (c >= n) break;
        if (c + 1 < n && b[c + 1]! < b[c]!) c++;
        if (b[c]! >= lk) break;
        a[j] = a[c]!;
        b[j] = b[c]!;
        j = c;
      }
      a[j] = li;
      b[j] = lk;
    }
    return top;
  }
}

function hash(a: number, b: number, seed: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function buildHydrology(input: HydrologyInput): Hydrology {
  const { elevation: E, cols, rows, cell, sea, wrap } = input;
  const n = cols * rows;
  const at = (c: number, r: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
  };
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
  /**
   * Priority flood from the sea: every cell drains to
   * the neighbour it was reached from, and gets a filled height F (its basin's spill height if
   * it's in one, nudged up so flats still drain). `order` lists cells outlets first.
   */
  const flood = () => {
    const F = new Float32Array(n);
    const down = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const outlet = new Uint8Array(n);
    const order: number[] = [];
    const heap = new Heap();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        if (E[i]! <= sea) {
          F[i] = Math.max(E[i]!, sea);
          done[i] = outlet[i] = 1;
          heap.push(i, F[i]!);
        }
      }
    }
    while (heap.size > 0) {
      const i = heap.pop();
      order.push(i);
      const c = i % cols, r = (i - c) / cols;
      for (const [dc, dr] of NB) {
        const j = at(c + dc, r + dr);
        if (j < 0 || done[j]) continue;
        done[j] = 1;
        // (A little jitter, under half a metre, so flats drain along wandering lines, not straight ones.)
        F[j] = Math.max(E[j]! + hash(j, 3, input.seed) * 8, F[i]! + 0.01);
        down[j] = i;
        heap.push(j, F[j]!);
      }
    }
    return { F, down, outlet, order };
  };
  /** Water gathered by every cell: its own and everything upstream (later in `order`). */
  const gather = (down: Int32Array, order: number[]) => {
    const g = new Float32Array(n);
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k]!;
      g[i] = g[i]! + (input.wetness ? input.wetness[i]! : 1);
      const d = down[i]!;
      if (d >= 0) g[d] = g[d]! + g[i]!;
    }
    return g;
  };

  const { F, down, outlet, order } = flood();

  // 2. Basins: connected cells filled over half a metre (beyond the jitter) above the ground; deep
  //    enough and big enough ones
  //    are lakes at their spill height; the rest are filled in.
  const lakeLevel = new Float32Array(n).fill(NO_LAKE);
  const minLake = lakeMinCells(input.lakes);
  const seen = new Uint8Array(n);
  let lakeCount = 0, lakeCells = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s] || outlet[s] || F[s]! - E[s]! <= 8.5) continue;
    const cells: number[] = [s];
    seen[s] = 1;
    let deepest = 0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k]!;
      deepest = Math.max(deepest, F[i]! - E[i]!);
      const c = i % cols, r = (i - c) / cols;
      for (const [dc, dr] of NB.slice(0, 4)) {
        const j = at(c + dc, r + dr);
        if (j < 0 || seen[j] || outlet[j] || F[j]! - E[j]! <= 8.5) continue;
        seen[j] = 1;
        cells.push(j);
      }
    }
    if (cells.length >= minLake && deepest >= LAKE_MIN_DEPTH) {
      let level = Infinity;
      for (const i of cells) level = Math.min(level, F[i]!);
      for (const i of cells) lakeLevel[i] = level;
      lakeCount++;
      lakeCells += cells.length;
    } else {
      for (const i of cells) E[i] = F[i]!;
    }
  }

  // 3. Water gathered by every cell.
  const gathered = gather(down, order);

  // 4. Rivers: land cells (not lakes) that gather enough, each flowing to the next cell down.
  //    Points sit at cell centres, nudged a little and eased toward their neighbours so courses
  //    don't follow the grid.
  const threshold = riverThreshold(input.rivers);
  const isRiver = new Uint8Array(n);
  let riverCells = 0;
  for (let i = 0; i < n; i++) {
    if (gathered[i]! >= threshold && E[i]! > sea && Number.isNaN(lakeLevel[i]!)) {
      isRiver[i] = 1;
      riverCells++;
    }
  }
  // The main upstream river cell of each river cell (the one bringing the most water).
  const mainUp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!isRiver[i] || down[i]! < 0) continue;
    const d = down[i]!;
    if (mainUp[d]! < 0 || gathered[i]! > gathered[mainUp[d]!]!) mainUp[d] = i;
  }
  const centre = (i: number): [number, number] => {
    const c = i % cols, r = (i - c) / cols;
    return [(c + 0.5) * cell, (r + 0.5) * cell];
  };
  const point = (i: number): [number, number] => {
    let [x, z] = centre(i);
    const j = [hash(i, 1, input.seed) - 0.5, hash(i, 2, input.seed) - 0.5];
    x += j[0]! * 0.5 * cell;
    z += j[1]! * 0.5 * cell;
    // Ease toward the neighbours along the river.
    const nb = [down[i]!, mainUp[i]!].filter((k) => k >= 0);
    if (nb.length === 2) {
      const [ax, az] = centre(nb[0]!), [bx, bz] = centre(nb[1]!);
      const unwrap = (v: number, ref: number) => (wrap ? v - Math.round((v - ref) / (cols * cell)) * cols * cell : v);
      x = 0.5 * x + 0.25 * (unwrap(ax, x) + unwrap(bx, x));
      z = 0.5 * z + 0.25 * (az + bz);
    }
    return [x, z];
  };
  const pts = new Map<number, [number, number]>();
  const pointOf = (i: number) => {
    let p = pts.get(i);
    if (!p) pts.set(i, (p = point(i)));
    return p;
  };
  const segments: RiverSegment[] = [];
  for (let i = 0; i < n; i++) {
    if (!isRiver[i]) continue;
    const d = down[i]!;
    if (d < 0) continue;
    const { width, depth } = riverSize(gathered[i]!, cell);
    const [ax, az] = pointOf(i);
    // Into the sea or a lake: run to that cell's centre, at its water level.
    const intoWater = !isRiver[d];
    const [bx, bz] = intoWater ? centre(d) : pointOf(d);
    const sa = Math.round(F[i]!);
    const sb = intoWater ? Math.round(Number.isNaN(lakeLevel[d]!) ? Math.max(sea, F[d]!) : lakeLevel[d]!) : Math.round(F[d]!);
    const bxw = wrap ? bx - Math.round((bx - ax) / (cols * cell)) * cols * cell : bx;
    segments.push({ ax, az, bx: bxw, bz, sa, sb: Math.min(sa, sb), width, depth });
  }
  return { segments, lakeLevel, lakeCount, lakeCells, riverCells };
}

const NONE: readonly RiverSegment[] = [];

/** Rivers bucketed by area, for finding the ones near a point quickly. */
export class RiverIndex {
  private readonly buckets = new Map<number, RiverSegment[]>();
  private readonly size: number;

  constructor(
    segments: readonly RiverSegment[],
    private readonly worldWidth: number,
    private readonly wrap: boolean,
    bucket = 128 * M,
  ) {
    this.size = bucket;
    const cols = Math.ceil(worldWidth / bucket);
    for (const s of segments) {
      const reach = s.width / 2 + VALLEY_REACH;
      const x0 = Math.floor((Math.min(s.ax, s.bx) - reach) / bucket), x1 = Math.floor((Math.max(s.ax, s.bx) + reach) / bucket);
      const z0 = Math.floor((Math.min(s.az, s.bz) - reach) / bucket), z1 = Math.floor((Math.max(s.az, s.bz) + reach) / bucket);
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          const key = this.key(wrap ? ((bx % cols) + cols) % cols : bx, bz);
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(s);
        }
      }
    }
  }

  private key(bx: number, bz: number): number {
    return (bz + 4096) * 8192 + (bx + 4096);
  }

  /** Segments that may shape the ground at a point (units): its bucket's list (don't modify). */
  at(x: number, z: number): readonly RiverSegment[] {
    const cols = Math.ceil(this.worldWidth / this.size);
    const bx = Math.floor(x / this.size);
    return this.buckets.get(this.key(this.wrap ? ((bx % cols) + cols) % cols : bx, Math.floor(z / this.size))) ?? NONE;
  }

  /** Segments that may shape the ground in the box [x0, x1] x [z0, z1] (units). */
  near(x0: number, z0: number, x1: number, z1: number): RiverSegment[] {
    const out = new Set<RiverSegment>();
    const cols = Math.ceil(this.worldWidth / this.size);
    for (let bz = Math.floor(z0 / this.size); bz <= Math.floor(z1 / this.size); bz++) {
      for (let bx = Math.floor(x0 / this.size); bx <= Math.floor(x1 / this.size); bx++) {
        const list = this.buckets.get(this.key(this.wrap ? ((bx % cols) + cols) % cols : bx, bz));
        if (list) for (const s of list) out.add(s);
      }
    }
    return [...out];
  }
}

/**
 * The ground and river water at a point (units) near `segments`: the ground cut to the river's
 * channel (a rounded bed `depth` below its surface across its width) and valley (rising at
 * BANK_SLOPE beyond its edge, and giving way to the ground over the outer half of VALLEY_REACH),
 * and the water surface where it's in a channel (or null).
 */
export function carveRivers(segments: readonly RiverSegment[], x: number, z: number, ground: number, worldWidth: number, wrap: boolean): { ground: number; water: number | null } {
  let g = ground, water: number | null = null;
  // The valley rises from the nearest bank, at the water's level there: blended over the banks
  // nearly as close (weights falling off over VALLEY_BLEND), so it has no seams where the
  // nearest piece of river changes. (Taking the lowest of every piece's valley instead lets a
  // steep stream's lower pieces cut fans far up the hillside.)
  let nearest = Infinity, weight = 0, level = 0;
  const banks: { edge: number; surface: number }[] = [];
  for (const s of segments) {
    let px = x;
    if (wrap) px -= Math.round((px - (s.ax + s.bx) / 2) / worldWidth) * worldWidth;
    const vx = s.bx - s.ax, vz = s.bz - s.az;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.ax) * vx + (z - s.az) * vz) / len2)) : 0;
    const d = Math.hypot(px - (s.ax + t * vx), z - (s.az + t * vz));
    const half = s.width / 2;
    if (d > half + VALLEY_REACH) continue;
    const surface = s.sa + (s.sb - s.sa) * t;
    if (d < half) {
      const u = d / half;
      g = Math.min(g, surface - s.depth * (1 - u * u));
      water = water === null ? surface : Math.max(water, surface);
    }
    banks.push({ edge: Math.max(0, d - half), surface });
    nearest = Math.min(nearest, Math.max(0, d - half));
  }
  if (banks.length > 0) {
    for (const b of banks) {
      const w = Math.exp(-(b.edge - nearest) / VALLEY_BLEND);
      weight += w;
      level += w * b.surface;
    }
    const valley = Math.min(ground, level / weight + nearest * BANK_SLOPE);
    const t = Math.max(0, Math.min(1, (nearest - VALLEY_FADE) / (VALLEY_REACH - VALLEY_FADE)));
    g = Math.min(g, valley + (ground - valley) * t * t * (3 - 2 * t));
  }
  return { ground: g, water: water !== null && g < water ? water : null };
}
