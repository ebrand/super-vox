import {
  CHUNK_SIZE,
  NO_GROUND,
  TILE_SAMPLES,
  chunkKey,
  encodeChunk,
  encodeTile,
  resolveChunk,
  tileInWorld,
  tileKey,
  tileSizeUnits,
  tileStep,
  type TileCoord,
  type ChunkCoord,
  type ChunkGenerator,
  type WorldConfig,
} from '@super-vox/shared';

/**
 * Server-side world: generates chunks on demand and keeps recently used
 * encoded chunks in an LRU cache. Nothing is persisted yet; every chunk is
 * regenerated from the config.
 */
export class World {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly tileCache = new Map<string, Uint8Array>();
  readonly spawn: { x: number; y: number; z: number };
  private readonly cacheSize: number;
  /** Adaptive voxelization tolerance, or null for non-adaptive generators. */
  readonly tolerance: number | null;

  constructor(
    readonly config: WorldConfig,
    private readonly generator: ChunkGenerator,
    opts: { cacheSize?: number; tolerance?: number | null } = {},
  ) {
    this.cacheSize = opts.cacheSize ?? 4096;
    this.tolerance = opts.tolerance ?? null;
    if (config.widthUnits % CHUNK_SIZE !== 0 || config.depthUnits % CHUNK_SIZE !== 0) {
      throw new RangeError('world width and depth must be multiples of the chunk size');
    }
    this.spawn = findSpawn(config, generator);
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

  /** Encoded low-detail tile, or null if the tile lies entirely outside the world. */
  getEncodedTile(t: TileCoord): Uint8Array | null {
    if (!tileInWorld(this.config, t)) return null;
    const key = tileKey(t);
    const hit = lruGet(this.tileCache, key);
    if (hit) return hit;
    const size = tileSizeUnits(t.level);
    const step = tileStep(t.level);
    // Sample each cell at its centre column.
    const x0 = t.tx * size + Math.floor(step / 2);
    const z0 = t.tz * size + Math.floor(step / 2);
    const s = this.generator.surfaceSamples(x0, z0, step, TILE_SAMPLES);
    const heights = new Int16Array(TILE_SAMPLES * TILE_SAMPLES);
    for (let j = 0; j < TILE_SAMPLES; j++) {
      for (let i = 0; i < TILE_SAMPLES; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        const outside = (!this.config.wrapX && (x < 0 || x >= this.config.widthUnits)) || z < 0 || z >= this.config.depthUnits;
        heights[i + TILE_SAMPLES * j] = outside ? NO_GROUND : Math.max(-32767, Math.min(32767, s.heights[i + TILE_SAMPLES * j]!));
      }
    }
    const bytes = encodeTile({ ...t, heights, materials: s.materials });
    lruSet(this.tileCache, key, bytes, this.cacheSize);
    return bytes;
  }

  /** Ground height range of a chunk column, or null outside the world. */
  columnRange(cx: number, cz: number): { minY: number; maxY: number } | null {
    const resolved = resolveChunk(this.config, { cx, cy: 0, cz });
    return resolved ? this.generator.columnRange(resolved.cx, resolved.cz) : null;
  }

  get cachedChunkCount(): number {
    return this.cache.size;
  }
}

/** How far from the world's centre to look for a spawn point, and how densely (units). */
const SPAWN_SEARCH_RADIUS = 2000 * 16;
const SPAWN_SEARCH_STEP = 32 * 16;

/**
 * Spawn on the highest ground within SPAWN_SEARCH_RADIUS of the world's
 * centre (so, among hills when there are any). Ties go to the point nearest
 * the centre, so a flat world spawns at its centre.
 */
export function findSpawn(config: WorldConfig, generator: ChunkGenerator): { x: number; y: number; z: number } {
  const cx = config.widthUnits / 2;
  const cz = config.depthUnits / 2;
  const n = Math.floor(SPAWN_SEARCH_RADIUS / SPAWN_SEARCH_STEP);
  const samples: { x: number; z: number; d: number }[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = i * i + j * j;
      if (d > n * n) continue;
      const x = cx + i * SPAWN_SEARCH_STEP;
      const z = cz + j * SPAWN_SEARCH_STEP;
      if (x < 0 || x >= config.widthUnits || z < 0 || z >= config.depthUnits) continue;
      samples.push({ x, z, d });
    }
  }
  samples.sort((a, b) => a.d - b.d);
  let best = { x: cx, y: generator.surfaceHeightAt(cx, cz), z: cz };
  for (const { x, z } of samples) {
    const y = generator.surfaceHeightAt(x, z);
    if (y > best.y) best = { x, y, z };
  }
  return best;
}

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}
