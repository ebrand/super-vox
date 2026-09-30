import { NO_GROUND, TILE_SAMPLES, tileStep, type Tile } from '@super-vox/shared';
import { mergeFaces, type Quad } from './mesher.js';

/** Voxel size used for edge lines on tiles: 1 m, which fades out at tile distances anyway. */
const TILE_LINE_SIZE = 16;

/**
 * How far skirts hang below a tile's edge cells (units). Skirts hide cracks
 * where neighbouring tiles or chunks, sampled differently, meet slightly
 * lower; coarser tiles can disagree by more, so they hang deeper.
 */
export function skirtDepth(level: number): number {
  return Math.max(64, 2 * tileStep(level));
}

export interface TileMesh {
  /** Quads in tile-local units; Y is relative to `baseY`. */
  quads: Quad[];
  /** World Y (units) of the tile's local origin. */
  baseY: number;
}

/**
 * Meshes a tile as flat-topped columns, one per cell: a top face at the
 * cell's height, walls down to lower neighbouring cells, and skirts along the
 * tile edge and any edge of the world. Returns null for tiles with no ground.
 */
export function meshTile(tile: Tile): TileMesh | null {
  const n = TILE_SAMPLES;
  const step = tileStep(tile.level);
  const skirt = skirtDepth(tile.level);
  const h = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? NO_GROUND : tile.heights[i + n * j]!);

  let minH = Infinity;
  for (const v of tile.heights) if (v !== NO_GROUND && v < minH) minH = v;
  if (minH === Infinity) return null;
  const baseY = minH - skirt;

  const quads: Quad[] = [];
  const S = TILE_LINE_SIZE;
  // Horizontal neighbours: [di, dj, dir]; dirs follow DIRS (+X 0, -X 1, +Z 4, -Z 5).
  const sides = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]] as const;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const top = h(i, j);
      if (top === NO_GROUND) continue;
      const material = tile.materials[i + n * j]!;
      const y1 = top - baseY;
      // Top face: +Y plane, U = Z, V = X.
      quads.push({ dir: 2, plane: y1, u: j * step, v: i * step, du: step, dv: step, material, size: S });
      for (const [di, dj, dir] of sides) {
        const inTile = i + di >= 0 && i + di < n && j + dj >= 0 && j + dj < n;
        const other = h(i + di, j + dj);
        // Inside the tile, a wall down to a lower neighbour; at the tile or world edge, a skirt.
        const bottom = inTile && other !== NO_GROUND ? other : top - skirt;
        if (bottom >= top) continue;
        const y0 = bottom - baseY;
        if (dir === 0 || dir === 1) {
          // X walls: U = Y, V = Z.
          const plane = (i + (dir === 0 ? 1 : 0)) * step;
          quads.push({ dir, plane, u: y0, v: j * step, du: y1 - y0, dv: step, material, size: S });
        } else {
          // Z walls: U = X, V = Y.
          const plane = (j + (dir === 4 ? 1 : 0)) * step;
          quads.push({ dir, plane, u: i * step, v: y0, du: step, dv: y1 - y0, material, size: S });
        }
      }
    }
  }
  return { quads: mergeFaces(quads), baseY };
}
