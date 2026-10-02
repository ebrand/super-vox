/**
 * Terraforming strokes: a world's hand-made changes to its generated ground, applied in order on
 * top of what the generator makes (see PlateHeights). Each works over a circle with a soft edge:
 *
 * - raise / lower: the ground up or down by `amount` metres;
 * - level: the ground toward `amount` metres above the sea (flattening a site, say);
 * - smooth: the small-scale bumps (and crags) toward the land's broad shape, by `amount` (0..1).
 *
 * They're stored as these few numbers, not as edited blocks, so everything made from the ground
 * (rock and snow, trees, rivers and lakes, maps) follows them.
 */
export type StrokeKind = 'raise' | 'lower' | 'level' | 'smooth';

export interface TerrainStroke {
  kind: StrokeKind;
  /** Centre (metres; x within the world). */
  x: number;
  z: number;
  /** Radius (m). */
  radius: number;
  /** raise / lower: metres; level: target height above the sea (m); smooth: strength 0..1. */
  amount: number;
  /** Share of the radius (from its rim inward) over which the stroke fades out: 0 sharp-edged, 1 fading from the centre. */
  softness: number;
}

export const STROKE_KINDS: readonly StrokeKind[] = ['raise', 'lower', 'level', 'smooth'];
export const STROKE_LIMITS = {
  radius: [1, 3000],
  amount: { raise: [0, 1000], lower: [0, 1000], level: [-1000, 1000], smooth: [0, 1] },
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

/**
 * Applies strokes to a point (units). `ground` is the ground there and `broad` the land's broad
 * shape under it (without small-scale bumps), both units; `sea` the sea level (units). Returns
 * both after the strokes, in order: raise, lower and level move both alike; smooth pulls the
 * ground toward the broad shape. `worldWidth` (units) wraps x when given (round worlds).
 */
export function applyStrokes(
  strokes: readonly TerrainStroke[], x: number, z: number, ground: number, broad: number, sea: number, worldWidth: number | null,
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
      case 'smooth':
        h += (e - h) * w * s.amount;
        break;
    }
  }
  return { ground: h, broad: e };
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
