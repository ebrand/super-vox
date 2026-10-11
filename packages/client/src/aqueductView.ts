import * as THREE from 'three';
import { BLOCK_SIZE, CHANNEL_WATER, Material, running, type Aqueduct, type ChannelCell } from '@super-vox/shared';
import { createPackedMesh, disposePackedMesh } from './meshFactory.js';
import { packQuads, type Quad } from './mesher.js';
import { WATER_LAYER } from './water.js';

/** Most cells drawn as one mesh (its positions, from its origin, must fit 16 bits: 4 km). */
const CELLS_A_MESH = 2000;

/**
 * Aqueducts' water (see aqueducts.ts): drawn, not voxels, as the sea's surface is (the same water
 * material): standing CHANNEL_WATER over each channel cell's floor, from its head as far as it
 * runs (to its first break); in its head's cistern always; in its outlet basin while it runs to its
 * end. Where its floor steps down, the water spills over the step (a face down it).
 */
export class AqueductView {
  readonly group = new THREE.Group();
  private key = '';

  constructor(private readonly material: THREE.Material) {}

  set(aqueducts: readonly Aqueduct[]): void {
    const key = aqueducts.map((a) => `${a.id}:${a.cells.length}:${a.runs}:${a.finished}`).join(' ');
    if (key === this.key) return;
    this.key = key;
    for (const m of [...this.group.children]) disposePackedMesh(m);
    this.group.clear();
    for (const a of aqueducts) {
      const wet = [...a.head, ...a.cells.slice(0, a.runs), ...(running(a) ? a.outlet : [])];
      for (let i = 0; i < wet.length; i += CELLS_A_MESH) {
        const mesh = waterMesh(wet.slice(i, i + CELLS_A_MESH), this.material, `aqueduct ${a.id} water`);
        if (mesh) this.group.add(mesh);
      }
    }
  }

  dispose(): void {
    for (const m of [...this.group.children]) disposePackedMesh(m);
    this.group.clear();
  }
}

/** Water over channel cells, as one mesh (its origin their least corner, a block under the lowest floor). */
export function waterMesh(cells: readonly ChannelCell[], material: THREE.Material, name: string): THREE.Mesh | null {
  if (!cells.length) return null;
  const B = BLOCK_SIZE;
  const ox = Math.min(...cells.map((c) => c.bx)) * B, oz = Math.min(...cells.map((c) => c.bz)) * B, oy = Math.min(...cells.map((c) => c.floor)) - B;
  const top = new Map(cells.map((c) => [`${c.bx},${c.bz}`, c.floor + CHANNEL_WATER]));
  const quads: Quad[] = [];
  for (const c of cells) {
    const x = c.bx * B - ox, z = c.bz * B - oz, h = c.floor + CHANNEL_WATER;
    // The surface (+y: its plane the height; u along z, v along x).
    quads.push({ dir: 2, plane: h - oy, u: z, v: x, du: B, dv: B, material: Material.Water, size: B });
    // Down each step to a lower neighbour: a face from its surface to theirs (+x, -x, +z, -z).
    for (const [dir, dx, dz] of [[0, 1, 0], [1, -1, 0], [4, 0, 1], [5, 0, -1]] as const) {
      const there = top.get(`${c.bx + dx},${c.bz + dz}`);
      if (there === undefined || there >= h) continue;
      const lo = there - oy, hi = h - oy;
      if (dir <= 1) quads.push({ dir, plane: dx > 0 ? x + B : x, u: lo, v: z, du: hi - lo, dv: B, material: Material.Water, size: B });
      else quads.push({ dir, plane: dz > 0 ? z + B : z, u: x, v: lo, du: B, dv: hi - lo, material: Material.Water, size: B });
    }
  }
  const mesh = createPackedMesh(packQuads(quads), { x: ox, y: oy, z: oz }, material, name);
  mesh.layers.set(WATER_LAYER);
  mesh.renderOrder = 4;
  return mesh;
}
