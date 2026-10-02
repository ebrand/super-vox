import { DIRT_DEPTH, Material, NO_CANOPY, NO_WATER, subsurface, type MaterialId } from '@super-vox/shared';
import type { Quad } from './mesher.js';

/**
 * A diorama's surface: `cols` x `rows` samples `step` units apart (row-major; sample (i, j) is the
 * cell from (i * step, j * step) relative to the area's corner), with heights (units), surface
 * materials, the forest canopy over them (or null) and the water over them (the sea, rivers and
 * lakes; NO_WATER for none, or null). `base` (units) is where its cut-off bottom lies.
 */
export interface DioramaField {
  cols: number;
  rows: number;
  step: number;
  heights: Int32Array;
  materials: Uint16Array;
  canopy: { top: Int32Array; bottom: Int32Array; material: Uint16Array } | null;
  water: Int32Array | null;
  base: number;
}

/** Quads for a section of a diorama, in units relative to the section's corner and the base. */
export interface DioramaSection {
  ground: Quad[];
  water: Quad[];
}

// Horizontal neighbours: [di, dj, dir]; dirs follow DIRS (+X 0, -X 1, +Z 4, -Z 5).
const SIDES = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]] as const;

/**
 * Meshes the samples i0..i0+w-1, j0..j0+d-1 of a diorama as flat-topped columns (as the game draws
 * its distant terrain): a top per sample, walls down to lower neighbours, forest canopy as slabs
 * over the ground, water surfaces with sides where water steps down; and at the diorama's edges, cut
 * faces down to its base, layered as the ground is (the surface, a few metres of dirt or sand, then
 * stone), with the water cut off too. A bottom closes it.
 */
export function meshDioramaSection(f: DioramaField, i0: number, j0: number, w: number, d: number): DioramaSection {
  const { cols, rows, step, base } = f;
  const line = Math.min(32, step);
  const ground: Quad[] = [], water: Quad[] = [];
  const h = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? null : f.heights[i + cols * j]!);
  /** A wall on side `dir` of sample (i, j) from y0 to y1 (units, absolute). */
  const wall = (out: Quad[], i: number, j: number, dir: number, y0: number, y1: number, material: MaterialId) => {
    if (y1 <= y0) return;
    const li = i - i0, lj = j - j0, a = y0 - base, b = y1 - base;
    if (dir === 0 || dir === 1) out.push({ dir, plane: (li + (dir === 0 ? 1 : 0)) * step, u: a, v: lj * step, du: b - a, dv: step, material, size: line });
    else out.push({ dir, plane: (lj + (dir === 4 ? 1 : 0)) * step, u: li * step, v: a, du: step, dv: b - a, material, size: line });
  };
  const flat = (out: Quad[], i: number, j: number, y: number, up: boolean, material: MaterialId) => {
    out.push({ dir: up ? 2 : 3, plane: y - base, u: (j - j0) * step, v: (i - i0) * step, du: step, dv: step, material, size: line });
  };
  for (let j = j0; j < j0 + d; j++) {
    for (let i = i0; i < i0 + w; i++) {
      const k = i + cols * j, top = f.heights[k]!, material = f.materials[k]! as MaterialId;
      flat(ground, i, j, top, true, material);
      for (const [di, dj, dir] of SIDES) {
        const other = h(i + di, j + dj);
        if (other !== null) {
          wall(ground, i, j, dir, other, top, material);
          continue;
        }
        // The diorama's edge: a cut through the ground, layered.
        const under = subsurface(material);
        wall(ground, i, j, dir, Math.max(base, top - step), top, material);
        wall(ground, i, j, dir, Math.max(base, top - DIRT_DEPTH), Math.max(base, top - step), under);
        wall(ground, i, j, dir, base, Math.max(base, top - DIRT_DEPTH), Material.Stone);
      }
    }
  }
  // The bottom: one face under the whole section.
  ground.push({ dir: 3, plane: 0, u: 0, v: 0, du: d * step, dv: w * step, material: Material.Stone, size: line });
  // Forest canopy: crowns as slabs floating over the ground (top, underside, and the sides a
  // neighbour's crown leaves open).
  const c = f.canopy;
  if (c) {
    const crown = (i: number, j: number): [number, number] | null => {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return null;
      const k = i + cols * j;
      return c.top[k] === NO_CANOPY ? null : [c.bottom[k]!, c.top[k]!];
    };
    for (let j = j0; j < j0 + d; j++) {
      for (let i = i0; i < i0 + w; i++) {
        const cr = crown(i, j);
        if (!cr || cr[1] <= cr[0]) continue;
        const [b, t] = cr, material = c.material[i + cols * j]! as MaterialId;
        flat(ground, i, j, t, true, material);
        if (b > f.heights[i + cols * j]!) flat(ground, i, j, b, false, material);
        for (const [di, dj, dir] of SIDES) {
          const o = crown(i + di, j + dj);
          const open: [number, number][] = !o ? [[b, t]] : [[b, Math.min(t, o[0])], [Math.max(b, o[1]), t]];
          for (const [lo, hi] of open) wall(ground, i, j, dir, lo, hi, material);
        }
      }
    }
  }
  // Water: its surface over the ground, with sides where it stands above a neighbour's (a river
  // stepping down) and, at the diorama's edge, down to the ground (cut off like the ground).
  const wa = f.water;
  if (wa) {
    const surface = (i: number, j: number) => {
      const g = h(i, j);
      if (g === null) return null;
      const s = wa[i + cols * j]!;
      return s === NO_WATER || s <= g ? g : s;
    };
    for (let j = j0; j < j0 + d; j++) {
      for (let i = i0; i < i0 + w; i++) {
        const k = i + cols * j, s = wa[k]!, g = f.heights[k]!;
        if (s === NO_WATER || s <= g) continue;
        flat(water, i, j, s, true, Material.Water);
        for (const [di, dj, dir] of SIDES) {
          const other = surface(i + di, j + dj);
          wall(water, i, j, dir, other === null ? g : Math.max(other, g), s, Material.Water);
        }
      }
    }
  }
  return { ground, water };
}
