/**
 * Terraforming strokes: a world's hand-made changes to its generated ground, applied in order on
 * top of what the generator makes (see PlateHeights). Each works over a circle with a soft edge:
 *
 * - raise / lower: the ground up or down by `amount` metres;
 * - level: the ground toward `amount` metres above the sea (flattening a site, say);
 * - smooth: the ground toward the average of the land's shape around it (see SMOOTH_REACH), by
 *   `amount` (0..1): small-scale bumps and crags go, and so do sharp shapes made by strokes (a
 *   levelled plateau's edge, a ridge), which round off;
 * - plant / clear: more or fewer trees, by `amount` (0..1): plant raises the chance of a tree in
 *   each spot under it toward certain, clear lowers it toward none. Trees stay the kind the biome
 *   grows, and only on ground trees grow on (see treeChance). The ground isn't changed.
 *
 * They're stored as these few numbers, not as edited blocks, so everything made from the ground
 * (rock and snow, trees, rivers and lakes, maps) follows them.
 */
export type StrokeKind = 'raise' | 'lower' | 'level' | 'smooth' | 'plant' | 'clear';

export interface TerrainStroke {
  kind: StrokeKind;
  /** Centre (metres; x within the world). */
  x: number;
  z: number;
  /** Radius (m). */
  radius: number;
  /** raise / lower: metres; level: target height above the sea (m); smooth, plant, clear: strength 0..1. */
  amount: number;
  /** Share of the radius (from its rim inward) over which the stroke fades out: 0 sharp-edged, 1 fading from the centre. */
  softness: number;
}

export const STROKE_KINDS: readonly StrokeKind[] = ['raise', 'lower', 'level', 'smooth', 'plant', 'clear'];

/** Whether a stroke changes the trees (plant, clear) rather than the ground. */
export const isTreeStroke = (s: Pick<TerrainStroke, 'kind'>): boolean => s.kind === 'plant' || s.kind === 'clear';
export const STROKE_LIMITS = {
  radius: [1, 3000],
  amount: { raise: [0, 1000], lower: [0, 1000], level: [-1000, 1000], smooth: [0, 1], plant: [0, 1], clear: [0, 1] },
  softness: [0, 1],
  /** Most strokes a world keeps. */
  count: 20_000,
} as const;

const M = 16;

/** Checks strokes (e.g. from a request), throwing RangeError for one that's malformed or out of range. */
export function validateStrokes(strokes: unknown): asserts strokes is TerrainStroke[] {
  if (!Array.isArray(strokes)) throw new RangeError('strokes must be a list');
  if (strokes.length > STROKE_LIMITS.count) throw new RangeError(`at most ${STROKE_LIMITS.count} strokes; got ${strokes.length}`);
  strokes.forEach((s: unknown, i) => {
    const o = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
    const where = `stroke ${i}`;
    if (!STROKE_KINDS.includes(o.kind as StrokeKind)) throw new RangeError(`${where}: kind must be one of ${STROKE_KINDS.join(', ')}`);
    const num = (k: string, [lo, hi]: readonly [number, number]) => {
      const v = o[k];
      if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new RangeError(`${where}: ${k} must be ${lo}..${hi}; got ${String(v)}`);
    };
    num('x', [-1e9, 1e9]);
    num('z', [-1e9, 1e9]);
    num('radius', STROKE_LIMITS.radius);
    num('amount', STROKE_LIMITS.amount[o.kind as StrokeKind]);
    num('softness', STROKE_LIMITS.softness);
  });
}

/** How much of a stroke applies `distance` metres from its centre: 1 within its core, fading smoothly to 0 at its rim. */
export function strokeWeight(s: Pick<TerrainStroke, 'radius' | 'softness'>, distance: number): number {
  if (distance >= s.radius) return 0;
  const core = s.radius * (1 - s.softness);
  if (distance <= core) return 1;
  const t = (s.radius - distance) / (s.radius - core);
  return t * t * (3 - 2 * t);
}

/** Smooth averages the land's shape over this share of its radius around each point. */
export const SMOOTH_REACH = 0.4;

/** Where smooth looks around a point: the point and two rings (offsets, as shares of the reach) and their weights. */
const SMOOTH_KERNEL: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.2],
  ...Array.from({ length: 6 }, (_, k) => [0.5 * Math.cos((k * Math.PI) / 3), 0.5 * Math.sin((k * Math.PI) / 3), 0.4 / 6] as const),
  ...Array.from({ length: 6 }, (_, k) => [Math.cos(((k + 0.5) * Math.PI) / 3), Math.sin(((k + 0.5) * Math.PI) / 3), 0.4 / 6] as const),
];

/** How far around a point smooth stroke `s` looks (units; see SMOOTH_REACH). */
export function smoothReach(s: Pick<TerrainStroke, 'radius'>): number {
  return Math.max(2, s.radius * SMOOTH_REACH) * M;
}

/** What smooth stroke `s` pulls the ground at (x, z) toward: the weighted average of `shape` around it (units). */
export function smoothAverage(s: Pick<TerrainStroke, 'radius'>, x: number, z: number, shape: (x: number, z: number) => number): number {
  const r = smoothReach(s);
  let sum = 0;
  for (const [kx, kz, kw] of SMOOTH_KERNEL) sum += kw * shape(x + kx * r, z + kz * r);
  return sum;
}

/** What smooth stroke `stroke` pulls the ground at (x, z) toward (units; see smoothAverage). */
export type SmoothTarget = (x: number, z: number, stroke: TerrainStroke) => number;

/**
 * Applies strokes to a point (units). `ground` is the ground there and `broad` the land's broad
 * shape under it (without small-scale bumps), both units; `sea` the sea level (units). Returns
 * both after the strokes, in order: raise, lower and level move both alike; smooth pulls both
 * toward the average of the land's shape around the point (from `smoothTarget`; without it, the
 * ground toward the broad shape here, which only removes bumps). `worldWidth` (units) wraps x when given
 * (round worlds).
 */
export function applyStrokes(
  strokes: readonly TerrainStroke[], x: number, z: number, ground: number, broad: number, sea: number, worldWidth: number | null, smoothTarget?: SmoothTarget,
): { ground: number; broad: number } {
  let h = ground, e = broad;
  for (const s of strokes) {
    let dx = x / M - s.x;
    if (worldWidth !== null) {
      const W = worldWidth / M;
      dx -= Math.round(dx / W) * W;
    }
    const w = strokeWeight(s, Math.hypot(dx, z / M - s.z));
    if (w <= 0) continue;
    switch (s.kind) {
      case 'raise':
        h += s.amount * M * w;
        e += s.amount * M * w;
        break;
      case 'lower':
        h -= s.amount * M * w;
        e -= s.amount * M * w;
        break;
      case 'level': {
        const target = sea + s.amount * M;
        h += (target - h) * w;
        e += (target - e) * w;
        break;
      }
      case 'smooth': {
        const target = smoothTarget ? smoothTarget(x, z, s) : e;
        h += (target - h) * w * s.amount;
        e += (target - e) * w * s.amount;
        break;
      }
    }
  }
  return { ground: h, broad: e };
}

/** A chunk column (16 m square, by chunk index) that players have built in: strokes keep clear of it. */
export interface ProtectedColumn {
  cx: number;
  cz: number;
}

/** Metres strokes keep from protected columns (as far as a tree's crown reaches, and a little). */
export const PROTECT_MARGIN = 12;

/**
 * Which strokes (their indexes) reach within PROTECT_MARGIN of any of `columns` (chunk columns
 * `chunkMetres` across); x wraps when `worldWidth` (metres) is given (round worlds).
 */
export function strokesOverColumns(strokes: readonly TerrainStroke[], columns: readonly ProtectedColumn[], chunkMetres: number, worldWidth: number | null): number[] {
  if (columns.length === 0) return [];
  const wrapCols = worldWidth !== null ? Math.round(worldWidth / chunkMetres) : null;
  const wrap = (cx: number) => (wrapCols !== null ? ((cx % wrapCols) + wrapCols) % wrapCols : cx);
  const keys = new Set(columns.map((c) => `${wrap(c.cx)},${c.cz}`));
  const out: number[] = [];
  strokes.forEach((s, i) => {
    const reach = s.radius + PROTECT_MARGIN;
    const c0 = Math.floor((s.x - reach) / chunkMetres), c1 = Math.floor((s.x + reach) / chunkMetres);
    const r0 = Math.floor((s.z - reach) / chunkMetres), r1 = Math.floor((s.z + reach) / chunkMetres);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!keys.has(`${wrap(c)},${r}`)) continue;
        // The nearest point of the column's square to the stroke's centre.
        const nx = Math.max(c * chunkMetres, Math.min((c + 1) * chunkMetres, s.x)), nz = Math.max(r * chunkMetres, Math.min((r + 1) * chunkMetres, s.z));
        if (Math.hypot(nx - s.x, nz - s.z) < reach) {
          out.push(i);
          return;
        }
      }
    }
  });
  return out;
}

/**
 * The chance of a tree at (x, z) (units) where the world gives it `chance` (0..1), after the plant
 * and clear strokes, in order: plant takes it toward 1, clear toward 0, each by its amount where
 * it's at full strength. `worldWidth` (units) wraps x when given (round worlds).
 */
export function treeChance(strokes: readonly TerrainStroke[], x: number, z: number, chance: number, worldWidth: number | null): number {
  let p = chance;
  for (const s of strokes) {
    if (!isTreeStroke(s)) continue;
    let dx = x / M - s.x;
    if (worldWidth !== null) {
      const W = worldWidth / M;
      dx -= Math.round(dx / W) * W;
    }
    const w = strokeWeight(s, Math.hypot(dx, z / M - s.z)) * s.amount;
    if (w <= 0) continue;
    p = s.kind === 'plant' ? p + (1 - p) * w : p * (1 - w);
  }
  return p;
}

/**
 * The strokes that reach into the box [x0, x1] x [z0, z1] (units), in order; wraps x on round
 * worlds (`worldWidth`, units). For applying strokes to a block of samples without checking every
 * stroke at every sample.
 */
export function strokesIn(strokes: readonly TerrainStroke[], x0: number, z0: number, x1: number, z1: number, worldWidth: number | null): TerrainStroke[] {
  return strokes.filter((s) => {
    const r = s.radius * M, sz = s.z * M;
    if (sz + r < z0 || sz - r > z1) return false;
    let sx = s.x * M;
    // A box as wide as the world (less the stroke) sees some copy of it.
    if (worldWidth !== null && x1 - x0 + 2 * r >= worldWidth) return true;
    if (worldWidth !== null) {
      // The copy of the stroke nearest the box.
      const mid = (x0 + x1) / 2;
      sx += Math.round((mid - sx) / worldWidth) * worldWidth;
    }
    return sx + r >= x0 && sx - r <= x1;
  });
}

/**
 * Strokes by where they reach: a grid of `cell`-unit squares, each listing (in order) the strokes
 * that reach into it, so a point only checks those. For blocks with many strokes in reach (a
 * whole-world map, say). `worldWidth` (units) wraps x on round worlds.
 */
export class StrokeIndex {
  private readonly cells = new Map<number, TerrainStroke[]>();
  private readonly wrapCols: number | null;
  private readonly cell: number;

  constructor(strokes: readonly TerrainStroke[], worldWidth: number | null, cell = 256 * M) {
    // On a round world the squares must tile its width exactly, so x wraps square for square.
    this.wrapCols = worldWidth !== null ? Math.max(1, Math.round(worldWidth / cell)) : null;
    this.cell = cell = worldWidth !== null ? worldWidth / this.wrapCols! : cell;
    for (const s of strokes) {
      const r = s.radius * M, x = s.x * M, z = s.z * M;
      const c0 = Math.floor((x - r) / cell), c1 = Math.floor((x + r) / cell);
      const r0 = Math.floor((z - r) / cell), r1 = Math.floor((z + r) / cell);
      const seen = new Set<number>();
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          const key = this.key(cc, rr);
          // (A stroke wider than a round world reaches some cells twice: list it once, in order.)
          if (seen.has(key)) continue;
          seen.add(key);
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(s);
        }
      }
    }
  }

  /** The strokes (in order) that may reach the point (units). */
  at(x: number, z: number): readonly TerrainStroke[] {
    return this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? NONE;
  }

  private key(c: number, r: number): number {
    if (this.wrapCols !== null) c = ((c % this.wrapCols) + this.wrapCols) % this.wrapCols;
    // Room for 2^20 columns either side.
    return (r + (1 << 20)) * (1 << 21) + (c + (1 << 20));
  }
}

const NONE: readonly TerrainStroke[] = [];
