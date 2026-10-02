import { BLOCK_SIZE, gridCellIndex, rasterizeVoxels, type Block, type Chunk } from './chunk.js';
import { blockFromVoxels, blockVoxels, type BlockVoxel } from './edit.js';
import { MAX_FLOW, Material, isWater, waterLevelOf, waterMaterial, type MaterialId } from './materials.js';

/**
 * Water is voxels of the water materials (see materials.ts), filling the open space of 1 m
 * blocks: a block holds water of one flow level in every cell that isn't solid. Water isn't
 * solid (you see, move and aim through it), and flows from block to block (see WaterFlow).
 */

/** No water standing over a column (see HeightSource.water). */
export const NO_WATER = -(2 ** 31);

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

/** Top of a block's water (block-local units): 0 without water. */
export function blockWaterTop(block: Block): number {
  if (!block) return 0;
  if (block.kind === 'uniform') return isWater(block.material) ? BLOCK_SIZE : 0;
  if (block.kind === 'grid') {
    const n = BLOCK_SIZE / block.size;
    let top = 0;
    block.materials.forEach((m, i) => {
      if (isWater(m)) top = Math.max(top, (Math.floor(i / (n * n)) + 1) * block.size);
    });
    return top;
  }
  let top = 0;
  for (let i = 0; i < block.packed.length; i++) {
    if (!isWater(block.materials[i]!)) continue;
    const p = block.packed[i]!;
    top = Math.max(top, ((p >> 4) & 15) + (p >> 12) + 1);
  }
  return top;
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
  if (level === null) return withoutWater(block);
  return fillWater(block, waterMaterial(level), below);
}

/** The block's solid part, with `material` water in its open space below block-local height `below`. */
function fillWater(block: Block, material: MaterialId, below: number): Block {
  const solid = withoutWater(block);
  if (below <= 0) return solid;
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
      // A source keeps its surface where it stands (a river or lake's may be part way up its
      // block); others stand at their level's height.
      const height = want === 0 && level === 0 ? blockWaterTop(block) : want === null ? 0 : waterHeight(want);
      // Changed level, or new open space (dug, or water displaced) below its surface.
      if (want !== level || (want !== null && blockHasAir(block, height))) {
        world.setBlock(bx, by, bz, setBlockWater(block, want, height));
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

/**
 * Poured water (see Material.PouredWater): an amount per 1 m block, as how deep it stands above
 * the block's floor (units; see blockFloor). Natural water (the sea, lakes and rivers, and flowing water of older
 * worlds) doesn't move and is always full: water poured into it joins it.
 */
export type WaterKind = 'natural' | 'poured' | null;

/** What water a block holds (natural if any natural water at all). */
export function waterKind(block: Block): WaterKind {
  if (!block) return null;
  const materials = block.kind === 'uniform' ? [block.material] : block.materials;
  let poured = false;
  for (const m of materials) {
    if (m === Material.PouredWater) poured = true;
    else if (isWater(m)) return 'natural';
  }
  return poured ? 'poured' : null;
}

const floors = new WeakMap<Exclude<Block, null>, number>();

/**
 * Where water would rest in a block (block-local units): the lowest layer with room, e.g. 13 in a
 * block whose bottom 13/16 m is ground; BLOCK_SIZE for a solid block. Water depths are measured
 * from here.
 */
export function blockFloor(block: Block): number {
  const solid = withoutWater(block);
  if (!solid) return 0;
  const hit = floors.get(solid);
  if (hit !== undefined) return hit;
  const cells = solidCells(solid);
  const layer = BLOCK_SIZE * BLOCK_SIZE;
  let floor = BLOCK_SIZE;
  for (let y = 0; y < BLOCK_SIZE && floor === BLOCK_SIZE; y++) {
    for (let i = 0; i < layer; i++) {
      if (cells[i + layer * y] === 0) {
        floor = y;
        break;
      }
    }
  }
  floors.set(solid, floor);
  return floor;
}

/** How deep water can stand in a block (units above its floor). */
export function waterCapacity(block: Block): number {
  return BLOCK_SIZE - blockFloor(block);
}

/** How deep a block's poured water stands (units above its floor); natural water counts as full. */
export function waterAmount(block: Block): number {
  const kind = waterKind(block);
  return kind === 'natural' ? waterCapacity(block) : kind === 'poured' ? Math.max(0, blockWaterTop(block) - blockFloor(block)) : 0;
}

/** The block with poured water `depth` units deep above its floor (0: none) in its open space. */
export function setPouredWater(block: Block, depth: number): Block {
  return depth <= 0 ? withoutWater(block) : fillWater(block, Material.PouredWater, Math.min(BLOCK_SIZE, blockFloor(block) + depth));
}

/**
 * Poured water, a step at a time: in each block that has some, it falls into open space below
 * (as much as fits), and where it can't fall it levels out with its four neighbours, comparing
 * surfaces (floor plus depth): half the difference to each that's at least 2 units lower, so it
 * settles flat to within a unit, a last thin layer stays put, and it runs down steps, never up. It is never made or lost, except into natural water (which it
 * joins) and out of the world. Each step looks at the blocks the previous one changed.
 */
export class PouredWater {
  private queue = new Set<string>();

  /** Queues a block and its neighbours to be looked at (after an edit, or a pour). */
  touch(bx: number, by: number, bz: number): void {
    this.queue.add(`${bx},${by},${bz}`);
    for (const [dx, dy, dz] of AROUND) this.queue.add(`${bx + dx},${by + dy},${bz + dz}`);
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Moves water in up to `limit` queued blocks; returns the blocks changed. */
  step(world: WaterWorld, limit = 4096): [number, number, number][] {
    const keys = [...this.queue].slice(0, limit);
    for (const k of keys) this.queue.delete(k);
    // Amounts as they change this step (so water moved once isn't moved again from a stale view).
    const amounts = new Map<string, number>();
    const changed = new Set<string>();
    const cell = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      const block = world.getBlock(x, y, z);
      if (block === undefined || !blockHasRoom(block)) return null; // outside the world or solid: holds water
      const natural = waterKind(block) === 'natural';
      const floor = blockFloor(block);
      return { key, block, natural, floor, capacity: BLOCK_SIZE - floor, amount: amounts.get(key) ?? waterAmount(block) };
    };
    const move = (from: { key: string }, to: { key: string; natural: boolean }, n: number, fromAmount: number, toAmount: number) => {
      amounts.set(from.key, fromAmount - n);
      changed.add(from.key);
      if (!to.natural) {
        amounts.set(to.key, toAmount + n);
        changed.add(to.key);
      }
    };
    for (const k of keys) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const here = cell(x, y, z);
      if (!here || here.natural || here.amount <= 0) continue;
      let a = here.amount;
      // Fall (only water resting on the very bottom of its block reaches the block below): as
      // much as that block has room for (natural water takes it all).
      const below = here.floor === 0 ? cell(x, y - 1, z) : null;
      const canFall = !!below && (below.natural || below.amount < below.capacity);
      if (canFall) {
        const n = below.natural ? a : Math.min(a, below.capacity - below.amount);
        move(here, below, n, a, below.amount);
        a -= n;
        if (a <= 0) continue;
        if (!below.natural && below.amount + n < below.capacity) continue; // still falling
      }
      // Level out: towards each neighbour whose surface (or, dry, its floor) is at least 2 units
      // lower, half the difference (as much as it has room for).
      for (const [dx, , dz] of SIDES) {
        const side = cell(x + dx, y, z + dz);
        if (!side || side.natural) continue;
        const drop = here.floor + a - (side.floor + side.amount);
        if (drop < 2) continue;
        const n = Math.min(a, Math.floor(drop / 2), side.capacity - side.amount);
        if (n <= 0) continue;
        move(here, side, n, a, side.amount);
        a -= n;
      }
    }
    const out: [number, number, number][] = [];
    for (const key of changed) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const block = world.getBlock(x, y, z);
      if (block === undefined) continue;
      world.setBlock(x, y, z, setPouredWater(block, amounts.get(key)!));
      out.push([x, y, z]);
      this.touch(x, y, z);
    }
    return out;
  }
}

