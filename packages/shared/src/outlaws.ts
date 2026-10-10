import { BLOCK_SIZE } from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import type { VillagePiece } from './villages.js';
import type { ObjectDesign } from './designs.js';

/**
 * Outlaws: people of the wild, who drift about alone until a couple of them meet, and set up a camp
 * (a fire pit, then a lean-to) on open land away from villages and trading posts. A camp takes in
 * loners to CAMP_MAX; its outlaws keep about it, now and then going off together (a band) and back.
 * Near players they're creatures (see mobs.ts: 'outlaw'): they fight players and villagers they
 * see, with swords, one in a band with a bow. Killed, they drop coins (and sometimes their weapon).
 */

/** How many meeting (within OUTLAW_MEET_M of each other) set up a camp; the most a camp holds. */
export const OUTLAW_FOUNDERS = 2;
export const OUTLAW_MEET_M = 30;
export const CAMP_MAX = 4;
/** Camps this far (m) from villages, trading posts and each other at least; loners this near one with room join it. */
export const CAMP_APART_M = 400;
export const CAMP_JOIN_M = 300;
/** An outlaw's a creature (see MobManager) once a player's this near (m); back to a record further than OUTLAW_FAR_M. */
export const OUTLAW_NEAR_M = 120;
export const OUTLAW_FAR_M = 160;

export interface Outlaw {
  id: number;
  name: string;
  look: string;
  /** Where (units: x, z; y their feet). */
  x: number;
  y: number;
  z: number;
  health: number;
  /** Their camp (none: a loner); whether they've a bow (else a sword). */
  camp: number | null;
  archer: boolean;
}

export interface Camp {
  id: number;
  name: string;
  /** Its fire (units: x, z; y the ground there). */
  x: number;
  y: number;
  z: number;
  /** Built so far: 0 nothing, 1 the fire pit, 2 the lean-to too. When it was set up (ms). */
  stage: number;
  founded: number;
  /** Where its band's off to (units), and till when (ms); none, at home. */
  roam: { x: number; z: number; until: number } | null;
}

const OUTLAW_NAMES = ['Black Tom', 'Red Moll', 'Crooked Will', 'One-Eye Jack', 'Silent Kate', 'Mad Ned', 'Dirk', 'Grim Hal', 'Ragged Bess', 'Wolf', 'Scar', 'Long Peg', 'Ashen Rob', 'Nettle', 'Crow', 'Thorn'];
const CAMP_NAMES = ['Gallows Hollow', 'Crowsnest', 'Blackthorn Camp', 'Wolfsden', 'Cutthroat Ridge', 'Smoke Hollow', 'Rookery', 'Badger Holt'];

export const outlawName = (i: number) => OUTLAW_NAMES[i % OUTLAW_NAMES.length]! + (i >= OUTLAW_NAMES.length ? ` ${Math.floor(i / OUTLAW_NAMES.length) + 1}` : '');
export const campName = (i: number) => CAMP_NAMES[i % CAMP_NAMES.length]! + (i >= CAMP_NAMES.length ? ` ${Math.floor(i / CAMP_NAMES.length) + 1}` : '');

/**
 * What a camp's stage puts in the world (its fire at block cx, cz; `ground`: the ground's top at a
 * column, block y). 1: a fire pit (coal in a ring of cobblestone, flames on it: alight, as a torch
 * is); 2: a lean-to beside it (wooden posts, a sloping roof of planks, open on the fire's side).
 */
export function campStage(cx: number, cz: number, stage: number, ground: (bx: number, bz: number) => number, design?: ObjectDesign): { clear: VillagePiece[]; place: VillagePiece[] } {
  if (design && (stage === 1 || stage === 2)) return designStage(cx, cz, stage, ground, design);
  const B = BLOCK_SIZE, clear: VillagePiece[] = [], place: VillagePiece[] = [];
  const at = (bx: number, by: number, bz: number, material: MaterialId, size = B, ox = 0, oy = 0, oz = 0) =>
    (material === Material.Air ? clear : place).push({ x: bx * B + ox, y: by * B + oy, z: bz * B + oz, size, material });
  if (stage === 1) {
    const top = ground(cx, cz);
    // Cleared round it first (what's growing there), then the pit: its middle sunk a block.
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) for (let y = ground(x, z); y < ground(x, z) + 4; y++) at(x, y, z, Material.Air);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++) {
        if (x === cx && z === cz) continue;
        at(x, ground(x, z), z, Material.Cobblestone);
      }
    at(cx, top - 1, cz, Material.Air);
    at(cx, top - 1, cz, Material.Coal);
    // (Flames: four quarter voxels on the coal, and one over them.)
    const q = B / 4;
    for (const [ox, oz] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) at(cx, top, cz, Material.TorchFlame, q, ox * q, 0, oz * q);
    at(cx, top, cz, Material.TorchFlame, q, 1.5 * q, q, 1.5 * q);
  } else if (stage === 2) {
    // East of the fire: 3 wide (z), 2 deep (x), its back 2 high, its front 3 (posts), a roof sloping back.
    const x0 = cx + 2, x1 = cx + 3, h = Math.max(ground(x0, cz), ground(x1, cz));
    for (let x = x0; x <= x1; x++) for (let z = cz - 1; z <= cz + 1; z++) for (let y = ground(x, z); y < h + 4; y++) at(x, y, z, Material.Air);
    for (const z of [cz - 1, cz + 1]) {
      for (let y = ground(x0, z); y < h + 3; y++) at(x0, y, z, Material.Wood);
      for (let y = ground(x1, z); y < h + 2; y++) at(x1, y, z, Material.Wood);
    }
    for (let z = cz - 1; z <= cz + 1; z++) {
      at(x0, h + 3, z, Material.Planks);
      at(x1, h + 2, z, Material.Planks);
      at(x1 + 1, h + 1, z, Material.Planks);
    }
  }
  return { clear, place };
}

/**
 * A camp's stage built of a design (the campfire's for stage 1, the lean-to's for 2: see campDesigns.ts
 * for their frames): its site cleared over the ground (and round it, a block), the blocks its voxels
 * go into cleared too, then its voxels (its first state's) put in.
 */
function designStage(cx: number, cz: number, stage: number, ground: (bx: number, bz: number) => number, design: ObjectDesign): { clear: VillagePiece[]; place: VillagePiece[] } {
  const B = BLOCK_SIZE, [sx, sy, sz] = design.size;
  const x0 = stage === 1 ? cx - Math.floor(sx / 2) : cx + 2, z0 = cz - Math.floor(sz / 2);
  const y0 = (stage === 1 ? ground(cx, cz) : ground(x0, cz)) - 1;
  const clear: VillagePiece[] = [], place: VillagePiece[] = [], cleared = new Set<string>();
  const air = (bx: number, by: number, bz: number) => {
    const k = `${bx},${by},${bz}`;
    if (cleared.has(k)) return;
    cleared.add(k);
    clear.push({ x: bx * B, y: by * B, z: bz * B, size: B, material: Material.Air });
  };
  for (let x = x0 - 1; x <= x0 + sx; x++) for (let z = z0 - 1; z <= z0 + sz; z++) for (let y = ground(x, z); y < Math.max(ground(x, z), y0 + 1) + sy + 1; y++) air(x, y, z);
  for (const v of design.states[0]?.voxels ?? []) {
    const wx = x0 * B + v.x, wy = y0 * B + v.y, wz = z0 * B + v.z;
    air(Math.floor(wx / B), Math.floor(wy / B), Math.floor(wz / B));
    place.push({ x: wx, y: wy, z: wz, size: v.size, material: v.material });
  }
  return { clear, place };
}
