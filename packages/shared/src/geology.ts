import { CHUNK_SIZE } from './world.js';
import { Material, materialName, type MaterialId } from './materials.js';
import { fractalAt, hash2, type Octave } from './noise.js';

/**
 * Geology (worlds with it: see PlateTerrainConfig.geology): the rock is in layers. Over a granite
 * basement lies a stack of sedimentary rock (sandstone, shale and limestone, 2 to 12 m each, with
 * seams of coal 1 to 2 m thick, mostly on top of shale), the same sequence everywhere in a world but
 * gently folded (rising and dipping over a few km, so a layer surfaces on one hillside and is deep
 * under the next) and thickening and thinning as it goes. Underground, each 1 m block is the rock
 * of its layer; on bare rock at the surface too, so cliffs show the layers as bands and a coal seam
 * can be found where it outcrops, then followed into the hill. Faults break the layers: steep
 * planes a few km long across which the rock (layers and basement alike) has moved up or down by
 * 5 to 40 m, most at a fault's middle, none at its ends (see Fault): a seam followed into a hill can
 * end at a wall of other rock and carry on higher or lower beyond it.
 *
 * Pure arithmetic from the world's seed (no state), cheap per block: a column's fold, stretch and
 * basement depth are worked out once per 1 m column (see column), and a block's layer is then one
 * table lookup (see rock).
 */

const UNITS_PER_METRE = 16;

/** The stack's sequence: this many metres of it below the fold's surface (the basement's deepest), and above. */
const BELOW = 200;
const ABOVE = 700;

/** Each kind of layer: how thick (m, at least and at most), and what can follow it (with how often). */
const LAYERS: Readonly<Record<'sandstone' | 'shale' | 'limestone' | 'coal', { rock: MaterialId; thick: [number, number]; next: [string, number][] }>> = {
  sandstone: { rock: Material.Sandstone, thick: [3, 12], next: [['shale', 0.6], ['limestone', 0.4]] },
  shale: { rock: Material.Shale, thick: [2, 8], next: [['coal', 0.35], ['limestone', 0.35], ['sandstone', 0.3]] },
  limestone: { rock: Material.Limestone, thick: [3, 10], next: [['shale', 0.5], ['sandstone', 0.5]] },
  coal: { rock: Material.CoalOre, thick: [1, 2], next: [['shale', 0.5], ['sandstone', 0.5]] },
};
/** Of a coal seam's blocks, the share that's coal (the rest shale: a seam isn't quite pure). */
const SEAM_FILL = 0.88;

/**
 * A column's geology (see Geology.column): the fold's surface (units), how stretched the layers are
 * there, how deep the basement is below the fold (units), and the faults through it: rock above
 * height `cutY[i]` (units) moved up by `cutShift[i]` (units; down if less than 0).
 */
export interface GeologyColumn {
  fold: number;
  stretch: number;
  base: number;
  cutY: readonly number[];
  cutShift: readonly number[];
}

/**
 * A fault: its trace's middle (x, z, units: at the fold's mean height), the way along it (sx, sz)
 * and the way it dips (nx, nz: across it, the side its plane leans down toward), how steeply
 * (tan of its dip), how far the rock on that side (above the plane) moved at its middle (units;
 * negative: down, as most do), how far it runs either way from the middle (units), and how far
 * from its trace the movement fades away (units).
 */
export interface Fault {
  x: number;
  z: number;
  sx: number;
  sz: number;
  nx: number;
  nz: number;
  tanDip: number;
  throw: number;
  half: number;
  reach: number;
}

/** Faults: one region this wide (m) has one with this chance; each runs 3-8 km, its movement fading over this far (m) from its trace. */
const FAULT_CELL = 3000;
const FAULT_CHANCE = 0.6;
const FAULT_REACH = 2500;
/** How far above the fold's mean height the ground can rise (m): faults leaning away beyond this far don't matter. */
const HIGHEST = 1200;
const NO_CUTS: readonly number[] = [];

/** A small seeded random (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The stack's sequence, 1 m a row from BELOW m under the fold's surface to ABOVE m over it: each
 * row's rock (coal seams as CoalOre).
 */
export function layerSequence(seed: number): Uint8Array {
  const r = random(seed ^ 0x5eed9e01);
  const rows = new Uint8Array(BELOW + ABOVE);
  let kind: keyof typeof LAYERS = r() < 0.5 ? 'sandstone' : 'limestone';
  for (let at = 0; at < rows.length; ) {
    const l = LAYERS[kind];
    const thick = Math.round(l.thick[0] + (l.thick[1] - l.thick[0]) * r());
    for (let i = 0; i < thick && at < rows.length; i++) rows[at++] = l.rock;
    let pick = r(), next = l.next[l.next.length - 1]![0];
    for (const [k, p] of l.next) {
      if ((pick -= p) < 0) {
        next = k;
        break;
      }
    }
    kind = next as keyof typeof LAYERS;
  }
  return rows;
}

export class Geology {
  private readonly rows: Uint8Array;
  private readonly fold: Octave[];
  private readonly stretch: Octave[];
  private readonly base: Octave[];
  private readonly seed: number;
  /** Where the fold's surface is on average (units). */
  private readonly datum: number;
  /** The fault regions: how wide (units), how many across a wrapping world (0: it doesn't wrap), and those worked out so far. */
  private readonly cell: number;
  private readonly cellsAcross: number;
  private readonly wrapWidth: number;
  private readonly faults = new Map<string, Fault | null>();
  /** Whether there are faults (worlds made before them have none). */
  private readonly faulted: boolean;

  /**
   * A world's geology from its `seed`: the fold's surface around `datum` (units: the sea's level);
   * `wrapWidth` (units) for worlds that wrap east-west (0: they don't), so it has no seam.
   */
  constructor(seed: number, datum: number, wrapWidth = 0, faulted = true) {
    this.seed = seed | 0;
    this.faulted = faulted;
    this.rows = layerSequence(seed);
    this.datum = datum;
    const oct = (salt: number, layers: [number, number][]): Octave[] =>
      layers.map(([metres, weight], k) => {
        // (On a wrapping world, the spacing nudged to fit its width a whole number of times: no seam.)
        const period = wrapWidth > 0 ? Math.max(1, Math.round(wrapWidth / (metres * UNITS_PER_METRE))) : 0;
        const spacing = period > 0 ? wrapWidth / period : metres * UNITS_PER_METRE;
        return { spacing, weight, periodX: period, seed: (Math.imul(seed, 31) + salt * 101 + k) | 0 };
      });
    // Folds: rising and falling up to about 120 m over 16 km, less over 4 km and 1.5 km.
    this.fold = oct(1, [[16000, 240 * UNITS_PER_METRE], [4000, 70 * UNITS_PER_METRE], [1500, 20 * UNITS_PER_METRE]]);
    // Layers thickening and thinning, 0.75x to 1.25x, over about 8 km.
    this.stretch = oct(2, [[8000, 0.5]]);
    // The basement 90 to 190 m below the fold's surface, varying over about 6 km.
    this.base = oct(3, [[6000, 100 * UNITS_PER_METRE]]);
    // Fault regions: on a wrapping world, as many as fit its width (so the last meets the first).
    this.wrapWidth = wrapWidth;
    this.cellsAcross = wrapWidth > 0 ? Math.max(1, Math.round(wrapWidth / (FAULT_CELL * UNITS_PER_METRE))) : 0;
    this.cell = wrapWidth > 0 ? wrapWidth / this.cellsAcross : FAULT_CELL * UNITS_PER_METRE;
  }

  /** The fault in region (i, j), if it has one (worked out from the seed, once). */
  faultIn(i: number, j: number): Fault | null {
    if (this.cellsAcross > 0) i = ((i % this.cellsAcross) + this.cellsAcross) % this.cellsAcross;
    const key = `${i},${j}`;
    let f = this.faults.get(key);
    if (f !== undefined) return f;
    const h = (salt: number) => hash2(i, j, Math.imul(this.seed, 0x45d9f3b) ^ salt);
    f = null;
    if (h(1) < FAULT_CHANCE) {
      const along = h(2) * Math.PI, dipSide = h(3) < 0.5 ? 1 : -1;
      const sx = Math.cos(along), sz = Math.sin(along);
      const metres = 5 + 35 * h(5) ** 1.5;
      f = {
        x: (i + h(6)) * this.cell,
        z: (j + h(7)) * this.cell,
        sx,
        sz,
        nx: -sz * dipSide,
        nz: sx * dipSide,
        tanDip: Math.tan(((55 + 30 * h(4)) * Math.PI) / 180),
        // (Most faults let the rock above them down: normal faults; some push it up.)
        throw: (h(8) < 0.7 ? -1 : 1) * metres * UNITS_PER_METRE,
        half: (1500 + 2500 * h(9)) * UNITS_PER_METRE,
        reach: FAULT_REACH * UNITS_PER_METRE,
      };
    }
    this.faults.set(key, f);
    return f;
  }

  /** The faults that can reach anywhere in the box [x0, x1] x [z0, z1] (units). */
  private faultsNear(x0: number, z0: number, x1: number, z1: number): Fault[] {
    if (!this.faulted) return [];
    // (A fault reaches at most half its 8 km and its fade beyond its region: three regions either way.)
    const out: Fault[] = [], c = this.cell, R = 3;
    const i0 = Math.floor(x0 / c) - R, i1 = Math.floor(x1 / c) + R, j0 = Math.floor(z0 / c) - R, j1 = Math.floor(z1 / c) + R;
    const span = (x0 + x1) / 2;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const f = this.faultIn(i, j);
        if (!f) continue;
        // (Its trace's middle nearest the box, on a wrapping world.)
        const fx = this.wrapWidth > 0 ? f.x + Math.round((span - f.x) / this.wrapWidth) * this.wrapWidth : f.x;
        const r = f.half + f.reach + (HIGHEST * UNITS_PER_METRE) / f.tanDip;
        if (fx + r < x0 || fx - r > x1 || f.z + r < z0 || f.z - r > z1) continue;
        out.push(fx === f.x ? f : { ...f, x: fx });
      }
    return out;
  }

  /** The geology of the column at (x, z) (units), with `faults` near it (worked out if not given). */
  column(x: number, z: number, faults = this.faultsNear(x, z, x, z)): GeologyColumn {
    const fold = this.datum + fractalAt(this.fold, x, z);
    let cutY: number[] | null = null, cutShift: number[] | null = null;
    for (const f of faults) {
      const dx = x - f.x, dz = z - f.z;
      const s = (dx * f.sx + dz * f.sz) / f.half;
      if (s <= -1 || s >= 1) continue;
      // Across it: how far toward the side it dips to; the movement fading from the trace that way.
      const h = dx * f.nx + dz * f.nz, fade = 1 - Math.max(0, h) / f.reach;
      if (fade <= 0) continue;
      const along = 1 - s * s, away = fade * fade * (3 - 2 * fade);
      const shift = f.throw * along * away;
      if (Math.abs(shift) < 8) continue;
      // The plane leans down toward that side: it passes through this column this high.
      (cutY ??= []).push(this.datum - h * f.tanDip);
      (cutShift ??= []).push(shift);
    }
    return {
      fold,
      stretch: 1 + fractalAt(this.stretch, x, z),
      base: 140 * UNITS_PER_METRE + fractalAt(this.base, x, z),
      cutY: cutY ?? NO_CUTS,
      cutShift: cutShift ?? NO_CUTS,
    };
  }

  /**
   * The columns of a chunk's 1 m blocks (at their middles): `out[bx + 16 * bz]` for the chunk at
   * (x0, z0) (units).
   */
  chunkColumns(x0: number, z0: number): GeologyColumn[] {
    const n = CHUNK_SIZE / UNITS_PER_METRE, out: GeologyColumn[] = [];
    // (The faults near the chunk, gathered once for all its columns.)
    const faults = this.faultsNear(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
    for (let bz = 0; bz < n; bz++) for (let bx = 0; bx < n; bx++) out.push(this.column(x0 + bx * UNITS_PER_METRE + 8, z0 + bz * UNITS_PER_METRE + 8, faults));
    return out;
  }

  /**
   * The rock at height `y` (units) in column `c` (see column), of block column (bx, bz) (block
   * coordinates: a seam's blocks vary by place). Granite below the basement; above it, the layer
   * there (beyond the stack's top, its sequence again).
   */
  rock(y: number, c: GeologyColumn, bx: number, bz: number): MaterialId {
    // (Above a fault's plane, the rock's moved: the layers here are those from that much lower or higher.)
    let moved = 0;
    for (let i = 0; i < c.cutY.length; i++) if (y > c.cutY[i]!) moved += c.cutShift[i]!;
    const below = y - c.fold - moved;
    if (below < -c.base) return Material.Granite;
    const n = this.rows.length;
    let i = Math.floor(below / UNITS_PER_METRE / c.stretch) + BELOW;
    if (i < 0) i = 0;
    else if (i >= n) i = BELOW + ((i - BELOW) % ABOVE);
    const m = this.rows[i]!;
    if (m === Material.CoalOre && hash2(bx, bz, Math.imul(Math.floor(y / UNITS_PER_METRE), 0x2c1b3c6d) ^ this.seed) >= SEAM_FILL) return Material.Shale;
    return m;
  }
}

/** What a geologist's hammer says of each rock (and ore): its name, and what to know about it. */
const ROCK_NOTES: Readonly<Partial<Record<MaterialId, string>>> = {
  [Material.Sandstone]: 'sandstone: sand, pressed into stone',
  [Material.Shale]: 'shale: mud, pressed into stone (coal seams lie on it)',
  [Material.Limestone]: 'limestone: the shells of a sea long gone',
  [Material.Granite]: 'granite: the deep rock, under all the layers',
  [Material.CoalOre]: 'coal, in a seam: follow it along the layer',
  [Material.IronOre]: 'iron ore',
  [Material.Stone]: 'stone',
};

/** What a geologist's hammer says of `m` tapped (anything not rock: just its name). */
export function rockNote(m: MaterialId): string {
  return ROCK_NOTES[m] ?? materialName(m);
}

/** Rock as geology has it (what bare rock's surface can be in a world with geology). */
export function isGeologyRock(m: MaterialId): boolean {
  return m === Material.Stone || m === Material.Sandstone || m === Material.Shale || m === Material.Limestone || m === Material.Granite || m === Material.CoalOre;
}
