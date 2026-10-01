import { BLOCK_SIZE, gridCellIndex, rasterizeVoxels, type Block, type Chunk } from './chunk.js';
import { blockFromVoxels, blockVoxels, type BlockVoxel } from './edit.js';
import { MAX_FLOW, isWater, waterLevelOf, waterMaterial } from './materials.js';

/**
 * Water is voxels of the water materials (see materials.ts), filling the open space of 1 m
 * blocks: a block holds water of one flow level in every cell that isn't solid. Water isn't
 * solid (you see, move and aim through it), and flows from block to block (see WaterFlow).
 */

const stripped = new WeakMap<Exclude<Block, null>, Block>();

/** The block without its water (the same object if it has none). */
export function withoutWater(block: Block): Block {
  if (!block) return null;
  const hit = stripped.get(block);
  if (hit !== undefined) return hit;
  let out: Block = block;
  if (block.kind === 'uniform') {
    if (isWater(block.material)) out = null;
  } else if (block.kind === 'grid') {
    if (block.materials.some(isWater)) {
      const materials = block.materials.map((m) => (isWater(m) ? 0 : m));
      out = materials.some((m) => m !== 0) ? { kind: 'grid', size: block.size, materials } : null;
    }
  } else if (block.materials.some(isWater)) {
    const keep = [...block.materials.keys()].filter((i) => !isWater(block.materials[i]!));
    out = keep.length === 0 ? null : { kind: 'voxels', packed: Uint16Array.from(keep, (i) => block.packed[i]!), materials: Uint16Array.from(keep, (i) => block.materials[i]!) };
  }
  stripped.set(block, out);
  return out;
}

/** The chunk without water (the same object if it has none); blocks keep their identity where unchanged. */
export function chunkWithoutWater(chunk: Chunk): Chunk {
  let changed = false;
  const blocks = chunk.blocks.map((b) => {
    const w = withoutWater(b);
    if (w !== b) changed = true;
    return w;
  });
  return changed ? { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, blocks } : chunk;
}

/** Flow level of a block's water (the lowest, if mixed), or null if it has none. */
export function blockWater(block: Block): number | null {
  if (!block) return null;
  if (block.kind === 'uniform') return isWater(block.material) ? waterLevelOf(block.material) : null;
  let level: number | null = null;
  for (const m of block.materials) if (isWater(m)) level = Math.min(level ?? MAX_FLOW, waterLevelOf(m));
  return level;
}

/** Per unit cell: 1 if solid (not air, not water). */
function solidCells(block: Block): Uint8Array {
  const out = new Uint8Array(BLOCK_SIZE ** 3);
  const solid = withoutWater(block);
  if (!solid) return out;
  if (solid.kind === 'uniform') return out.fill(1);
  if (solid.kind === 'voxels') {
    const raster = rasterizeVoxels(solid).materials;
    for (let i = 0; i < out.length; i++) out[i] = raster[i] !== 0 ? 1 : 0;
    return out;
  }
  const s = solid.size, n = BLOCK_SIZE / s;
  for (let y = 0; y < BLOCK_SIZE; y++) {
    for (let z = 0; z < BLOCK_SIZE; z++) {
      for (let x = 0; x < BLOCK_SIZE; x++) {
        if (solid.materials[gridCellIndex(n, Math.floor(x / s), Math.floor(y / s), Math.floor(z / s))] !== 0) out[x + BLOCK_SIZE * (z + BLOCK_SIZE * y)] = 1;
      }
    }
  }
  return out;
}

/** Whether a block has any cell that isn't solid (room for water). */
export function blockHasRoom(block: Block): boolean {
  const solid = withoutWater(block);
  if (!solid) return true;
  if (solid.kind === 'uniform') return false;
  if (solid.kind === 'grid') return solid.materials.some((m) => m === 0);
  return rasterizeVoxels(solid).materials.some((m) => m === 0);
}

/**
 * How high water of a flow level stands in its block (units): sources and falling water (level 1)
 * fill it; flowing water is shallower the further it is from its source, down to 4/16 m.
 */
export function waterHeight(level: number): number {
  return level <= 1 ? BLOCK_SIZE : BLOCK_SIZE - 2 * (level - 1);
}

/** Whether a block has a cell, below block-local height `below`, that is neither solid nor water. */
export function blockHasAir(block: Block, below = BLOCK_SIZE): boolean {
  if (!block) return below > 0;
  if (block.kind === 'uniform') return false;
  if (block.kind === 'grid') {
    const n = BLOCK_SIZE / block.size;
    return block.materials.some((m, i) => m === 0 && Math.floor(i / (n * n)) * block.size < below);
  }
  const raster = rasterizeVoxels(block).materials;
  for (let i = 0; i < below * BLOCK_SIZE * BLOCK_SIZE && i < raster.length; i++) if (raster[i] === 0) return true;
  return false;
}

const uniformWater = new Map<number, Block>();

/**
 * The block with water of flow `level` (0 = source) in every cell that isn't solid, below
 * block-local height `below` (by default the level's waterHeight; cells above stay air); with
 * `level` null, the block without water.
 */
export function setBlockWater(block: Block, level: number | null, below = level === null ? 0 : waterHeight(level)): Block {
  const solid = withoutWater(block);
  if (level === null || below <= 0) return solid;
  const material = waterMaterial(level);
  if (!solid && below >= BLOCK_SIZE) {
    let u = uniformWater.get(material);
    if (!u) uniformWater.set(material, (u = { kind: 'uniform', size: BLOCK_SIZE, material }));
    return u;
  }
  if (solid && solid.kind === 'uniform') return solid;
  if (solid && solid.kind === 'grid' && below >= BLOCK_SIZE) {
    return { kind: 'grid', size: solid.size, materials: solid.materials.map((m) => (m === 0 ? material : m)) };
  }
  // Fill the open space with the largest cubes that fit (an octree), using a summed-volume table
  // to count solid cells in any cube.
  const cells = solidCells(solid);
  const N = BLOCK_SIZE + 1;
  const sum = new Int32Array(N * N * N);
  const at = (x: number, y: number, z: number) => x + N * (z + N * y);
  for (let y = 1; y < N; y++) {
    for (let z = 1; z < N; z++) {
      for (let x = 1; x < N; x++) {
        sum[at(x, y, z)] =
          cells[x - 1 + BLOCK_SIZE * (z - 1 + BLOCK_SIZE * (y - 1))]! +
          sum[at(x - 1, y, z)]! + sum[at(x, y - 1, z)]! + sum[at(x, y, z - 1)]! -
          sum[at(x - 1, y - 1, z)]! - sum[at(x - 1, y, z - 1)]! - sum[at(x, y - 1, z - 1)]! +
          sum[at(x - 1, y - 1, z - 1)]!;
      }
    }
  }
  const solidIn = (x: number, y: number, z: number, s: number) =>
    sum[at(x + s, y + s, z + s)]! - sum[at(x, y + s, z + s)]! - sum[at(x + s, y, z + s)]! - sum[at(x + s, y + s, z)]! +
    sum[at(x, y, z + s)]! + sum[at(x, y + s, z)]! + sum[at(x + s, y, z)]! - sum[at(x, y, z)]!;
  const water: BlockVoxel[] = [];
  const fill = (x: number, y: number, z: number, s: number) => {
    if (y >= below) return;
    const n = solidIn(x, y, z, s);
    if (n === s * s * s) return;
    if (n === 0 && y + s <= below) {
      water.push({ x, y, z, size: s, material });
      return;
    }
    if (s === 1) return;
    const t = s / 2;
    for (let i = 0; i < 8; i++) fill(x + (i & 1) * t, y + ((i >> 2) & 1) * t, z + ((i >> 1) & 1) * t, t);
  };
  fill(0, 0, 0, BLOCK_SIZE);
  if (water.length === 0) return solid;
  return blockFromVoxels([...blockVoxels(solid), ...water]);
}

/** Water's view of the world, in 1 m blocks (world block coordinates). */
export interface WaterWorld {
  /** The block, or undefined outside the world (which water treats as solid). */
  getBlock(bx: number, by: number, bz: number): Block | undefined;
  setBlock(bx: number, by: number, bz: number, block: Block): void;
}

const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const;
const AROUND = [...SIDES, [0, 1, 0], [0, -1, 0]] as const;

/**
 * Water flow, a block at a time (like Minecraft's): water falls into open space below it; on top
 * of something it can't fall into, it spreads sideways, one level weaker per block, up to
 * MAX_FLOW blocks from a source; flowing water with nothing feeding it dries up; and open space
 * between two sources, over something it can't fall into, becomes a source itself. Each step
 * looks at the blocks queued by the previous one (so water spreads a block per step).
 */
export class WaterFlow {
  private queue = new Set<string>();

  /** Queues a block and its neighbours to be looked at. */
  touch(bx: number, by: number, bz: number): void {
    this.queue.add(`${bx},${by},${bz}`);
    for (const [dx, dy, dz] of AROUND) this.queue.add(`${bx + dx},${by + dy},${bz + dz}`);
  }

  get pending(): number {
    return this.queue.size;
  }

  /**
   * Updates up to `limit` queued blocks (the rest wait); returns the blocks changed. Blocks whose
   * water changed queue their neighbours for the next step.
   */
  step(world: WaterWorld, limit = 4096): [number, number, number][] {
    const keys = [...this.queue].slice(0, limit);
    for (const k of keys) this.queue.delete(k);
    const changed: [number, number, number][] = [];
    for (const k of keys) {
      const [bx, by, bz] = k.split(',').map(Number) as [number, number, number];
      const block = world.getBlock(bx, by, bz);
      if (block === undefined || !blockHasRoom(block)) continue;
      const level = blockWater(block);
      const want = this.wanted(world, bx, by, bz, level);
      // Changed level, or new open space (dug, or water displaced) in a block that has water.
      if (want !== level || (want !== null && blockHasAir(block, waterHeight(want)))) {
        world.setBlock(bx, by, bz, setBlockWater(block, want));
        changed.push([bx, by, bz]);
        this.touch(bx, by, bz);
      }
    }
    return changed;
  }

  /** The flow level a block with room should have (null: dry). */
  private wanted(world: WaterWorld, bx: number, by: number, bz: number, level: number | null): number | null {
    if (level === 0) return 0; // sources stay
    const levelAt = (x: number, y: number, z: number) => {
      const b = world.getBlock(x, y, z);
      return b === undefined ? null : blockWater(b);
    };
    // Something water can't fall into: outside the world, no room, or a source (flowing water
    // below is still falling).
    const holds = (x: number, y: number, z: number) => {
      const b = world.getBlock(x, y, z);
      return b === undefined || !blockHasRoom(b) || blockWater(b) === 0;
    };
    // Falling from above.
    if (levelAt(bx, by + 1, bz) !== null) return 1;
    let best: number | null = null, sources = 0;
    for (const [dx, , dz] of SIDES) {
      const l = levelAt(bx + dx, by, bz + dz);
      if (l === null) continue;
      if (l === 0) sources++;
      // Water only spreads sideways from where it can't fall.
      if (!holds(bx + dx, by - 1, bz + dz)) continue;
      if (best === null || l + 1 < best) best = l + 1;
    }
    if (sources >= 2 && holds(bx, by - 1, bz)) return 0;
    return best !== null && best <= MAX_FLOW ? best : null;
  }
}
