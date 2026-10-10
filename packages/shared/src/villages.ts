import { BLOCK_SIZE } from './chunk.js';
import { Material, type MaterialId } from './materials.js';

/**
 * Villages: people (villagers) who wander the world in ones and twos, drift toward each other, and
 * where a few meet on open, flat land, found a hamlet: cottages built in stages (a footing and
 * floor, walls, a thatched roof: written into the world as blocks), a field by each (tilled ground,
 * wheat growing on it in stages: kept as when each block was sown, not as blocks), harvested and
 * sown again by the villagers. Hamlets grow as wanderers join them. Theirs is theirs: protected.
 */

/** How fast villagers walk (m/s), how near wanderers drift to each other (m), and how many meeting found a hamlet, within how far of each other (m). */
export const VILLAGER_SPEED = 1.2;
export const DRIFT_M = 1200;
export const FOUNDERS = 3;
export const FOUND_M = 40;
/** A hamlet's land: this far (m) round its middle; wanderers this near join it, if it has room; the most cottages it builds, two to a cottage. */
export const VILLAGE_RADIUS_M = 32;
export const JOIN_VILLAGE_M = 400;
export const MAX_COTTAGES = 6;
export const PER_COTTAGE = 2;
/** A cottage's stages (footing, walls, roof) take this long each (s, someone working at it). */
export const STAGE_S = 90;
/** Wheat grows a stage in this long (ms): sown (0), shoots (1), green (2), ripe (3). */
export const CROP_STAGE_MS = 4 * 60_000;
export const RIPE = 3;

export interface Villager {
  id: number;
  name: string;
  look: string;
  /** Where (units: x, z; y their feet), and which way they face. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The hamlet they live in, if they've found one. */
  home: number | null;
}

/** A cottage: its footprint's least corner (blocks), how wide (x) and deep (z), its floor's top (block y), the side its door's on (0 -z, 1 +x, 2 +z, 3 -x), how far it's built (0..3: footing, walls, roof) and the work done on the next stage (s). */
export interface Cottage {
  bx: number;
  bz: number;
  w: number;
  d: number;
  floor: number;
  door: 0 | 1 | 2 | 3;
  stage: number;
  work: number;
}

/** A field: its least corner (blocks), how wide and deep, its ground's top (block y) each block (row by row), and when each block was sown (ms; 0: not), whether tilled yet. */
export interface Field {
  bx: number;
  bz: number;
  w: number;
  d: number;
  tops: number[];
  sown: number[];
  tilled: boolean;
}

export interface Village {
  id: number;
  name: string;
  /** Its middle (units: x, z; y the ground), and when it was founded (ms). */
  x: number;
  y: number;
  z: number;
  founded: number;
  cottages: Cottage[];
  fields: Field[];
  /** Wheat harvested (bundles: its prosperity). */
  wheat: number;
}

/** A field's block's wheat: its stage (see CROP_STAGE_MS), or -1 if nothing's sown there. */
export function cropStage(sown: number, now: number): number {
  return sown ? Math.max(0, Math.min(RIPE, Math.floor((now - sown) / CROP_STAGE_MS))) : -1;
}

/** A piece of a building (units: its least corner, its size), of a material (air: cleared). */
export interface VillagePiece {
  x: number;
  y: number;
  z: number;
  size: number;
  material: MaterialId;
}

/**
 * What a cottage's stage `stage` (1: footing and floor, 2: walls, 3: roof) puts in the world: the
 * site cleared (the first stage: trees and all, over it and round it), then its pieces (1 m blocks).
 * `ground`: the top of the ground (block y) at a block column, for the footing.
 */
export function cottageStage(c: Cottage, stage: number, ground: (bx: number, bz: number) => number): { clear: VillagePiece[]; place: VillagePiece[] } {
  const B = BLOCK_SIZE, clear: VillagePiece[] = [], place: VillagePiece[] = [];
  const at = (bx: number, by: number, bz: number, material: MaterialId) => (material === Material.Air ? clear : place).push({ x: bx * B, y: by * B, z: bz * B, size: B, material });
  const { bx, bz, w, d, floor: f } = c;
  if (stage === 1) {
    for (let x = bx - 1; x <= bx + w; x++) for (let z = bz - 1; z <= bz + d; z++) for (let y = f; y < f + 7; y++) at(x, y, z, Material.Air);
    for (let x = bx; x < bx + w; x++)
      for (let z = bz; z < bz + d; z++) {
        // (The ground's top block cleared too, then built again whole: a part-filled block has no room for a whole one.)
        for (let y = Math.min(ground(x, z), f - 1); y < f - 1; y++) {
          at(x, y, z, Material.Air);
          at(x, y, z, Material.Cobblestone);
        }
        at(x, f - 1, z, Material.Air);
        at(x, f - 1, z, Material.Planks);
      }
  } else if (stage === 2) {
    // The door: the middle of its side; windows: the middle of the two sides beside it.
    const doorAt = (x: number, z: number) =>
      c.door === 0 ? z === bz && x === bx + (w >> 1) : c.door === 2 ? z === bz + d - 1 && x === bx + (w >> 1) : c.door === 1 ? x === bx + w - 1 && z === bz + (d >> 1) : x === bx && z === bz + (d >> 1);
    const windowAt = (x: number, z: number) => (c.door % 2 === 0 ? (x === bx || x === bx + w - 1) && z === bz + (d >> 1) : (z === bz || z === bz + d - 1) && x === bx + (w >> 1));
    for (let x = bx; x < bx + w; x++)
      for (let z = bz; z < bz + d; z++) {
        const edgeX = x === bx || x === bx + w - 1, edgeZ = z === bz || z === bz + d - 1;
        if (!edgeX && !edgeZ) continue;
        for (let y = f; y < f + 3; y++) {
          if (doorAt(x, z) && y < f + 2) continue;
          if (windowAt(x, z) && y === f + 1) continue;
          at(x, y, z, edgeX && edgeZ ? Material.Wood : Material.Planks);
        }
      }
  } else if (stage === 3) {
    // Thatch, overhanging a block, stepped in across its width to a ridge along its length (each layer on the one under it: no gaps).
    const along = w >= d ? 'x' : 'z', across = along === 'x' ? d + 2 : w + 2;
    for (let k = 0; 2 * k < across; k++) {
      for (let x = bx - 1; x <= bx + w; x++)
        for (let z = bz - 1; z <= bz + d; z++) {
          const i = along === 'x' ? z - (bz - 1) : x - (bx - 1);
          if (i < k || i >= across - k) continue;
          at(x, f + 3 + k, z, Material.Thatch);
        }
    }
  }
  return { clear, place };
}

/** Where a hamlet's `n`th cottage goes (blocks), round its middle (block x, z) facing it, and its field beyond it: a ring of six. */
export function villagePlot(cx: number, cz: number, n: number): { cottage: Omit<Cottage, 'floor' | 'stage' | 'work'>; field: Omit<Field, 'tops' | 'sown' | 'tilled'> } {
  const a = (n * Math.PI * 2) / MAX_COTTAGES + 0.3, r = 13;
  const ox = Math.round(Math.cos(a) * r), oz = Math.round(Math.sin(a) * r);
  // Its door the side facing the middle; its long side across that.
  const door: 0 | 1 | 2 | 3 = Math.abs(ox) > Math.abs(oz) ? (ox > 0 ? 3 : 1) : oz > 0 ? 0 : 2;
  const w = door % 2 === 0 ? 5 : 4, d = door % 2 === 0 ? 4 : 5;
  const bx = cx + ox - (w >> 1), bz = cz + oz - (d >> 1);
  // The field: beyond it, two blocks off, six by five.
  const fw = 6, fd = 5, gap = 2;
  const fx = door === 3 ? bx + w + gap : door === 1 ? bx - gap - fw : bx + (w >> 1) - (fw >> 1);
  const fz = door === 0 ? bz + d + gap : door === 2 ? bz - gap - fd : bz + (d >> 1) - (fd >> 1);
  return { cottage: { bx, bz, w, d, door }, field: { bx: fx, bz: fz, w: fw, d: fd } };
}

const VILLAGE_NAMES = ['Thornfield', 'Ashby', 'Brookend', 'Coldwell', 'Dunham', 'Elmsworth', 'Fernley', 'Goldmoor', 'Hartwell', 'Ivydale', 'Kingsmead', 'Linwood', 'Marsh End', 'Netherby', 'Oakley', 'Penhallow', 'Ravenscar', 'Sedgemoor', 'Tanfield', 'Upwell', 'Wexcombe', 'Yarrowby'];
const VILLAGER_NAMES = ['Agnes', 'Bertil', 'Clem', 'Dora', 'Eamon', 'Freya', 'Gideon', 'Hester', 'Ivo', 'Joan', 'Kasper', 'Lotte', 'Mabel', 'Nils', 'Odile', 'Percy', 'Ruth', 'Silas', 'Thea', 'Ulric', 'Wilma', 'Ysolde', 'Abel', 'Brida'];

/** A name for the `n`th village, and the `n`th villager (as many as there are, then numbered). */
export const villageName = (n: number) => VILLAGE_NAMES[n % VILLAGE_NAMES.length]! + (n >= VILLAGE_NAMES.length ? ` ${Math.floor(n / VILLAGE_NAMES.length) + 1}` : '');
export const villagerName = (n: number) => VILLAGER_NAMES[n % VILLAGER_NAMES.length]! + (n >= VILLAGER_NAMES.length ? ` ${Math.floor(n / VILLAGER_NAMES.length) + 1}` : '');
