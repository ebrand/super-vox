import type { Block } from './chunk.js';
import { BLOCK_SIZE } from './chunk.js';
import { blockVoxelContaining, blockVoxels, type BlockVoxel } from './edit.js';
import { isWater } from './materials.js';
import { isObjectMaterial } from './objects.js';
import { BUILD_MAX_CELLS, BUILD_MAX_SPAN } from './shapes.js';

/**
 * Extrude, in the world (build mode): a flat face of voxels (see flatFace) grown out, each voxel a
 * column of copies of itself, or cut back into. The client works out the face to show it; the
 * server works it out again (from the same start) to do it.
 */

/** The world's blocks, by block coordinates: undefined where they aren't loaded. */
export type BlockReader = (bx: number, by: number, bz: number) => Block | undefined;

/** Most voxels a face taken by Extrude may have. */
export const EXTRUDE_MAX_FACE = 16_384;

/** A piece of a build: a cube (units, on its own size's grid) and what it's made of. */
export interface BuildPiece {
  x: number;
  y: number;
  z: number;
  size: number;
  material: number;
}

const KEYS = ['x', 'y', 'z'] as const;

/** The solid voxel (not water) covering unit cell (x, y, z), world units; null: none; undefined: not loaded. */
function voxelAt(read: BlockReader, x: number, y: number, z: number): BlockVoxel | null | undefined {
  const B = BLOCK_SIZE, bx = Math.floor(x / B), by = Math.floor(y / B), bz = Math.floor(z / B);
  const block = read(bx, by, bz);
  if (block === undefined) return undefined;
  const v = blockVoxelContaining(block, x - bx * B, y - by * B, z - bz * B);
  if (!v || isWater(v.material)) return null;
  return { x: bx * B + v.x, y: by * B + v.y, z: bz * B + v.z, size: v.size, material: v.material };
}

/** Whether anything solid (not water) is in the box lo..hi (units, hi exclusive); undefined: not loaded. */
function solidIn(read: BlockReader, lo: readonly number[], hi: readonly number[]): boolean | undefined {
  const B = BLOCK_SIZE;
  for (let by = Math.floor(lo[1]! / B); by * B < hi[1]!; by++)
    for (let bz = Math.floor(lo[2]! / B); bz * B < hi[2]!; bz++)
      for (let bx = Math.floor(lo[0]! / B); bx * B < hi[0]!; bx++) {
        const block = read(bx, by, bz);
        if (block === undefined) return undefined;
        if (block === null) continue;
        if (block.kind === 'uniform') {
          if (!isWater(block.material)) return true;
          continue;
        }
        for (const v of blockVoxels(block)) {
          if (isWater(v.material)) continue;
          const x = bx * B + v.x, y = by * B + v.y, z = bz * B + v.z;
          if (x < hi[0]! && lo[0]! < x + v.size && y < hi[1]! && lo[1]! < y + v.size && z < hi[2]! && lo[2]! < z + v.size) return true;
        }
      }
  return false;
}

/**
 * The flat face aimed at: the voxel covering unit cell `at`, its face on side `axis` (0 x, 1 y,
 * 2 z), `sign` (which way out); and every voxel whose face that way lies in the same plane, is open
 * (nothing solid right against it) and is joined to it edge to edge, through others like it. As in
 * the object designer (DesignEditor.flatFace). Water and objects' voxels are never in it. Or why
 * not: that face isn't open, it's too big (EXTRUDE_MAX_FACE voxels, BUILD_MAX_SPAN across), or not
 * loaded.
 */
export function flatFace(read: BlockReader, at: readonly number[], axis: 0 | 1 | 2, sign: 1 | -1): BlockVoxel[] | string {
  const first = voxelAt(read, at[0]!, at[1]!, at[2]!);
  if (first === undefined) return 'not loaded yet';
  if (!first || isObjectMaterial(first.material)) return 'nothing there to extrude';
  const k = KEYS[axis];
  const plane = (v: BlockVoxel) => v[k] + (sign > 0 ? v.size : 0);
  const p = plane(first);
  // Open: nothing solid in the unit-thick layer beyond its face.
  const open = (v: BlockVoxel) => {
    const lo = [v.x, v.y, v.z], hi = [v.x + v.size, v.y + v.size, v.z + v.size];
    lo[axis] = sign > 0 ? p : p - 1;
    hi[axis] = lo[axis]! + 1;
    return solidIn(read, lo, hi);
  };
  const o = open(first);
  if (o === undefined) return 'not loaded yet';
  if (o) return "that face isn't open: something's right against it";
  const [ua, va] = ([0, 1, 2] as const).filter((a) => a !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  // (The layer just inside the plane: where the face's voxels are.)
  const inside = sign > 0 ? p - 1 : p;
  const key = (v: BlockVoxel) => `${v.x},${v.y},${v.z}`;
  const seen = new Set<string>([key(first)]);
  const out: BlockVoxel[] = [], todo = [first];
  const lo = [first.x, first.y, first.z], hi = [first.x + first.size, first.y + first.size, first.z + first.size];
  while (todo.length) {
    const v = todo.pop()!;
    out.push(v);
    if (out.length > EXTRUDE_MAX_FACE) return `that face is too big: more than ${EXTRUDE_MAX_FACE} voxels`;
    for (const a of [ua, va]) {
      lo[a] = Math.min(lo[a]!, v[KEYS[a]]);
      hi[a] = Math.max(hi[a]!, v[KEYS[a]] + v.size);
      if (hi[a]! - lo[a]! > BUILD_MAX_SPAN) return 'that face is too big: more than 64 m across';
    }
    // Along each of its four edges, just outside it: the voxels there (stepping over each found).
    const s = v.size, u0 = v[KEYS[ua]], w0 = v[KEYS[va]];
    for (const [across, along, at0] of [[ua, va, u0 - 1], [ua, va, u0 + s], [va, ua, w0 - 1], [va, ua, w0 + s]] as const) {
      const start = along === va ? w0 : u0;
      for (let t = start; t < start + s; ) {
        const c = [0, 0, 0];
        c[axis] = inside;
        c[across] = at0;
        c[along] = t;
        const n = voxelAt(read, c[0]!, c[1]!, c[2]!);
        if (!n) {
          t++;
          continue;
        }
        t = n[KEYS[along]] + n.size;
        if (plane(n) !== p || isObjectMaterial(n.material) || seen.has(key(n))) continue;
        seen.add(key(n));
        const ok = open(n);
        if (ok === undefined) return 'not loaded yet';
        if (!ok) todo.push(n);
      }
    }
  }
  return out;
}

/**
 * Extrude's pieces: each of the face's voxels grown out `depth` units (whole copies of it: as many
 * as fit), or (`depth` negative) the space that deep behind each, to clear. Or why not (too many).
 */
export function extrudePieces(face: readonly BlockVoxel[], axis: 0 | 1 | 2, sign: 1 | -1, depth: number): { pieces: BuildPiece[]; clear: boolean } | string {
  const k = KEYS[axis], d = Math.abs(depth), pieces: BuildPiece[] = [];
  if (!Number.isInteger(d) || d === 0) return 'aim out to extrude, or in to cut back';
  if (d > BUILD_MAX_SPAN) return 'too far: 64 m at most';
  const tooMany = `too many voxels: ${BUILD_MAX_CELLS} at most`;
  if (depth > 0) {
    for (const v of face)
      for (let n = 1; n * v.size <= d; n++) {
        pieces.push({ x: v.x, y: v.y, z: v.z, size: v.size, material: v.material, [k]: v[k] + sign * n * v.size });
        if (pieces.length > BUILD_MAX_CELLS) return tooMany;
      }
    return { pieces, clear: false };
  }
  // Cut back: the voxel's column, d deep from its face, in cubes as big as tile it.
  const g = (s: number) => Math.min(s, d & -d);
  for (const v of face) {
    const c = g(v.size), face0 = v[k] + (sign > 0 ? v.size : 0);
    const [ua, va] = ([0, 1, 2] as const).filter((a) => a !== axis) as [0 | 1 | 2, 0 | 1 | 2];
    for (let t = 0; t < d; t += c)
      for (let a = 0; a < v.size; a += c)
        for (let b = 0; b < v.size; b += c) {
          const p = { x: 0, y: 0, z: 0, size: c, material: 0 };
          p[k] = sign > 0 ? face0 - t - c : face0 + t;
          p[KEYS[ua]] = v[KEYS[ua]] + a;
          p[KEYS[va]] = v[KEYS[va]] + b;
          pieces.push(p);
          if (pieces.length > BUILD_MAX_CELLS) return tooMany;
        }
  }
  return { pieces, clear: true };
}
