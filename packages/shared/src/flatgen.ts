import {
  BLOCK_SIZE,
  BLOCKS_PER_AXIS,
  blockIndex,
  emptyChunk,
  gridCellIndex,
  isGridSize,
  type Block,
  type Chunk,
} from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import type { VoxelSize } from './units.js';
import { CHUNK_SIZE, type ChunkCoord, type WorldConfig } from './world.js';

export interface GroundLayer {
  material: MaterialId;
  /** Thickness in units; must be a multiple of the generation resolution. */
  thickness: number;
}

export interface FlatGenConfig {
  /** Edge of generated voxels in units. Must tile a 1 m block: 1, 2, 4, 8 or 16. */
  resolution: VoxelSize;
  /** Y (units) of the ground's top surface. Must be a multiple of `resolution`. */
  surfaceY: number;
  /** Layers from the surface downward. The last layer extends to the world floor. */
  layers: GroundLayer[];
}

/** One voxel of grass, 3 m of dirt, then stone to the world floor. Surface at y = 0. */
export function defaultFlatGen(resolution: VoxelSize): FlatGenConfig {
  return {
    resolution,
    surfaceY: 0,
    layers: [
      { material: Material.Grass, thickness: resolution },
      { material: Material.Dirt, thickness: 3 * BLOCK_SIZE },
      { material: Material.Stone, thickness: 0 },
    ],
  };
}

/** Throws a RangeError describing the first problem found. */
export function validateFlatGen(world: WorldConfig, gen: FlatGenConfig): void {
  const r = gen.resolution;
  if (!isGridSize(r)) {
    throw new RangeError(`resolution must be one of 1, 2, 4, 8, 16 units; got ${r}`);
  }
  if (!Number.isInteger(gen.surfaceY) || gen.surfaceY % r !== 0) {
    throw new RangeError(`surfaceY ${gen.surfaceY} is not a multiple of resolution ${r}`);
  }
  if (gen.surfaceY <= world.minYUnits || gen.surfaceY > world.maxYUnits) {
    throw new RangeError(`surfaceY ${gen.surfaceY} is outside the world's Y range`);
  }
  if (gen.layers.length === 0) throw new RangeError('at least one layer is required');
  gen.layers.forEach((layer, i) => {
    const last = i === gen.layers.length - 1;
    if (!Number.isInteger(layer.material) || layer.material <= 0 || layer.material > 0xffff) {
      throw new RangeError(`layer ${i}: invalid material ${layer.material}`);
    }
    if (!last && (!Number.isInteger(layer.thickness) || layer.thickness <= 0 || layer.thickness % r !== 0)) {
      throw new RangeError(`layer ${i}: thickness ${layer.thickness} must be a positive multiple of ${r}`);
    }
  });
}

/**
 * Generates chunks for a flat world. Terrain depends only on Y, so each distinct
 * block row is built once and shared between chunks.
 */
export class FlatGenerator {
  /** Blocks keyed by their per-layer materials, so identical rows share one object. */
  private readonly rowCache = new Map<string, Block>();

  constructor(
    readonly world: WorldConfig,
    readonly gen: FlatGenConfig,
  ) {
    validateFlatGen(world, gen);
  }

  /** Material of the ground at unit Y, independent of X/Z. */
  materialAtY(y: number): MaterialId {
    if (y >= this.gen.surfaceY || y < this.world.minYUnits) return Material.Air;
    let top = this.gen.surfaceY;
    for (let i = 0; i < this.gen.layers.length; i++) {
      const layer = this.gen.layers[i]!;
      if (i === this.gen.layers.length - 1 || y >= top - layer.thickness) return layer.material;
      top -= layer.thickness;
    }
    return Material.Air;
  }

  /**
   * Generates a chunk. Horizontal chunk coordinates must already be
   * normalized; chunks outside the world are returned empty.
   */
  generateChunk(coord: ChunkCoord): Chunk {
    const chunk = emptyChunk(coord);
    const x0 = coord.cx * CHUNK_SIZE;
    const z0 = coord.cz * CHUNK_SIZE;
    if (x0 < 0 || x0 >= this.world.widthUnits || z0 < 0 || z0 >= this.world.depthUnits) {
      return chunk;
    }
    for (let by = 0; by < BLOCKS_PER_AXIS; by++) {
      const block = this.blockForRow(coord.cy * CHUNK_SIZE + by * BLOCK_SIZE);
      if (!block) continue;
      for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++) {
        for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
          chunk.blocks[blockIndex(bx, by, bz)] = block;
        }
      }
    }
    return chunk;
  }

  private blockForRow(y0: number): Block {
    const size = this.gen.resolution;
    const n = BLOCK_SIZE / size;
    const layerMaterials: MaterialId[] = [];
    for (let j = 0; j < n; j++) layerMaterials.push(this.materialAtY(y0 + j * size));

    // Rows with the same layering share one Block object.
    const key = layerMaterials.join(',');
    if (this.rowCache.has(key)) return this.rowCache.get(key)!;

    let block: Block;
    if (layerMaterials.every((m) => m === layerMaterials[0])) {
      const m = layerMaterials[0]!;
      block = m === Material.Air ? null : { kind: 'uniform', size, material: m };
    } else {
      const materials = new Uint16Array(n ** 3);
      for (let y = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          for (let x = 0; x < n; x++) materials[gridCellIndex(n, x, y, z)] = layerMaterials[y]!;
        }
      }
      block = { kind: 'grid', size, materials };
    }
    this.rowCache.set(key, block);
    return block;
  }
}
