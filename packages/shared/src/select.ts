import { BLOCK_SIZE } from './chunk.js';
import { blockVoxels, type BlockVoxel } from './edit.js';
import { isWater } from './materials.js';
import { isObjectMaterial } from './objects.js';
import { BUILD_MAX_CELLS, BUILD_MAX_SPAN, type Region } from './shapes.js';
import type { BlockReader, BuildPiece } from './extrude.js';

/**
 * Select, in the world (build mode): a box of the world picked up and put down elsewhere (moved,
 * or copied), turned about the vertical by quarter turns on the way. What's taken: every solid
 * voxel (not water, not an object's) whose middle is in the box, whole.
 */

/** A selection moved or copied, as sent: `region` (units, on the `size` grid) to `to` (its new low corner), turned `turns` quarter turns (clockwise from above). */
export interface TransformOp {
  region: Region;
  size: number;
  to: { x: number; y: number; z: number };
  turns: 0 | 1 | 2 | 3;
  copy: boolean;
}

/** Why a transform can't be done (its numbers), or '' if it can be tried. */
export function transformProblem(op: TransformOp): string {
  const { region: r, size: s, to } = op;
  if (![1, 2, 4, 8, 16].includes(s)) return 'not a size: 1/16 m to 1 m';
  const all = [r.x0, r.y0, r.z0, r.x1, r.y1, r.z1, to.x, to.y, to.z];
  if (!all.every((v) => Number.isInteger(v) && v % s === 0)) return 'not on the grid';
  if (!(r.x1 > r.x0 && r.y1 > r.y0 && r.z1 > r.z0)) return 'nothing selected';
  if (r.x1 - r.x0 > BUILD_MAX_SPAN || r.y1 - r.y0 > BUILD_MAX_SPAN || r.z1 - r.z0 > BUILD_MAX_SPAN) return 'too big: 64 m across at most';
  if (![0, 1, 2, 3].includes(op.turns)) return 'not a turn';
  return '';
}

/**
 * The voxels taken by a selection (world units): solid (not water, not an object's), their middle
 * in `r`. Or why not (not loaded; too many).
 */
export function voxelsIn(read: BlockReader, r: Region): BlockVoxel[] | string {
  const B = BLOCK_SIZE, out: BlockVoxel[] = [];
  for (let by = Math.floor(r.y0 / B); by * B < r.y1; by++)
    for (let bz = Math.floor(r.z0 / B); bz * B < r.z1; bz++)
      for (let bx = Math.floor(r.x0 / B); bx * B < r.x1; bx++) {
        const block = read(bx, by, bz);
        if (block === undefined) return 'not loaded yet';
        if (block === null) continue;
        for (const v of blockVoxels(block)) {
          if (isWater(v.material) || isObjectMaterial(v.material)) continue;
          const x = bx * B + v.x, y = by * B + v.y, z = bz * B + v.z, h = v.size / 2;
          if (x + h < r.x0 || x + h >= r.x1 || y + h < r.y0 || y + h >= r.y1 || z + h < r.z0 || z + h >= r.z1) continue;
          out.push({ x, y, z, size: v.size, material: v.material });
          if (out.length > BUILD_MAX_CELLS) return `too many voxels: ${BUILD_MAX_CELLS} at most`;
        }
      }
  return out;
}

/** The selection's size once turned (units: across x, up, across z). */
export function turnedSpan(r: Region, turns: number): [number, number, number] {
  const w = r.x1 - r.x0, h = r.y1 - r.y0, d = r.z1 - r.z0;
  return turns % 2 ? [d, h, w] : [w, h, d];
}

/**
 * Where a selection's voxels go: each turned `turns` quarter turns about the vertical (clockwise,
 * seen from above) within the selection, and the whole put with its low corner at `to`. A voxel
 * that would land off its own grid (bigger than the selection's grid size, and not lined up with
 * where it goes) goes as pieces of that size. Or why not (too many).
 */
export function transformPieces(voxels: readonly BlockVoxel[], op: TransformOp): BuildPiece[] | string {
  const { region: r, size: g, to, turns } = op;
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  // A cube at (x, z) (from the selection's corner) of size s, turned once: from (x, z) to (d - z - s, x); the box's depth becomes its width.
  const turn = (x: number, z: number, s: number): [number, number] => {
    let [a, b, ww, dd] = [x, z, w, d];
    for (let t = 0; t < turns; t++) {
      [a, b] = [dd - b - s, a];
      [ww, dd] = [dd, ww];
    }
    return [a, b];
  };
  const out: BuildPiece[] = [];
  const put = (x: number, y: number, z: number, s: number, material: number) => {
    const [a, b] = turn(x - r.x0, z - r.z0, s);
    out.push({ x: to.x + a, y: to.y + (y - r.y0), z: to.z + b, size: s, material });
  };
  for (const v of voxels) {
    const [a, b] = turn(v.x - r.x0, v.z - r.z0, v.size);
    const fits = [to.x + a, to.y + (v.y - r.y0), to.z + b].every((c) => c % v.size === 0);
    if (fits) put(v.x, v.y, v.z, v.size, v.material);
    else for (let y = 0; y < v.size; y += g) for (let z = 0; z < v.size; z += g) for (let x = 0; x < v.size; x += g) put(v.x + x, v.y + y, v.z + z, g, v.material);
    if (out.length > BUILD_MAX_CELLS) return `too many voxels: ${BUILD_MAX_CELLS} at most`;
  }
  return out;
}
