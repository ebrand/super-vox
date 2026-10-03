import { BLOCK_SIZE, BLOCKS_PER_AXIS, DEBRIS_LIFT, GRAVITY, UNITS_PER_METER, craterShape, isExplosive, blockIndex, blockVoxelAt, isWater, type Block, type Chunk, type MaterialId } from '@super-vox/shared';

/**
 * A blast's dust: up to CLOUD_MAX pieces (of CLOUD_SIZES) of what it blew apart, made by each
 * client from its own chunks (from the blast's seed, so everyone's are much alike), flown on simple
 * arcs to where they land on the ground as it is after the blast, then gone (see ExplosionView).
 * Just for show: the pieces everyone sees the same, and that stay, are the server's (see Explosives).
 */

/** Most pieces in a blast's dust. */
export const CLOUD_MAX = 100_000;
/** The cells (units: 1/4 m) a blast's dust is picked from: one piece each, of a size from CLOUD_SIZES. */
export const CLOUD_PIECE = 4;
/** The dust's piece sizes (units), and how many of them are each: mostly small, a few big. */
export const CLOUD_SIZES: readonly { size: number; share: number }[] = [
  { size: 1, share: 0.5 },
  { size: 2, share: 0.3 },
  { size: 4, share: 0.15 },
  { size: 8, share: 0.05 },
];
/** Longest a piece flies (s) before it's gone, landed or not. */
export const CLOUD_FLIGHT_S = 2.5;
/** How long a piece stays (s) once it has landed, before it's gone. */
export const CLOUD_REST_S = 1;
/** How far from the blast's edge (units) the ground is known for landing on: 24 m. */
const REACH = 24 * UNITS_PER_METER;
/** Steps (s) when looking for where a piece lands. */
const STEP_S = 1 / 30;

/** A chunk of the world, as the client has it: null for empty, undefined for not here. */
export type ChunkAt = (cx: number, cy: number, cz: number) => Chunk | null | undefined;

/** Pieces in flat arrays (metres, seconds), as the GPU takes them: each piece's i-th 3 or 4. */
export interface Cloud {
  count: number;
  /** Where each starts (its middle). */
  start: Float32Array;
  /** How fast it's thrown (m/s). */
  velocity: Float32Array;
  /** Where it lands (its middle), and when (s; a big number if it doesn't). */
  land: Float32Array;
  /** How fast it tumbles (rad/s about x, y, z), and when it's gone (s). */
  spin: Float32Array;
  /** How big it is (m). */
  size: Float32Array;
  material: Uint16Array;
  /** When the last of them is gone (s). */
  end: number;
}

/** A small, quick, seeded random number generator (mulberry32): [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether a block has anything solid (not water) in it. */
const solidCache = new WeakMap<object, boolean>();
function blockSolid(block: Block): boolean {
  if (!block) return false;
  if (block.kind === 'uniform') return !isWater(block.material);
  let solid = solidCache.get(block);
  if (solid === undefined) {
    solid = false;
    for (const m of block.materials) if (m !== 0 && !isWater(m)) solid = true;
    solidCache.set(block, solid);
  }
  return solid;
}

/** 1 m blocks by block coordinates, through a ChunkAt (remembering the last chunk: lookups come in runs). */
function blocks(chunkAt: ChunkAt): (bx: number, by: number, bz: number) => Block | undefined {
  let last: { cx: number; cy: number; cz: number; chunk: Chunk | null | undefined } | null = null;
  const n = BLOCKS_PER_AXIS;
  return (bx, by, bz) => {
    const cx = Math.floor(bx / n), cy = Math.floor(by / n), cz = Math.floor(bz / n);
    if (!last || last.cx !== cx || last.cy !== cy || last.cz !== cz) last = { cx, cy, cz, chunk: chunkAt(cx, cy, cz) };
    const chunk = last.chunk;
    if (chunk === undefined) return undefined;
    if (chunk === null) return null;
    return chunk.blocks[blockIndex(bx - cx * n, by - cy * n, bz - cz * n)] ?? null;
  };
}

/** A blast and what's needed to fly its dust (see sampleBlast): plain numbers, to go to a worker. */
export interface BlastSample {
  x: number;
  y: number;
  z: number;
  radius: number;
  seed: number;
  /** Which way the blast goes (a unit vector; see openDirection). */
  open: readonly [number, number, number];
  /** The crater's shape's seed (see craterShape; as the server's), or none: the sphere. */
  craterSeed?: number;
  /** The pieces: each one's cell (corner, units) and material, 4 numbers a piece. */
  picked: Int32Array;
  /** The ground's height (units) on 1 m columns from block column (x0, z0), cols x cols; -Infinity where none. */
  ground: Float32Array;
  x0: number;
  z0: number;
  cols: number;
}

/** The dust of a blast centred at (x, y, z) of `radius` (units): sampleBlast, then flyCloud. */
export function blastCloud(chunkAt: ChunkAt, x: number, y: number, z: number, radius: number, seed: number, max = CLOUD_MAX, open: readonly [number, number, number] = [0, 1, 0], craterSeed?: number): Cloud {
  return flyCloud(sampleBlast(chunkAt, x, y, z, radius, seed, max, open, craterSeed));
}

/**
 * What a blast centred at (x, y, z) of `radius` (units) blows apart, from the world as it is just
 * before (`chunkAt`; so this is done at once, before the crater's chunks): up to `max` pieces,
 * picked at random (from `seed`) among the solid cells it takes out (as World.explode: within its
 * crater, shaped by `craterSeed`, or the sphere; not water, not explosives); and the ground around,
 * for them to land on.
 */
export function sampleBlast(chunkAt: ChunkAt, x: number, y: number, z: number, radius: number, seed: number, max = CLOUD_MAX, open: readonly [number, number, number] = [0, 1, 0], craterSeed?: number): BlastSample {
  const random = seeded(seed);
  const blockAt = blocks(chunkAt);
  const shape = craterShape(radius, craterSeed), reach = shape.outer;
  const P = CLOUD_PIECE, B = BLOCK_SIZE;
  // Cells taken out: a fair random `max` of them (reservoir sampling), without listing them all.
  const picked: number[] = []; // x, y, z (units, the cell's corner), material
  let seen = 0;
  for (let by = Math.floor((y - reach) / B); by <= Math.floor((y + reach) / B); by++) {
    for (let bz = Math.floor((z - reach) / B); bz <= Math.floor((z + reach) / B); bz++) {
      for (let bx = Math.floor((x - reach) / B); bx <= Math.floor((x + reach) / B); bx++) {
        // (Blocks all in the crater, or all out, decided at once; only those on its edge cell by cell.)
        const where = shape.classify(bx * B - x, by * B - y, bz * B - z, B);
        if (where === -1) continue;
        const block = blockAt(bx, by, bz);
        if (!block) continue;
        // On the edge: its eight half-metre octants decided the same way, and only those on the edge cell by cell.
        const octants = where === 0 ? Array.from({ length: 8 }, (_, o) => shape.classify(bx * B + (o & 1) * 8 - x, by * B + ((o >> 1) & 1) * 8 - y, bz * B + ((o >> 2) & 1) * 8 - z, 8)) : null;
        for (let k = 0; k < (B / P) ** 3; k++) {
          const lx = (k % 4) * P, ly = (k >> 4) * P, lz = ((k >> 2) % 4) * P;
          const cx = bx * B + lx, cy = by * B + ly, cz = bz * B + lz;
          if (octants) {
            const o = octants[(lx >> 3) | ((ly >> 3) << 1) | ((lz >> 3) << 2)]!;
            if (o === -1 || (o === 0 && !shape.contains(cx + P / 2 - x, cy + P / 2 - y, cz + P / 2 - z))) continue;
          }
          const m: MaterialId = block.kind === 'uniform' ? block.material : (blockVoxelAt(block, lx + P / 2, ly + P / 2, lz + P / 2)?.material ?? 0);
          if (m === 0 || isWater(m) || isExplosive(m)) continue;
          seen++;
          if (picked.length < max * 4) picked.push(cx, cy, cz, m);
          else {
            const j = Math.floor(random() * seen);
            if (j < max) {
              picked[j * 4] = cx;
              picked[j * 4 + 1] = cy;
              picked[j * 4 + 2] = cz;
              picked[j * 4 + 3] = m;
            }
          }
        }
      }
    }
  }
  // The ground around, 1 m columns: the top of the highest solid block (the crater's cut out in flyCloud).
  const half = radius + REACH;
  const x0 = Math.floor((x - half) / B), z0 = Math.floor((z - half) / B), cols = Math.ceil((2 * half) / B) + 1;
  const top = Math.floor((y + radius + 32 * UNITS_PER_METER) / B), bottom = Math.floor((y - radius - 48 * UNITS_PER_METER) / B);
  const ground = new Float32Array(cols * cols).fill(-Infinity);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const bx = x0 + i, bz = z0 + j;
      let h = -Infinity;
      for (let by = top; by >= bottom; by--) {
        const block = blockAt(bx, by, bz);
        if (block === undefined) continue;
        if (blockSolid(block)) {
          h = (by + 1) * B;
          break;
        }
      }
      ground[i + cols * j] = h;
    }
  }
  return { x, y, z, radius, seed, open, ...(craterSeed !== undefined ? { craterSeed } : {}), picked: Int32Array.from(picked), ground, x0, z0, cols };
}

/**
 * Flies a blast's dust (see sampleBlast): each piece thrown out and up from the blast's middle (a
 * little scattered, from its seed), on its arc to where it comes down on the ground as it'll be,
 * the crater cut out. Plain arithmetic on arrays: a worker can do it (see blastCloud.worker.ts).
 */
export function flyCloud(sample: BlastSample): Cloud {
  const { x, y, z, radius, picked, ground, x0, z0, cols, open } = sample;
  const B = BLOCK_SIZE, P = CLOUD_PIECE;
  const shape = craterShape(radius, sample.craterSeed);
  const count = picked.length / 4;
  // (Its own random numbers: the same everywhere for the same blast.)
  const random = seeded(sample.seed ^ 0x5bd1e995);
  const groundAt = (ux: number, uz: number) => {
    const i = Math.floor(ux / B) - x0, j = Math.floor(uz / B) - z0;
    let h = i < 0 || j < 0 || i >= cols || j >= cols ? -Infinity : ground[i + cols * j]!;
    // The crater (exactly, not by the metre): where it reaches up through the ground, its bottom
    // (straight down from the middle as far as it goes there: its reach that way, found again once).
    const dx = ux - x, dz = uz - z, d2 = dx * dx + dz * dz;
    if (d2 < shape.outer ** 2) {
      let r = shape.reach(dx, -Math.sqrt(Math.max(0, radius * radius - d2)), dz);
      r = shape.reach(dx, -Math.sqrt(Math.max(0, r * r - d2)), dz);
      if (d2 < r * r) {
        const s = Math.sqrt(r * r - d2);
        if (h <= y + s) h = Math.min(h, y - s);
      }
    }
    return h;
  };

  // Each piece: thrown out and up from the middle (a little scattered), and where it comes down.
  const M = UNITS_PER_METER, g = GRAVITY;
  const start = new Float32Array(count * 3), velocity = new Float32Array(count * 3), land = new Float32Array(count * 4), spin = new Float32Array(count * 4);
  const material = new Uint16Array(count), size = new Float32Array(count);
  const speedScale = Math.sqrt(Math.min(2, radius / 64));
  let end = 0;
  for (let p = 0; p < count; p++) {
    const px = picked[p * 4]! + P / 2, py = picked[p * 4 + 1]! + P / 2, pz = picked[p * 4 + 2]! + P / 2;
    material[p] = picked[p * 4 + 3]!;
    // Its size: one of CLOUD_SIZES, as often as its share.
    let u = random(), s = CLOUD_SIZES[CLOUD_SIZES.length - 1]!.size;
    for (const c of CLOUD_SIZES) {
      if (u < c.share) {
        s = c.size;
        break;
      }
      u -= c.share;
    }
    size[p] = s / UNITS_PER_METER;
    const half = s / 2 / UNITS_PER_METER;
    let dx = px - x, dy = py - y, dz = pz - z;
    const len = Math.hypot(dx, dy, dz) || 1;
    // Out from the middle, and toward the open air (as the server's pieces), a little scattered.
    dx = dx / len + DEBRIS_LIFT * open[0] + (random() - 0.5) * 0.6;
    dy = dy / len + DEBRIS_LIFT * open[1] + (random() - 0.5) * 0.6;
    dz = dz / len + DEBRIS_LIFT * open[2] + (random() - 0.5) * 0.6;
    const dl = Math.hypot(dx, dy, dz) || 1, speed = (5 + 7 * random()) * speedScale;
    const vx = (dx / dl) * speed, vy = (dy / dl) * speed, vz = (dz / dl) * speed;
    start.set([px / M, py / M, pz / M], p * 3);
    velocity.set([vx, vy, vz], p * 3);
    // Down onto the ground, or into the side of it (not in its first moments, still leaving the crater).
    const at = (t: number): [number, number, number] => [px / M + vx * t, py / M + vy * t - 0.5 * g * t * t, pz / M + vz * t];
    const hits = (t: number) => {
      const q = at(t);
      return (vy - g * t < 0 || t > 0.1) && q[1] - half <= groundAt(q[0] * M, q[2] * M) / M;
    };
    let tl = Infinity;
    for (let t = STEP_S; t <= CLOUD_FLIGHT_S; t += STEP_S) {
      if (!hits(t)) continue;
      let lo = t - STEP_S, hi = t;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (hits(mid)) hi = mid;
        else lo = mid;
      }
      tl = hi;
      break;
    }
    const gone = tl === Infinity ? CLOUD_FLIGHT_S : tl + CLOUD_REST_S;
    if (tl === Infinity) land.set([0, 0, 0, 1e6], p * 4);
    else {
      // On top of the ground; or, run into the side of higher ground (well below its top), where it hit.
      const q = at(tl), onTop = groundAt(q[0] * M, q[2] * M) / M + half;
      land.set([q[0], onTop - q[1] > 0.1 ? q[1] : onTop, q[2], tl], p * 4);
    }
    spin.set([(random() - 0.5) * 16, (random() - 0.5) * 16, (random() - 0.5) * 16, gone], p * 4);
    end = Math.max(end, gone);
  }
  return { count, start, velocity, land, spin, material, size, end };
}
