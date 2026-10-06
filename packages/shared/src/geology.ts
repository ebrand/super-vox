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
 * end at a wall of other rock and carry on higher or lower beyond it. Then (version 3) granite
 * intrusions: domes 150 to 600 m across risen from the basement into the layers, with iron, copper
 * and gold in a band a few metres wide at their edges; dikes: sheets of basalt 1 to 4 m wide, a few
 * km long, cutting everything, with copper and gold at their sides; and banded iron: layers of iron
 * ore and shale, deep in the stack. (Iron isn't scattered then: see scatteredIron.)
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
  /** An intrusion's granite below this height (units; -Infinity: none), and its ore-bearing edge below this one. */
  graniteTop: number;
  haloTop: number;
  /** A dike: 0 none, 1 in it (basalt), 2 beside it (where copper and gold can be). */
  dike: 0 | 1 | 2;
}

/** An intrusion: a granite dome, its middle (x, z, units), its radius and its top's height (units); see column. */
export interface Pluton {
  x: number;
  z: number;
  r: number;
  top: number;
}

/** A dike: a sheet of basalt, its middle (x, z, units), the way along it (sx, sz), how far it runs either way (units) and how wide it is (units). */
export interface Dike {
  x: number;
  z: number;
  sx: number;
  sz: number;
  half: number;
  width: number;
}

/** Intrusions: one region this wide (m) has one with this chance. A dome falls by this share of its radius to its edge; ore lies this far (m) out from it. */
const PLUTON_CELL = 4000;
const PLUTON_CHANCE = 0.3;
const DOME_FALL = 0.5;
const HALO = 6;
/** Of the blocks at an intrusion's edge, the share that's ore; of those, how many are iron, copper and gold. */
const HALO_ORE = 0.28;
const HALO_SPLIT = [0.55, 0.35, 0.1] as const;
/** Dikes: one region this wide (m) has one with this chance; copper and gold this far (m) from its sides, this much of it. */
const DIKE_CELL = 3000;
const DIKE_CHANCE = 0.35;
const DIKE_EDGE = 1.5;
const DIKE_ORE = 0.1;

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
 * row's rock (coal seams as CoalOre). `banded`: with bands of iron ore deep in it (version 3).
 */
export function layerSequence(seed: number, banded = false): Uint8Array {
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
  if (banded) {
    // Banded iron: every 50-90 m deep in the stack (from 20 m below the fold's surface down), 4-7 m
    // of iron ore and shale, a metre each in turn.
    const b = random(seed ^ 0xba11d1);
    for (let at = 5 + Math.floor(b() * 40); at < BELOW - 20; at += 50 + Math.floor(b() * 40)) {
      const thick = 4 + Math.floor(b() * 4);
      for (let i = 0; i < thick && at + i < BELOW - 20; i++) rows[at + i] = i % 2 === 0 ? Material.IronOre : Material.Shale;
    }
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
  /** Whether there are faults (worlds made before them have none), and intrusions, dikes and banded iron (version 3). */
  private readonly faulted: boolean;
  private readonly intruded: boolean;
  /** Whether iron's scattered through the rock as in worlds without geology (version 3 has it in bands and at intrusions instead: see ores.ts). */
  readonly scatteredIron: boolean;
  private readonly plutons = new Map<string, Pluton | null>();
  private readonly dikes = new Map<string, Dike | null>();

  /**
   * A world's geology from its `seed`: the fold's surface around `datum` (units: the sea's level);
   * `wrapWidth` (units) for worlds that wrap east-west (0: they don't), so it has no seam.
   */
  /**
   * (`version`: of geology, as the world's setting: 1 layers alone, 2 with faults, 3 with
   * intrusions, dikes and banded iron too.)
   */
  constructor(seed: number, datum: number, wrapWidth = 0, version = 3) {
    this.seed = seed | 0;
    this.faulted = version >= 2;
    this.intruded = version >= 3;
    this.scatteredIron = version < 3;
    this.rows = layerSequence(seed, this.intruded);
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

  /** A region grid for features `metres` apart: how wide its regions are (units) and how many fit across a wrapping world (0: it doesn't wrap). */
  private grid(metres: number): { cell: number; across: number } {
    const across = this.wrapWidth > 0 ? Math.max(1, Math.round(this.wrapWidth / (metres * UNITS_PER_METRE))) : 0;
    return { cell: across > 0 ? this.wrapWidth / across : metres * UNITS_PER_METRE, across };
  }

  /** The intrusion in region (i, j), if it has one (worked out from the seed, once). */
  plutonIn(i: number, j: number): Pluton | null {
    const { cell, across } = this.grid(PLUTON_CELL);
    if (across > 0) i = ((i % across) + across) % across;
    const key = `${i},${j}`;
    let p = this.plutons.get(key);
    if (p !== undefined) return p;
    const h = (salt: number) => hash2(i, j, Math.imul(this.seed, 0x2f6b9a1d) ^ salt);
    p = null;
    if (h(1) < PLUTON_CHANCE) {
      const x = (i + 0.15 + 0.7 * h(2)) * cell, z = (j + 0.15 + 0.7 * h(3)) * cell;
      // (Risen 40-160 m into the layers from the basement there: through them, now and then to the surface.)
      const c = this.column(x, z, [], { plutons: [], dikes: [] });
      p = { x, z, r: (75 + 225 * h(4)) * UNITS_PER_METRE, top: c.fold - c.base + (40 + 120 * h(5)) * UNITS_PER_METRE };
    }
    this.plutons.set(key, p);
    return p;
  }

  /** The dike in region (i, j), if it has one (worked out from the seed, once). */
  dikeIn(i: number, j: number): Dike | null {
    const { cell, across } = this.grid(DIKE_CELL);
    if (across > 0) i = ((i % across) + across) % across;
    const key = `${i},${j}`;
    let d = this.dikes.get(key);
    if (d !== undefined) return d;
    const h = (salt: number) => hash2(i, j, Math.imul(this.seed, 0x6c8e9cf5) ^ salt);
    d = null;
    if (h(1) < DIKE_CHANCE) {
      const a = h(2) * Math.PI;
      d = { x: (i + h(3)) * cell, z: (j + h(4)) * cell, sx: Math.cos(a), sz: Math.sin(a), half: (500 + 2000 * h(5)) * UNITS_PER_METRE, width: (1 + 3 * h(6)) * UNITS_PER_METRE };
    }
    this.dikes.set(key, d);
    return d;
  }

  /**
   * Features (one a region, see `at`) that can reach the box [x0, x1] x [z0, z1] (units): `reach`,
   * how far one does from its (x, z); on a wrapping world, each moved to its copy nearest the box.
   */
  private near<T extends { x: number; z: number }>(metres: number, rings: number, at: (i: number, j: number) => T | null, reach: (f: T) => number, x0: number, z0: number, x1: number, z1: number): T[] {
    const { cell } = this.grid(metres), out: T[] = [];
    const i0 = Math.floor(x0 / cell) - rings, i1 = Math.floor(x1 / cell) + rings, j0 = Math.floor(z0 / cell) - rings, j1 = Math.floor(z1 / cell) + rings;
    const span = (x0 + x1) / 2;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const f = at(i, j);
        if (!f) continue;
        const fx = this.wrapWidth > 0 ? f.x + Math.round((span - f.x) / this.wrapWidth) * this.wrapWidth : f.x;
        const r = reach(f);
        if (fx + r < x0 || fx - r > x1 || f.z + r < z0 || f.z - r > z1) continue;
        out.push(fx === f.x ? f : { ...f, x: fx });
      }
    return out;
  }

  /** The intrusions and dikes that can reach the box [x0, x1] x [z0, z1] (units) (none before version 3). */
  private intrusionsNear(x0: number, z0: number, x1: number, z1: number): { plutons: Pluton[]; dikes: Dike[] } {
    if (!this.intruded) return { plutons: [], dikes: [] };
    return {
      plutons: this.near(PLUTON_CELL, 1, (i, j) => this.plutonIn(i, j), (p) => p.r + HALO * UNITS_PER_METRE, x0, z0, x1, z1),
      dikes: this.near(DIKE_CELL, 1, (i, j) => this.dikeIn(i, j), (d) => d.half + d.width + DIKE_EDGE * UNITS_PER_METRE, x0, z0, x1, z1),
    };
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

  /** The geology of the column at (x, z) (units), with the faults, intrusions and dikes near it (worked out if not given). */
  column(x: number, z: number, faults = this.faultsNear(x, z, x, z), intrusions = this.intrusionsNear(x, z, x, z)): GeologyColumn {
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
    // Intrusions: a dome's granite under this column (and its ore-bearing edge over it, or beside
    // its wall just outside it); dikes: in one, or just beside it.
    let graniteTop = -Infinity, haloTop = -Infinity, dike: 0 | 1 | 2 = 0;
    const halo = HALO * UNITS_PER_METRE;
    for (const p of intrusions.plutons) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r) {
        const top = p.top - DOME_FALL * p.r * (d / p.r) ** 2;
        graniteTop = Math.max(graniteTop, top);
        haloTop = Math.max(haloTop, top + halo);
      } else if (d < p.r + halo) haloTop = Math.max(haloTop, p.top - DOME_FALL * p.r);
    }
    for (const k of intrusions.dikes) {
      const dx = x - k.x, dz = z - k.z;
      if (Math.abs(dx * k.sx + dz * k.sz) >= k.half) continue;
      const off = Math.abs(dz * k.sx - dx * k.sz);
      if (off < k.width / 2) dike = 1;
      else if (off < k.width / 2 + DIKE_EDGE * UNITS_PER_METRE && dike === 0) dike = 2;
    }
    return {
      fold,
      stretch: 1 + fractalAt(this.stretch, x, z),
      base: 140 * UNITS_PER_METRE + fractalAt(this.base, x, z),
      cutY: cutY ?? NO_CUTS,
      cutShift: cutShift ?? NO_CUTS,
      graniteTop,
      haloTop,
      dike,
    };
  }

  /**
   * The columns of a chunk's 1 m blocks (at their middles): `out[bx + 16 * bz]` for the chunk at
   * (x0, z0) (units).
   */
  chunkColumns(x0: number, z0: number): GeologyColumn[] {
    const n = CHUNK_SIZE / UNITS_PER_METRE, out: GeologyColumn[] = [];
    // (The faults, intrusions and dikes near the chunk, gathered once for all its columns.)
    const faults = this.faultsNear(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE), intrusions = this.intrusionsNear(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
    for (let bz = 0; bz < n; bz++) for (let bx = 0; bx < n; bx++) out.push(this.column(x0 + bx * UNITS_PER_METRE + 8, z0 + bz * UNITS_PER_METRE + 8, faults, intrusions));
    return out;
  }

  /**
   * The rock at height `y` (units) in column `c` (see column), of block column (bx, bz) (block
   * coordinates: a seam's blocks vary by place). Granite below the basement; above it, the layer
   * there (beyond the stack's top, its sequence again).
   */
  rock(y: number, c: GeologyColumn, bx: number, bz: number): MaterialId {
    // Dikes cut through everything; an intrusion's granite pushes the layers aside; at its edge, and
    // beside a dike, ore.
    if (c.dike === 1) return Material.Basalt;
    if (y < c.graniteTop) return Material.Granite;
    const m = this.layer(y, c, bx, bz);
    // (Where it meets the layers: not against the basement's granite.)
    if (m !== Material.Granite && (y < c.haloTop || c.dike === 2)) {
      const h = hash2(bx, bz, Math.imul(Math.floor(y / UNITS_PER_METRE), 0x1b873593) ^ this.seed ^ 0x0e0e);
      if (y < c.haloTop) {
        if (h < HALO_ORE) {
          const k = h / HALO_ORE;
          return k < HALO_SPLIT[0] ? Material.IronOre : k < HALO_SPLIT[0] + HALO_SPLIT[1] ? Material.CopperOre : Material.GoldOre;
        }
      } else if (h < DIKE_ORE) return h < DIKE_ORE * 0.8 ? Material.CopperOre : Material.GoldOre;
    }
    return m;
  }

  /** The layer's rock (or the basement's granite) at height `y` in column `c`, as faults have moved them (see rock). */
  private layer(y: number, c: GeologyColumn, bx: number, bz: number): MaterialId {
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
  [Material.Granite]: 'granite: the deep rock, under all the layers; where it has risen into them, ore lies at its edges',
  [Material.Basalt]: 'basalt: rock that rose molten through a crack; copper and gold at its sides',
  [Material.CoalOre]: 'coal, in a seam: follow it along the layer',
  [Material.IronOre]: 'iron ore: in bands deep in the layers, and at the edges of granite',
  [Material.CopperOre]: 'copper ore: at the edges of granite, and beside basalt',
  [Material.GoldOre]: 'gold ore: rare, at the edges of granite, and beside basalt',
  [Material.Stone]: 'stone',
};

/** What a geologist's hammer says of `m` tapped (anything not rock: just its name). */
export function rockNote(m: MaterialId): string {
  return ROCK_NOTES[m] ?? materialName(m);
}

/** Whether `m` is ore (as geology places it). */
export function isOre(m: MaterialId): boolean {
  return m === Material.CoalOre || m === Material.IronOre || m === Material.CopperOre || m === Material.GoldOre;
}

/** Rock as geology has it (what bare rock's surface can be in a world with geology). */
export function isGeologyRock(m: MaterialId): boolean {
  return (
    m === Material.Stone || m === Material.Sandstone || m === Material.Shale || m === Material.Limestone || m === Material.Granite || m === Material.Basalt ||
    m === Material.CoalOre || m === Material.IronOre || m === Material.CopperOre || m === Material.GoldOre
  );
}
