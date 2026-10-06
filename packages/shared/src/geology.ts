import { CHUNK_SIZE } from './world.js';
import { Material, type MaterialId } from './materials.js';
import { fractalAt, hash2, type Octave } from './noise.js';

/**
 * Geology (worlds with it: see PlateTerrainConfig.geology): the rock is in layers. Over a granite
 * basement lies a stack of sedimentary rock (sandstone, shale and limestone, 2 to 12 m each, with
 * seams of coal 1 to 2 m thick, mostly on top of shale), the same sequence everywhere in a world but
 * gently folded (rising and dipping over a few km, so a layer surfaces on one hillside and is deep
 * under the next) and thickening and thinning as it goes. Underground, each 1 m block is the rock
 * of its layer; on bare rock at the surface too, so cliffs show the layers as bands and a coal seam
 * can be found where it outcrops, then followed into the hill.
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

/** A column's geology (see Geology.column): the fold's surface (units), how stretched the layers are there, and how deep the basement is below the fold (units). */
export interface GeologyColumn {
  fold: number;
  stretch: number;
  base: number;
}

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

  /**
   * A world's geology from its `seed`: the fold's surface around `datum` (units: the sea's level);
   * `wrapWidth` (units) for worlds that wrap east-west (0: they don't), so it has no seam.
   */
  constructor(seed: number, datum: number, wrapWidth = 0) {
    this.seed = seed | 0;
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
  }

  /** The geology of the column at (x, z) (units). */
  column(x: number, z: number): GeologyColumn {
    return {
      fold: this.datum + fractalAt(this.fold, x, z),
      stretch: 1 + fractalAt(this.stretch, x, z),
      base: 140 * UNITS_PER_METRE + fractalAt(this.base, x, z),
    };
  }

  /**
   * The columns of a chunk's 1 m blocks (at their middles): `out[bx + 16 * bz]` for the chunk at
   * (x0, z0) (units).
   */
  chunkColumns(x0: number, z0: number): GeologyColumn[] {
    const n = CHUNK_SIZE / UNITS_PER_METRE, out: GeologyColumn[] = [];
    for (let bz = 0; bz < n; bz++) for (let bx = 0; bx < n; bx++) out.push(this.column(x0 + bx * UNITS_PER_METRE + 8, z0 + bz * UNITS_PER_METRE + 8));
    return out;
  }

  /**
   * The rock at height `y` (units) in column `c` (see column), of block column (bx, bz) (block
   * coordinates: a seam's blocks vary by place). Granite below the basement; above it, the layer
   * there (beyond the stack's top, its sequence again).
   */
  rock(y: number, c: GeologyColumn, bx: number, bz: number): MaterialId {
    const below = y - c.fold;
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

/** Rock as geology has it (what bare rock's surface can be in a world with geology). */
export function isGeologyRock(m: MaterialId): boolean {
  return m === Material.Stone || m === Material.Sandstone || m === Material.Shale || m === Material.Limestone || m === Material.Granite || m === Material.CoalOre;
}
