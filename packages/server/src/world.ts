import {
  CHUNK_SIZE,
  FlatGenerator,
  chunkKey,
  encodeChunk,
  resolveChunk,
  type ChunkCoord,
  type FlatGenConfig,
  type WorldConfig,
} from '@super-vox/shared';

/**
 * Server-side world: generates chunks on demand and keeps recently used
 * encoded chunks in an LRU cache. Nothing is persisted yet; every chunk is
 * regenerated from the config.
 */
export class World {
  private readonly generator: FlatGenerator;
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    readonly config: WorldConfig,
    gen: FlatGenConfig,
    private readonly cacheSize = 4096,
  ) {
    if (config.widthUnits % CHUNK_SIZE !== 0 || config.depthUnits % CHUNK_SIZE !== 0) {
      throw new RangeError('world width and depth must be multiples of the chunk size');
    }
    this.generator = new FlatGenerator(config, gen);
  }

  get gen(): FlatGenConfig {
    return this.generator.gen;
  }

  /** Encoded chunk, or null if the coordinate is outside the world. */
  getEncodedChunk(coord: ChunkCoord): Uint8Array | null {
    const resolved = resolveChunk(this.config, coord);
    if (!resolved) return null;
    const key = chunkKey(resolved);
    const hit = this.cache.get(key);
    if (hit) {
      // Re-insert to mark as most recently used.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const bytes = encodeChunk(this.generator.generateChunk(resolved));
    this.cache.set(key, bytes);
    if (this.cache.size > this.cacheSize) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return bytes;
  }

  get cachedChunkCount(): number {
    return this.cache.size;
  }
}
