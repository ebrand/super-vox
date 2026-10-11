import * as THREE from 'three';
import { BLOCK_SIZE, CHANNEL_WATER, Material, UNITS_PER_METER, aqueductWater, type Aqueduct } from '@super-vox/shared';
import { createPackedMesh, disposePackedMesh } from './meshFactory.js';
import { packQuads, type Quad } from './mesher.js';
import { WATER_LAYER } from './water.js';

/** Water drawn as one mesh a square this big at most (units: its positions, from its origin, must fit 16 bits: 4 km). */
const TILE = 2048 * UNITS_PER_METER;

/**
 * Aqueducts' water (see aqueducts.ts): drawn, not voxels, as the sea's surface is (the same water
 * material): standing CHANNEL_WATER over its channel's floor, a quarter metre at a time (as its
 * stone's built: along its runs' lines, see aqueductColumns), from its head as far as it runs (to
 * its first break); in its head's cistern always; in its outlet basin while it runs to its end.
 * Where its floor steps down, the water spills over the step (a face down it).
 */
export class AqueductView {
  readonly group = new THREE.Group();
  private key = '';

  constructor(private readonly material: THREE.Material) {}

  set(aqueducts: readonly Aqueduct[]): void {
    const key = aqueducts.map((a) => `${a.id}:${a.cells.length}:${a.runs}:${a.finished}:${a.legs?.length ?? 0}`).join(' ');
    if (key === this.key) return;
    this.key = key;
    for (const m of [...this.group.children]) disposePackedMesh(m);
    this.group.clear();
    for (const a of aqueducts) {
      const tiles = new Map<string, WaterColumn[]>();
      for (const c of aqueductWater(a)) {
        const k = `${Math.floor((c.qx * Q) / TILE)},${Math.floor((c.qz * Q) / TILE)}`;
        (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(c);
      }
      for (const cols of tiles.values()) {
        const mesh = waterMesh(cols, this.material, `aqueduct ${a.id} water`);
        if (mesh) this.group.add(mesh);
      }
    }
  }

  dispose(): void {
    for (const m of [...this.group.children]) disposePackedMesh(m);
    this.group.clear();
  }
}

/** A quarter-metre column of channel water (see aqueductWater). */
type WaterColumn = { qx: number; qz: number; floor: number };
const Q = BLOCK_SIZE / 4;

/** Water over channel columns, as one mesh (its origin their least corner, a block under the lowest floor). */
export function waterMesh(cols: readonly WaterColumn[], material: THREE.Material, name: string): THREE.Mesh | null {
  if (!cols.length) return null;
  const B = BLOCK_SIZE;
  let ox = Infinity, oz = Infinity, oy = Infinity;
  for (const c of cols) (ox = Math.min(ox, c.qx * Q)), (oz = Math.min(oz, c.qz * Q)), (oy = Math.min(oy, c.floor - B));
  const top = new Map(cols.map((c) => [`${c.qx},${c.qz}`, c.floor + CHANNEL_WATER]));
  const quads: Quad[] = [];
  // The surface (+y: its plane the height; u along z, v along x): along x, a strip at a time where it's level.
  const rows = new Map<number, WaterColumn[]>();
  for (const c of cols) (rows.get(c.qz) ?? rows.set(c.qz, []).get(c.qz)!).push(c);
  for (const [qz, row] of rows) {
    row.sort((a, b) => a.qx - b.qx);
    for (let i = 0; i < row.length; ) {
      let j = i + 1;
      while (j < row.length && row[j]!.qx === row[j - 1]!.qx + 1 && row[j]!.floor === row[i]!.floor) j++;
      quads.push({ dir: 2, plane: row[i]!.floor + CHANNEL_WATER - oy, u: qz * Q - oz, v: row[i]!.qx * Q - ox, du: Q, dv: (j - i) * Q, material: Material.Water, size: B });
      i = j;
    }
  }
  // Down each step to a lower neighbour: a face from its surface to theirs (+x, -x, +z, -z).
  for (const c of cols) {
    const x = c.qx * Q - ox, z = c.qz * Q - oz, h = c.floor + CHANNEL_WATER;
    for (const [dir, dx, dz] of [[0, 1, 0], [1, -1, 0], [4, 0, 1], [5, 0, -1]] as const) {
      const there = top.get(`${c.qx + dx},${c.qz + dz}`);
      if (there === undefined || there >= h) continue;
      const lo = there - oy, hi = h - oy;
      if (dir <= 1) quads.push({ dir, plane: dx > 0 ? x + Q : x, u: lo, v: z, du: hi - lo, dv: Q, material: Material.Water, size: B });
      else quads.push({ dir, plane: dz > 0 ? z + Q : z, u: x, v: lo, du: Q, dv: hi - lo, material: Material.Water, size: B });
    }
  }
  const mesh = createPackedMesh(packQuads(quads), { x: ox, y: oy, z: oz }, material, name);
  mesh.layers.set(WATER_LAYER);
  mesh.renderOrder = 4;
  return mesh;
}
