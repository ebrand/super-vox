import { BLOCK_SIZE } from './chunk.js';
import type { BlockVoxel } from './edit.js';
import { Item, type ItemId } from './items.js';
import { Material, type MaterialId } from './materials.js';

/**
 * Things players build that are more than a voxel: fences, gates and doors. Each is made of small
 * voxels of its own material (so a click on one can be recognised) inside one 1 m block (doors:
 * two, stacked), and the server keeps a register of where they are, which way they face and
 * whether they're open (see PlacedObject).
 */
export type ObjectKind = 'fence' | 'gate' | 'door';

/** Which way an object faces: the way the player looked when placing it (n = -Z). */
export type Facing = 'n' | 'e' | 's' | 'w';
export const FACINGS: readonly Facing[] = ['n', 'e', 's', 'w'];

export function isFacing(v: unknown): v is Facing {
  return typeof v === 'string' && (FACINGS as readonly string[]).includes(v);
}

/** Block offsets (x, z) of each facing. */
export const FACING_STEP: Record<Facing, readonly [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** A placed object; (x, y, z) is its (bottom) block, in 1 m block coordinates. */
export interface PlacedObject {
  kind: ObjectKind;
  x: number;
  y: number;
  z: number;
  facing: Facing;
  /** Gates and doors: open (fences: always false). */
  open: boolean;
}

export const OBJECT_ITEM: Record<ObjectKind, ItemId> = { fence: Item.Fence, gate: Item.Gate, door: Item.Door };
export const OBJECT_MATERIAL: Record<ObjectKind, MaterialId> = { fence: Material.FenceWood, gate: Material.GateWood, door: Material.DoorWood };

/** The object an item places, if it places one. */
export function objectKindOf(item: ItemId): ObjectKind | null {
  return item === Item.Fence ? 'fence' : item === Item.Gate ? 'gate' : item === Item.Door ? 'door' : null;
}

/** Whether a material belongs to a placed object (and so a click on it means the object). */
export function isObjectMaterial(m: MaterialId): boolean {
  return m === Material.FenceWood || m === Material.GateWood || m === Material.DoorWood;
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

/** Every block (offset from the object's bottom block) of an object with its voxels. */
export function objectBlocks(o: PlacedObject, fenceToward: readonly Facing[] = []): { dy: number; voxels: BlockVoxel[] }[] {
  if (o.kind === 'fence') return [{ dy: 0, voxels: fenceVoxels(fenceToward) }];
  if (o.kind === 'gate') return [{ dy: 0, voxels: gateVoxels(o.facing, o.open) }];
  const door = doorVoxels(o.facing, o.open);
  return [
    { dy: 0, voxels: door },
    { dy: 1, voxels: door },
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
