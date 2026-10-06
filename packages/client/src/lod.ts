import { CHUNK_SIZE, MAX_TILE_LEVEL, tileInWorld, tileSizeUnits, type TileCoord, type WorldConfig } from '@super-vox/shared';

export interface ColumnCoord {
  cx: number;
  cz: number;
}

export interface LodSelection {
  /** Chunk columns rendered at full voxel detail. */
  columns: ColumnCoord[];
  /** Low-detail tiles covering everything else within the view distance. */
  tiles: TileCoord[];
}

/**
 * Chooses what to render around a focus point (units) as a quadtree over
 * level-MAX_TILE_LEVEL tiles: a tile is split into its four children when
 * the focus is within `splitDistance(level)` of it (Chebyshev distance, inclusive), down
 * to full-detail chunk columns below level 1. Every point within `far` of the
 * focus is covered by exactly one node.
 *
 * `radius` is the full-detail radius in chunks; each coarser ring is twice as
 * wide as the previous one. `chunkRadius` (default `radius`) can shrink the part drawn as voxel
 * chunks, the rest of the full-detail area being 32 m tiles (1 m samples); below 0, no chunks.
 * `farRadius` (default `radius`) sets how fine the rings beyond the full-detail area are, as if
 * the full-detail radius were that: a bigger full-detail area needn't make far hills finer too.
 * `keep` says which columns are drawn as voxel chunks already: within the full-detail area, a 32 m
 * tile whose four columns all are stays those columns (detail isn't given up, only not added).
 */
export function selectLod(world: WorldConfig, focusX: number, focusZ: number, radius: number, far: number, chunkRadius = radius, farRadius = radius, keep?: (cx: number, cz: number) => boolean): LodSelection {
  const out: LodSelection = { columns: [], tiles: [] };
  const splitDistance = (level: number) => Math.max(radius * CHUNK_SIZE, farRadius * CHUNK_SIZE * 2 ** (level - 1));
  const distance = (x0: number, z0: number, size: number) =>
    Math.max(Math.max(x0 - focusX, 0, focusX - (x0 + size)), Math.max(z0 - focusZ, 0, focusZ - (z0 + size)));

  const visit = (level: number, tx: number, tz: number) => {
    const size = tileSizeUnits(level);
    const d = distance(tx * size, tz * size, size);
    if (d >= far) return;
    if (!tileInWorld(world, { level, tx, tz })) return;
    if (d > splitDistance(level)) {
      out.tiles.push({ level, tx, tz });
      return;
    }
    if (level === 1) {
      const kept = keep && d <= radius * CHUNK_SIZE && keep(tx * 2, tz * 2) && keep(tx * 2 + 1, tz * 2) && keep(tx * 2, tz * 2 + 1) && keep(tx * 2 + 1, tz * 2 + 1);
      if (!kept && (chunkRadius < 0 || d > chunkRadius * CHUNK_SIZE)) {
        out.tiles.push({ level, tx, tz });
        return;
      }
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const cx = tx * 2 + i, cz = tz * 2 + j;
          if (Math.max(Math.max(cx * CHUNK_SIZE - focusX, 0, focusX - (cx + 1) * CHUNK_SIZE), Math.max(cz * CHUNK_SIZE - focusZ, 0, focusZ - (cz + 1) * CHUNK_SIZE)) < far) {
            out.columns.push({ cx, cz });
          }
        }
      }
      return;
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) visit(level - 1, tx * 2 + i, tz * 2 + j);
  };

  const rootSize = tileSizeUnits(MAX_TILE_LEVEL);
  const r = Math.ceil(far / rootSize);
  const rx = Math.floor(focusX / rootSize), rz = Math.floor(focusZ / rootSize);
  for (let tz = rz - r; tz <= rz + r; tz++) for (let tx = rx - r; tx <= rx + r; tx++) visit(MAX_TILE_LEVEL, tx, tz);
  return out;
}

/** How far ahead (seconds of travel) the full-detail region is centred while moving. */
export const LEAD_SECONDS = 1;

/**
 * Offset (units) from the camera to the centre of the full-detail region, for a horizontal
 * velocity in units per second: ahead in the direction of travel, so chunks load before we reach
 * them; at most `radius - 1` chunks, so the camera's own column and the one behind it stay detailed.
 */
export function focusLead(vx: number, vz: number, radius: number): { dx: number; dz: number } {
  const max = Math.max(0, radius - 1) * CHUNK_SIZE;
  const speed = Math.hypot(vx, vz);
  if (speed === 0 || max === 0) return { dx: 0, dz: 0 };
  const scale = Math.min(LEAD_SECONDS, max / speed);
  return { dx: vx * scale, dz: vz * scale };
}

/** Speeds (m/s) between which voxel chunks give way to tiles while moving fast (see SpeedDetail). */
export const DETAIL_SPEEDS = { full: 25, none: 60 };
/**
 * Flying speeds (m/s) up to which voxel chunks are loaded all round, or half as far, at a chunk
 * radius of `detail`; none beyond (faster, they'd only arrive once we'd passed). Those already drawn
 * stay (see selectLod's `keep`). Measured on staging (12 vCPUs, 8 generation workers, 2026-10-05):
 * one player at detail 8 kept up to about 140 m/s over new ground, not 161; with room for other
 * players, 100 m/s at detail 8. The ring's leading edge grows with the radius, so the speeds go as
 * 1 / detail. Half as far kept up at 150 m/s at detail 8, not 245: 1.8 times the full speed.
 */
export function flySpeeds(detail: number): { full: number; half: number } {
  const full = (FLY_FULL_AT_8 * 8) / Math.max(1, detail);
  return { full, half: full * 1.8 };
}
/** flySpeeds' full speed at detail 8 (m/s). */
export const FLY_FULL_AT_8 = 100;
/** How long (ms) a lower speed must last before more voxel chunks come back. */
export const DETAIL_GROW_MS = 300;

/**
 * Voxel-chunk radius for the current speed, in three steps (few, so ordinary speed changes don't
 * keep rebuilding terrain): the full `detail` up to `full` m/s, half of it up to `none` m/s, none
 * (-1) beyond. Flying (faster), in three steps (flySpeeds, by detail): all, half, none (so loading keeps up with
 * the edge of the view, not voxel chunks we're about to leave; those already drawn stay). It
 * shrinks at once but grows back only after the lower speed has lasted DETAIL_GROW_MS, so speed
 * wobbles don't rebuild terrain.
 */
export class SpeedDetail {
  private current: number;
  private higherSince: number | null = null;
  private readonly fly: { full: number; half: number };

  constructor(
    private readonly detail: number,
    private readonly speeds = DETAIL_SPEEDS,
    private readonly growMs = DETAIL_GROW_MS,
  ) {
    this.current = detail;
    this.fly = flySpeeds(detail);
  }

  /** The chunk radius wanted at `speed` (m/s), flying or not, ignoring how long it has lasted. */
  target(speed: number, flying = false): number {
    const { full, none } = this.speeds;
    // (Unless detail at any speed was asked for.)
    if (flying && Number.isFinite(none)) {
      if (speed <= this.fly.full) return this.detail;
      if (speed <= this.fly.half) return Math.ceil(this.detail / 2);
      return -1;
    }
    if (speed <= full) return this.detail;
    if (speed < none) return Math.ceil(this.detail / 2);
    return -1;
  }

  update(speed: number, now: number, flying = false): number {
    const target = this.target(speed, flying);
    if (target < this.current) {
      this.current = target;
      this.higherSince = null;
    } else if (target > this.current) {
      this.higherSince ??= now;
      if (now - this.higherSince >= this.growMs) {
        this.current = target;
        this.higherSince = null;
      }
    } else {
      this.higherSince = null;
    }
    return this.current;
  }
}
