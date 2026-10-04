import { BLOCK_SIZE } from './chunk.js';
import type { BlockVoxel } from './edit.js';
import { designBlocks, designById, designItem, designSpan, type DesignRole } from './designs.js';
import { Item, type ItemId } from './items.js';
import { Material, type MaterialId } from './materials.js';

/**
 * Things players build that are more than a voxel: fences, gates, doors and crafting tables. Each
 * is made of small voxels of its own material (so a click on one can be recognised) inside one 1 m
 * block (doors: two, stacked), and the server keeps a register of where they are, which way they
 * face and whether they're open (see PlacedObject).
 */
export type ObjectKind = 'fence' | 'gate' | 'door' | 'table' | 'torch';

/** Which way an object faces: the way the player looked when placing it (n = -Z). */
export type Facing = 'n' | 'e' | 's' | 'w';
export const FACINGS: readonly Facing[] = ['n', 'e', 's', 'w'];

export function isFacing(v: unknown): v is Facing {
  return typeof v === 'string' && (FACINGS as readonly string[]).includes(v);
}

/** Block offsets (x, z) of each facing. */
export const FACING_STEP: Record<Facing, readonly [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** What a placed object is: a built-in kind, or a design (see designs.ts). */
export type PlacedKind = ObjectKind | 'design';

/**
 * A placed object; (x, y, z) is its (bottom) block, in 1 m block coordinates (a design: the least
 * corner of its box).
 */
export interface PlacedObject {
  kind: PlacedKind;
  x: number;
  y: number;
  z: number;
  facing: Facing;
  /** Gates and doors: open (fences: always false). */
  open: boolean;
  /** A torch: on a wall (the side `facing` is toward), not standing on the floor. */
  wall?: boolean;
  /** A design: its id. */
  design?: string;
  /** A design: which of its states it's in. */
  state?: number;
  /** A design: the blocks its box takes along x, y and z (as placed: turned; kept, should the design change). A torch: [1, 2, 1] when it reaches into the block above. */
  span?: [number, number, number];
}

/** The blocks an object takes, as offsets from (x, y, z). */
export function objectCells(o: PlacedObject): [number, number, number][] {
  // (A torch reaching up into the block above takes it too: see fitTorch.)
  const [w, h, d] = o.span ?? (o.kind === 'design' ? [1, 1, 1] : [1, objectHeight(o.kind), 1]);
  const out: [number, number, number][] = [];
  for (let dy = 0; dy < h; dy++) for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) out.push([dx, dy, dz]);
  return out;
}

/** The item taking an object down gives back (null: a design no longer in the library). */
export function objectItem(o: PlacedObject): ItemId | null {
  if (o.kind !== 'design') return OBJECT_ITEM[o.kind];
  const design = designById(o.design ?? '');
  return design ? designItem(design) : null;
}

/** The station an object is, if any: the built-in table, or a design standing in for one. */
export function objectStation(o: PlacedObject): DesignRole | null {
  if (o.kind === 'table') return 'crafting-table';
  return o.kind === 'design' ? (designById(o.design ?? '')?.role ?? null) : null;
}

/** Whether an object is a bed (the design standing in for one): right-clicked, it's where you come back to. */
export function isBed(o: PlacedObject): boolean {
  return objectStation(o) === 'bed';
}

/**
 * Whether any of `objects` that's station `role` takes a block within `reach` (units, Chebyshev,
 * by block, as materialNearIn) of (x, y, z) (units). `wrapBlocks`: round worlds, blocks around.
 */
export function stationAmong(objects: Iterable<PlacedObject>, role: DesignRole, x: number, y: number, z: number, reach: number, wrapBlocks: number | null = null): boolean {
  const lo = (v: number) => Math.floor((v - reach) / BLOCK_SIZE), hi = (v: number) => Math.floor((v + reach) / BLOCK_SIZE);
  const px = Math.floor(x / BLOCK_SIZE), r = hi(x) - px;
  for (const o of objects) {
    if (objectStation(o) !== role) continue;
    for (const [dx, dy, dz] of objectCells(o)) {
      let ddx = o.x + dx - px;
      if (wrapBlocks) ddx = ((((ddx % wrapBlocks) + wrapBlocks + Math.floor(wrapBlocks / 2)) % wrapBlocks) - Math.floor(wrapBlocks / 2));
      const by = o.y + dy, bz = o.z + dz;
      if (ddx >= lo(x) - px && ddx <= r && by >= lo(y) && by <= hi(y) && bz >= lo(z) && bz <= hi(z)) return true;
    }
  }
  return false;
}

/** What an object is called. */
export function objectName(o: PlacedObject): string {
  return o.kind === 'design' ? (designById(o.design ?? '')?.name ?? 'object') : o.kind === 'table' ? 'crafting table' : o.kind;
}

export const OBJECT_ITEM: Record<ObjectKind, ItemId> = { fence: Item.Fence, gate: Item.Gate, door: Item.Door, table: Item.CraftingTable, torch: Item.Torch };
export const OBJECT_MATERIAL: Record<ObjectKind, MaterialId> = { fence: Material.FenceWood, gate: Material.GateWood, door: Material.DoorWood, table: Material.CraftingTable, torch: Material.TorchWood };

/** The object an item places, if it places one. */
export function objectKindOf(item: ItemId): ObjectKind | null {
  return item === Item.Fence ? 'fence' : item === Item.Gate ? 'gate' : item === Item.Door ? 'door' : item === Item.CraftingTable ? 'table' : item === Item.Torch ? 'torch' : null;
}

/**
 * Whether a material belongs to a placed object (and so a click on it means the object). (Crafting
 * tables placed as solid blocks, before they were objects, are of the same material: a click on one
 * finds no object there, and mines it as a block.)
 */
export function isObjectMaterial(m: MaterialId): boolean {
  return m === Material.FenceWood || m === Material.GateWood || m === Material.DoorWood || m === Material.CraftingTable || m === Material.DarkMetal || m === Material.LightMetal || m === Material.TorchWood || m === Material.TorchFlame;
}

/** Whether an object opens and closes (gates and doors). */
export function opens(kind: PlacedKind): boolean {
  return kind === 'gate' || kind === 'door';
}

/** Whether a right-click changes an object: gates and doors open and shut; designs with more than one state step to the next. */
export function usable(o: PlacedObject): boolean {
  return opens(o.kind) || (o.kind === 'design' && (designById(o.design ?? '')?.states.length ?? 0) > 1);
}

/** Whether right-clicking an object's voxel opens or closes it. */
export function isUsableMaterial(m: MaterialId): boolean {
  return m === Material.GateWood || m === Material.DoorWood;
}

/** Blocks an object occupies, as offsets from its (bottom) block: doors are two blocks tall. */
export function objectHeight(kind: ObjectKind): number {
  return kind === 'door' ? 2 : 1;
}

const S = BLOCK_SIZE;

/** Voxels of `size` tiling the box [x0, x1) x [y0, y1) x [z0, z1) (each extent a multiple of size). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, size: number, material: MaterialId): BlockVoxel[] {
  const out: BlockVoxel[] = [];
  for (let y = y0; y < y1; y += size) for (let z = z0; z < z1; z += size) for (let x = x0; x < x1; x += size) out.push({ x, y, z, size, material });
  return out;
}

/** Turns block-local voxels a quarter turn clockwise (seen from above), `times` times. */
function turn(voxels: BlockVoxel[], times: number): BlockVoxel[] {
  let out = voxels;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) out = out.map((v) => ({ ...v, x: S - v.z - v.size, z: v.x }));
  return out;
}

const TURNS: Record<Facing, number> = { n: 0, e: 1, s: 2, w: 3 };

/** Rail heights (units from the block's bottom) of fences and gates. */
const RAILS = [4, 11];

/**
 * A fence: a 1/4 m post, and two rails toward each side in `toward` (neighbouring fences and
 * gates; see fenceJoins).
 */
export function fenceVoxels(toward: readonly Facing[]): BlockVoxel[] {
  const m = Material.FenceWood;
  const post = box(6, 0, 6, 10, 16, 10, 4, m);
  // Rails to the north (-Z), turned for the other sides.
  const north = RAILS.flatMap((y) => box(7, y, 0, 9, y + 2, 6, 2, m));
  return [...post, ...toward.flatMap((f) => turn(north, TURNS[f]))];
}

/**
 * A gate across its block (closed: rails and end stiles spanning it, across the way it faces;
 * open: swung back against its left side, as seen when placing it).
 */
export function gateVoxels(facing: Facing, open: boolean): BlockVoxel[] {
  const m = Material.GateWood;
  // Facing north: spanning x, in the middle of the block.
  // (Rails run between the stiles: voxels mustn't overlap.)
  const closed = [...RAILS.flatMap((y) => box(2, y, 7, 14, y + 2, 9, 2, m)), ...box(0, 2, 7, 2, 16, 9, 2, m), ...box(14, 2, 7, 16, 16, 9, 2, m)];
  // Swung on its west end: along z, against the west side, the hinge stile at the south end.
  const swung = [...RAILS.flatMap((y) => box(0, y, 0, 2, y + 2, 14, 2, m)), ...box(0, 2, 14, 2, 16, 16, 2, m)];
  return turn(open ? swung : closed, TURNS[facing]);
}

/**
 * One block of a door (`upper`: the top one): a 1/8 m panel on the near edge of its block as the
 * placer saw it (closed), or swung against its left side (open).
 */
export function doorVoxels(facing: Facing, open: boolean): BlockVoxel[] {
  const m = Material.DoorWood;
  // Facing north (looked at from the south): the panel on the south edge; open, against the west side.
  const panel = open ? box(0, 0, 0, 2, 16, 16, 2, m) : box(0, 0, 14, 16, 16, 16, 2, m);
  return turn(panel, TURNS[facing]);
}

/**
 * A crafting table: a workbench a 1 m block across, of voxels its size wants (1/16 m and 1/8 m): a
 * 1/8 m top on four 1/8 m legs (inset), 1/16 m stretchers between the legs, and on the top, a
 * claw hammer (a dark metal head on a wooden handle) and a light metal carpenter's square, turned
 * to face the way the placer looked.
 */
export function tableVoxels(facing: Facing): BlockVoxel[] {
  const m = Material.CraftingTable;
  const top = box(0, 12, 0, 16, 14, 16, 2, m);
  const legs = [2, 12].flatMap((x) => [2, 12].flatMap((z) => box(x, 0, z, x + 2, 12, z + 2, 2, m)));
  // Stretchers: along x (front and back) low, along z (the sides) a little higher, so they don't meet.
  const stretchers = [...box(4, 3, 2, 12, 4, 3, 1, m), ...box(4, 3, 13, 12, 4, 14, 1, m), ...box(2, 5, 4, 3, 6, 12, 1, m), ...box(13, 5, 4, 14, 6, 12, 1, m)];
  // On the top (looked at from the south, facing north): a hammer to the right (its handle along x,
  // its head across it: the face end standing up, the claw lying down), a square to the left.
  const hammer = [...box(5, 14, 5, 11, 15, 6, 1, m), ...box(11, 14, 4, 12, 16, 7, 1, Material.DarkMetal), ...box(11, 14, 2, 12, 15, 4, 1, Material.DarkMetal)];
  const square = [...box(3, 14, 11, 9, 15, 12, 1, Material.LightMetal), ...box(3, 14, 8, 4, 15, 11, 1, Material.LightMetal)];
  return [...top, ...legs, ...stretchers, ...turn([...hammer, ...square], TURNS[facing])];
}

/**
 * A torch: a 1/8 m stick with its flame on top, standing in the middle of its block, or on a wall
 * (the side `facing` is toward), leaning out from it.
 */
export function torchVoxels(facing: Facing, wall: boolean): BlockVoxel[] {
  const stick = Material.TorchWood, flame = Material.TorchFlame;
  if (!wall) return [...box(7, 0, 7, 9, 8, 9, 2, stick), ...box(7, 8, 7, 9, 12, 9, 2, flame)];
  // On the north wall (-Z): from against it, up and out.
  return turn([...box(7, 4, 0, 9, 8, 2, 2, stick), ...box(7, 8, 2, 9, 10, 4, 2, stick), ...box(7, 10, 2, 9, 14, 4, 2, flame)], TURNS[facing]);
}

/** Whether a voxel is part of a torch. */
export function isTorchVoxel(v: BlockVoxel): boolean {
  return v.material === Material.TorchWood || v.material === Material.TorchFlame;
}

/**
 * A torch's voxels in a block already holding `ground` (voxels: the ground's surface, say), and
 * the block above holding `above`: a standing one on top of what's under it there (reaching up
 * into the block above if it must; `upper`, in that block's own coordinates), a wall one where it
 * goes. Null if it doesn't fit (it would overlap something).
 */
export function fitTorch(ground: readonly BlockVoxel[], above: readonly BlockVoxel[], facing: Facing, wall: boolean): { lower: BlockVoxel[]; upper: BlockVoxel[] } | null {
  let torch = torchVoxels(facing, wall);
  if (!wall) {
    // Standing on the highest of the ground under its stick (rounded up to its voxels' size, so
    // none of them is cut by the top of the block).
    let lift = 0;
    for (const v of ground) if (v.x < 9 && v.x + v.size > 7 && v.z < 9 && v.z + v.size > 7) lift = Math.max(lift, v.y + v.size);
    lift = Math.ceil(lift / 2) * 2;
    torch = torch.map((v) => ({ ...v, y: v.y + lift }));
  }
  const lower = torch.filter((v) => v.y < S), upper = torch.filter((v) => v.y >= S).map((v) => ({ ...v, y: v.y - S }));
  const overlaps = (a: readonly BlockVoxel[], b: readonly BlockVoxel[]) =>
    a.some((p) => b.some((q) => p.x < q.x + q.size && q.x < p.x + p.size && p.y < q.y + q.size && q.y < p.y + p.size && p.z < q.z + q.size && q.z < p.z + p.size));
  if (overlaps(lower, ground) || overlaps(upper, above)) return null;
  return { lower, upper };
}

/**
 * Every block (offset from the object's (x, y, z)) of an object with its voxels. A design no longer
 * in the library, or changed to another size: none (it can't be redrawn).
 */
export function objectBlocks(o: PlacedObject, fenceToward: readonly Facing[] = []): { dx: number; dy: number; dz: number; voxels: BlockVoxel[] }[] {
  if (o.kind === 'design') {
    const design = designById(o.design ?? '');
    if (!design || designSpan(design, o.facing).join() !== (o.span ?? []).join()) return [];
    return designBlocks(design, o.state ?? 0, o.facing);
  }
  if (o.kind === 'fence') return [{ dx: 0, dy: 0, dz: 0, voxels: fenceVoxels(fenceToward) }];
  if (o.kind === 'table') return [{ dx: 0, dy: 0, dz: 0, voxels: tableVoxels(o.facing) }];
  if (o.kind === 'torch') return [{ dx: 0, dy: 0, dz: 0, voxels: torchVoxels(o.facing, !!o.wall) }];
  if (o.kind === 'gate') return [{ dx: 0, dy: 0, dz: 0, voxels: gateVoxels(o.facing, o.open) }];
  const door = doorVoxels(o.facing, o.open);
  return [
    { dx: 0, dy: 0, dz: 0, voxels: door },
    { dx: 0, dy: 1, dz: 0, voxels: door },
  ];
}

/** The axis (x or z) a gate spans when closed. */
function gateSpan(facing: Facing): 'x' | 'z' {
  return facing === 'n' || facing === 's' ? 'x' : 'z';
}

/**
 * Sides a fence at (x, y, z) joins: toward neighbouring fences, and toward gates that span the
 * line between them. `objectAt` gives the object in a block, if any.
 */
export function fenceJoins(x: number, y: number, z: number, objectAt: (x: number, y: number, z: number) => PlacedObject | undefined): Facing[] {
  return FACINGS.filter((f) => {
    const [dx, dz] = FACING_STEP[f];
    const o = objectAt(x + dx, y, z + dz);
    if (!o) return false;
    if (o.kind === 'fence') return true;
    return o.kind === 'gate' && gateSpan(o.facing) === (dx !== 0 ? 'x' : 'z');
  });
}

/** The facing nearest a yaw (radians, 0 = looking north = -Z, increasing counter-clockwise). */
export function facingOfYaw(yaw: number): Facing {
  const bearing = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;
  return FACINGS[Math.round(bearing / 90) % 4]!;
}
