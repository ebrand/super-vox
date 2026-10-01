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
        // Inside the tile, a wall down to a lower neighbour; at the tile or world edge, a skirt
        // down to the tile's base. (Down to the bottom, not just a few metres: a column of forest
        // canopy at the edge would otherwise be open underneath, and you'd see through it.)
        const bottom = inTile && other !== NO_GROUND ? other : baseY;
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
  // Forest canopy: crowns as slabs floating over the ground (top, underside, and the sides
  // where a neighbour's crown doesn't cover them).
  const top = tile.canopyTop, bot = tile.canopyBottom, leaf = tile.canopyMaterials;
  if (top && bot && leaf) {
    const crown = (i: number, j: number): [number, number] | null => {
      if (i < 0 || j < 0 || i >= n || j >= n) return null;
      const k = i + n * j;
      return top[k] === NO_GROUND || tile.heights[k] === NO_GROUND ? null : [bot[k]!, top[k]!];
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = crown(i, j);
        if (!c) continue;
        const [b, t] = c;
        if (t <= b) continue;
        const material = leaf[i + n * j]!;
        const y1 = t - baseY, y0 = b - baseY;
        quads.push({ dir: 2, plane: y1, u: j * step, v: i * step, du: step, dv: step, material, size: S });
        if (b > h(i, j)) quads.push({ dir: 3, plane: y0, u: j * step, v: i * step, du: step, dv: step, material, size: S });
        for (const [di, dj, dir] of sides) {
          const o = crown(i + di, j + dj);
          // The parts of [b, t] the neighbour's crown leaves open.
          const open: [number, number][] = !o ? [[b, t]] : [[b, Math.min(t, o[0])], [Math.max(b, o[1]), t]];
          for (const [lo, hi] of open) {
            if (hi <= lo) continue;
            const u0 = lo - baseY, u1 = hi - baseY;
            if (dir === 0 || dir === 1) {
              const plane = (i + (dir === 0 ? 1 : 0)) * step;
              quads.push({ dir, plane, u: u0, v: j * step, du: u1 - u0, dv: step, material, size: S });
            } else {
              const plane = (j + (dir === 4 ? 1 : 0)) * step;
              quads.push({ dir, plane, u: i * step, v: u0, du: step, dv: u1 - u0, material, size: S });
            }
          }
        }
      }
    }
  }
  return { quads: mergeFaces(quads), baseY };
}
