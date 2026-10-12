import * as THREE from 'three';
import { AQUEDUCT_FOOTING_M, AQUEDUCT_PIER_EVERY_M, BLOCK_SIZE, CHANNEL_WATER, CHUNK_SIZE, Material, UNITS_PER_METER, aqueductWater, type Aqueduct, type ChannelCell } from '@super-vox/shared';
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
  /** Its stone far off (see farMesh), a mesh a chunk column, by column: shown where the column isn't drawn as voxels. */
  private readonly far = new THREE.Group();
  private readonly farColumns = new Map<string, { cx: number; cz: number; mesh: THREE.Mesh }>();

  /** `material`: its water's; `stone`: the ground's, for its stone far off (none: not drawn far off). */
  constructor(
    private readonly material: THREE.Material,
    private readonly stone: THREE.Material | null = null,
  ) {
    this.group.add(this.far);
  }

  set(aqueducts: readonly Aqueduct[]): void {
    const key = aqueducts.map((a) => `${a.id}:${a.cells.length}:${a.runs}:${a.finished}:${a.legs?.length ?? 0}:${a.ground?.length ?? 0}`).join(' ');
    if (key === this.key) return;
    this.key = key;
    for (const m of [...this.group.children]) if (m !== this.far) disposePackedMesh(m);
    this.group.clear();
    this.group.add(this.far);
    for (const { mesh } of this.farColumns.values()) disposePackedMesh(mesh);
    this.far.clear();
    this.farColumns.clear();
    if (this.stone) for (const a of aqueducts) this.addFar(a, this.stone);
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

  /**
   * Its stone far off shown where the ground's not drawn as voxel chunks there (`drawn`: whether
   * chunk column (cx, cz) is, as the chunks are kept: on a round world, `shift` columns over from
   * where it is in the world, the copy we're in).
   */
  showFar(drawn: (cx: number, cz: number) => boolean, shift = 0): void {
    for (const c of this.farColumns.values()) c.mesh.visible = !drawn(c.cx + shift, c.cz);
  }

  /** An aqueduct's stone far off, a mesh for each chunk column it's in (see farMesh). */
  private addFar(a: Aqueduct, material: THREE.Material): void {
    if (!a.ground || a.ground.length !== a.cells.length) return;
    const B = BLOCK_SIZE, M = UNITS_PER_METER, P = CHUNK_SIZE / B;
    // How far along each cell is (m): for where its piers go.
    const along: number[] = [];
    a.cells.forEach((c, i) => along.push(i ? along[i - 1]! + Math.hypot(c.bx - a.cells[i - 1]!.bx, c.bz - a.cells[i - 1]!.bz) * (B / M) : 0));
    const byColumn = new Map<string, number[]>();
    a.cells.forEach((c, i) => {
      const k = `${Math.floor(c.bx / P)},${Math.floor(c.bz / P)}`;
      (byColumn.get(k) ?? byColumn.set(k, []).get(k)!).push(i);
    });
    for (const [k, idx] of byColumn) {
      const mesh = farMesh(idx.map((i) => ({ cell: a.cells[i]!, ground: a.ground![i]!, along: along[i]! })), material, `aqueduct ${a.id} far ${k}`);
      if (!mesh) continue;
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      const key = `${a.id} ${k}`;
      this.farColumns.set(key, { cx, cz, mesh });
      this.far.add(mesh);
    }
  }

  dispose(): void {
    for (const m of [...this.group.children]) if (m !== this.far) disposePackedMesh(m);
    for (const { mesh } of this.farColumns.values()) disposePackedMesh(mesh);
    this.farColumns.clear();
    this.far.clear();
    this.group.clear();
  }
}

/**
 * An aqueduct's stone as seen far off (where its chunks aren't drawn as voxels, only the land's low
 * detail, which has nothing built in it): over each cell a body 2 m across (its floor and walls, to
 * under its water: that's drawn on it), and under it, down to the ground, a solid footing where it's
 * low; else piers every AQUEDUCT_PIER_EVERY_M and a band under the body (its arches' tops). Boxes,
 * of the ground's own material (lit and faded as it is).
 */
export function farMesh(cells: readonly { cell: ChannelCell; ground: number; along: number }[], material: THREE.Material, name: string): THREE.Mesh | null {
  if (!cells.length) return null;
  const B = BLOCK_SIZE, M = UNITS_PER_METER, SLAB = B / 2, BAND = B;
  let ox = Infinity, oz = Infinity, oy = Infinity;
  for (const { cell, ground } of cells) (ox = Math.min(ox, cell.bx * B - B)), (oz = Math.min(oz, cell.bz * B - B)), (oy = Math.min(oy, Math.min(ground, cell.floor) - 2 * B));
  const quads: Quad[] = [];
  /** A box (units, from the mesh's origin) of `m`: its six faces. */
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number, top = m) => {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    const f = (q: Omit<Quad, 'material' | 'size'>, mat: number) => quads.push({ ...q, material: mat, size: B });
    f({ dir: 0, plane: x1, u: y0, v: z0, du: y1 - y0, dv: z1 - z0 }, m);
    f({ dir: 1, plane: x0, u: y0, v: z0, du: y1 - y0, dv: z1 - z0 }, m);
    f({ dir: 2, plane: y1, u: z0, v: x0, du: z1 - z0, dv: x1 - x0 }, top);
    f({ dir: 3, plane: y0, u: z0, v: x0, du: z1 - z0, dv: x1 - x0 }, m);
    f({ dir: 4, plane: z1, u: x0, v: y0, du: x1 - x0, dv: y1 - y0 }, m);
    f({ dir: 5, plane: z0, u: x0, v: y0, du: x1 - x0, dv: y1 - y0 }, m);
  };
  for (const { cell, ground, along } of cells) {
    const x0 = cell.bx * B - B / 2 - ox, z0 = cell.bz * B - B / 2 - oz, x1 = x0 + 2 * B, z1 = z0 + 2 * B;
    const under = cell.floor - SLAB, top = cell.floor + CHANNEL_WATER / 2;
    box(x0, under - oy, z0, x1, top - oy, z1, Material.Cobblestone, Material.Stone);
    const high = under - ground;
    if (high <= 0) continue;
    if (high <= AQUEDUCT_FOOTING_M * M) box(x0, ground - oy, z0, x1, under - oy, z1, Material.Cobblestone);
    else {
      // (A pier where one falls in this cell; the band under the body everywhere.)
      const P = AQUEDUCT_PIER_EVERY_M, step = B / M;
      if (Math.floor((along + step) / P) > Math.floor(along / P) || along === 0) box(x0, ground - oy, z0, x1, under - oy, z1, Material.Cobblestone);
      else box(x0, Math.max(ground, under - BAND) - oy, z0, x1, under - oy, z1, Material.Stone);
    }
  }
  const mesh = createPackedMesh(packQuads(quads), { x: ox, y: oy, z: oz }, material, name);
  return mesh;
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
