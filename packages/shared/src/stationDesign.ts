import { BLOCK_SIZE } from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import type { BlockVoxel } from './edit.js';
import type { ObjectDesign } from './designs.js';
import { PLATFORM_M } from './trains.js';

/**
 * The railway station as a design (its role 'railway-station': see STATIONS), made of boxes, to be
 * changed in the designer: its frame x across from the track (0: the platform's edge, STATION_X m
 * from the track's middle), y up (0: a metre under the track bed), z along the platform (0 at one end).
 */
export const STATION_X = 1.25;
/** Where the track bed is in its frame (m up). */
export const STATION_BED = 1;

/** A design's voxels for boxes (m: x0, x1, y0, y1, z0, z1, a material; later ones over earlier): whole blocks where a block's all one, quarters else. */
export function voxelsOfBoxes(boxes: readonly [number, number, number, number, number, number, MaterialId][]): BlockVoxel[] {
  const Q = 4, B = BLOCK_SIZE, q = B / Q;
  // Each quarter cell's material (the last box over its middle).
  const cells = new Map<string, MaterialId>();
  for (const [x0, x1, y0, y1, z0, z1, m] of boxes)
    for (let x = Math.round(x0 * Q); x < Math.round(x1 * Q); x++)
      for (let y = Math.round(y0 * Q); y < Math.round(y1 * Q); y++) for (let z = Math.round(z0 * Q); z < Math.round(z1 * Q); z++) cells.set(`${x},${y},${z}`, m);
  // By block: one voxel, if it's all one material; else its quarters.
  const blocks = new Map<string, [number, number, number, MaterialId][]>();
  for (const [k, m] of cells) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    const bk = `${Math.floor(x / Q)},${Math.floor(y / Q)},${Math.floor(z / Q)}`;
    (blocks.get(bk) ?? blocks.set(bk, []).get(bk)!).push([x, y, z, m]);
  }
  const out: BlockVoxel[] = [];
  for (const [bk, list] of blocks) {
    const [bx, by, bz] = bk.split(',').map(Number) as [number, number, number];
    if (list.length === Q * Q * Q && list.every((c) => c[3] === list[0]![3])) out.push({ x: bx * B, y: by * B, z: bz * B, size: B, material: list[0]![3] });
    else for (const [x, y, z, m] of list) out.push({ x: x * q, y: y * q, z: z * q, size: q, material: m });
  }
  return out;
}

/** The station design as it comes: a stone platform (its edge picked out), a shelter at its middle (posts, a roof, a bench), a lamp. */
export function stationDesign(): ObjectDesign {
  const L = PLATFORM_M, mid = L / 2, top = STATION_BED + 1;
  const boxes: [number, number, number, number, number, number, MaterialId][] = [
    [0, 2.75, 0.5, top, 0, L, Material.Stone],
    [0, 0.25, top - 0.25, top, 0, L, Material.Sand],
    // The shelter: four posts, a roof over them, a bench under it.
    ...[0.5, 2.25].flatMap((x) => [mid - 3, mid + 2.75].map((z): [number, number, number, number, number, number, MaterialId] => [x, x + 0.25, top, top + 2.5, z, z + 0.25, Material.Wood])),
    [0, 3, top + 2.5, top + 2.75, mid - 3.5, mid + 3.5, Material.Planks],
    [0.5, 2.5, top + 2.75, top + 3, mid - 3.25, mid + 3.25, Material.DarkMetal],
    [1.75, 2.25, top + 0.5, top + 0.75, mid - 1.5, mid + 1.5, Material.Planks],
    [2.25, 2.5, top + 0.5, top + 1.25, mid - 1.5, mid + 1.5, Material.Planks],
    ...[mid - 1.25, mid + 1].map((z): [number, number, number, number, number, number, MaterialId] => [1.75, 2, top, top + 0.5, z, z + 0.25, Material.DarkMetal]),
    // A lamp, along the platform.
    [0.5, 0.75, top, top + 2.75, mid + 11, mid + 11.25, Material.DarkMetal],
    [0.5, 0.75, top + 2.75, top + 3, mid + 11, mid + 11.25, Material.LightMetal],
  ];
  return { id: 'railway-station', name: 'Railway station', size: [3, 5, L], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'railway-station' };
}
