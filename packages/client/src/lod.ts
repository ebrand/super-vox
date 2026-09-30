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
 * wide as the previous one.
 */
export function selectLod(world: WorldConfig, focusX: number, focusZ: number, radius: number, far: number): LodSelection {
  const out: LodSelection = { columns: [], tiles: [] };
  const splitDistance = (level: number) => radius * CHUNK_SIZE * 2 ** (level - 1);
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
