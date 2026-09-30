import {
  CHUNK_SIZE,
  EditError,
  NO_GROUND,
  applyEdit,
  decodeChunk,
  editChunk,
  removeBoxChunks,
  removeBoxFromChunk,
  splitPlacement,
  validateRemoveBox,
  normalizeX,
  TILE_SAMPLES,
  chunkKey,
  encodeChunk,
  encodeTile,
  resolveChunk,
  tileInWorld,
  tileKey,
  tileSizeUnits,
  tileStep,
  type Chunk,
  type Edit,
  type TileCoord,
  type ChunkCoord,
  type ChunkGenerator,
  type WorldConfig,
} from '@super-vox/shared';
import type { ChunkStore } from './chunkStore.js';

/** Surface samples covering the whole world (see World.getMap). */
export interface WorldMap {
  cols: number;
  rows: number;
  /** Units between samples. */
  step: number;
  seaLevel: number | null;
  heights: Int16Array;
  materials: Uint8Array;
}

/**
 * Binary map format (little-endian): u16 cols, u16 rows, u32 step (units),
 * i32 sea level (-2^31 = no sea), then cols*rows i16 heights, then cols*rows
 * u8 materials, row-major (x fastest).
 */
export function encodeWorldMap(m: WorldMap): Uint8Array {
  const n = m.cols * m.rows;
  const buf = new Uint8Array(12 + n * 3);
  const v = new DataView(buf.buffer);
  v.setUint16(0, m.cols, true);
  v.setUint16(2, m.rows, true);
  v.setUint32(4, m.step, true);
  v.setInt32(8, m.seaLevel ?? -(2 ** 31), true);
  for (let i = 0; i < n; i++) v.setInt16(12 + i * 2, m.heights[i]!, true);
  buf.set(m.materials, 12 + n * 2);
  return buf;
}

/** What an edit changed: the new chunks, and columns whose height range widened. */
export interface EditResult {
  changes: { coord: ChunkCoord; bytes: Uint8Array }[];
  columns: { cx: number; cz: number; minY: number; maxY: number }[];
}

/**
 * Server-side world: generates chunks on demand and keeps recently used
 * encoded chunks in an LRU cache. Nothing is persisted yet; every chunk is
 * regenerated from the config.
 */
export class World {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly tileCache = new Map<string, Uint8Array>();
  private readonly maps = new Map<number, WorldMap>();
  /** Chunks changed by edits; these replace generated chunks and are never evicted. */
  private readonly edited = new Map<string, Chunk>();
  /** Per chunk column ("cx,cz"), the vertical span of edited chunks (units). */
  private readonly editSpans = new Map<string, { minY: number; maxY: number }>();
  private readonly store: ChunkStore | null;
  readonly spawn: { x: number; y: number; z: number };
  private readonly cacheSize: number;
  /** Adaptive voxelization tolerance, or null for non-adaptive generators. */
  readonly tolerance: number | null;
  /** Sea level (units), or null without a sea. */
  readonly seaLevel: number | null;

  constructor(
    readonly config: WorldConfig,
    private readonly generator: ChunkGenerator,
    opts: { cacheSize?: number; tolerance?: number | null; store?: ChunkStore } = {},
  ) {
    this.cacheSize = opts.cacheSize ?? 4096;
    this.tolerance = opts.tolerance ?? null;
    this.store = opts.store ?? null;
    for (const { coord, bytes } of this.store?.loadAll() ?? []) {
      const chunk = decodeChunk(bytes);
      if (chunk.cx !== coord.cx || chunk.cy !== coord.cy || chunk.cz !== coord.cz) {
        throw new Error(`stored chunk ${chunkKey(coord)} contains chunk ${chunkKey(chunk)}`);
      }
      this.recordEdited(chunk);
    }
    if (config.widthUnits % CHUNK_SIZE !== 0 || config.depthUnits % CHUNK_SIZE !== 0) {
      throw new RangeError('world width and depth must be multiples of the chunk size');
    }
    this.seaLevel = generator.seaLevel;
    this.spawn = findSpawn(config, generator);
  }

  /** Encoded chunk, or null if the coordinate is outside the world. */
  getEncodedChunk(coord: ChunkCoord): Uint8Array | null {
    const resolved = resolveChunk(this.config, coord);
    if (!resolved) return null;
    const key = chunkKey(resolved);
    const hit = lruGet(this.cache, key);
    if (hit) return hit;
    const bytes = encodeChunk(this.edited.get(key) ?? this.generator.generateChunk(resolved));
    lruSet(this.cache, key, bytes, this.cacheSize);
    return bytes;
  }

  /**
   * Applies an edit and returns the chunks it changed (one, or up to eight
   * for a removeBox or a placement crossing chunk borders) plus any column
   * whose height range widened. Throws
   * EditError, changing nothing, if the edit is invalid, outside the world,
   * or (for removeBox) removes nothing.
   */
  applyEdit(edit: Edit): EditResult {
    if (edit.op === 'removeBox') {
      validateRemoveBox(edit);
      const changed: Chunk[] = [];
      for (const c of removeBoxChunks(edit)) {
        const resolved = resolveChunk(this.config, c);
        if (!resolved) continue;
        // On a wrapping world the box may cross the seam: shift it into this chunk's copy of X.
        const shift = (resolved.cx - c.cx) * CHUNK_SIZE;
        const next = removeBoxFromChunk(this.current(resolved), { ...edit, x: edit.x + shift });
        if (next) changed.push(next);
      }
      if (changed.length === 0) throw new EditError('nothing to remove there');
      return this.commit(changed);
    }
    if (edit.op === 'place') {
      // Cubes that cross 1 m gridlines are placed as block-sized pieces; all or nothing.
      const next = new Map<string, Chunk>();
      for (const piece of splitPlacement(edit)) {
        const p = { ...edit, ...piece, x: normalizeX(this.config, piece.x) };
        const resolved = resolveChunk(this.config, editChunk(p));
        if (!resolved) throw new EditError('outside the world');
        const key = chunkKey(resolved);
        next.set(key, applyEdit(next.get(key) ?? this.current(resolved), p));
      }
      return this.commit([...next.values()]);
    }
    const e = { ...edit, x: normalizeX(this.config, edit.x) };
    const resolved = resolveChunk(this.config, editChunk(e));
    if (!resolved) throw new EditError('outside the world');
    return this.commit([applyEdit(this.current(resolved), e)]);
  }

  private current(coord: ChunkCoord): Chunk {
    return this.edited.get(chunkKey(coord)) ?? this.generator.generateChunk(coord);
  }

  /** Stores, caches, and saves edited chunks; reports widened column ranges. */
  private commit(chunks: Chunk[]): EditResult {
    const columns = new Map<string, { cx: number; cz: number; before: { minY: number; maxY: number } | null }>();
    for (const c of chunks) {
      const k = `${c.cx},${c.cz}`;
      if (!columns.has(k)) columns.set(k, { cx: c.cx, cz: c.cz, before: this.columnRange(c.cx, c.cz) });
    }
    const changes = chunks.map((chunk) => {
      this.recordEdited(chunk);
      const coord = { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz };
      const bytes = encodeChunk(chunk);
      lruSet(this.cache, chunkKey(coord), bytes, this.cacheSize);
      this.store?.save(coord, bytes);
      return { coord, bytes };
    });
    const widened: EditResult['columns'] = [];
    for (const { cx, cz, before } of columns.values()) {
      const after = this.columnRange(cx, cz)!;
      if (!before || after.minY !== before.minY || after.maxY !== before.maxY) widened.push({ cx, cz, ...after });
    }
    return { changes, columns: widened };
  }

  get editedChunkCount(): number {
    return this.edited.size;
  }

  private recordEdited(chunk: Chunk): void {
    this.edited.set(chunkKey(chunk), chunk);
    // Render the whole edited chunk layer: edits can raise or dig anywhere in it.
    const col = `${chunk.cx},${chunk.cz}`;
    const span = this.editSpans.get(col);
    const minY = chunk.cy * CHUNK_SIZE, maxY = (chunk.cy + 1) * CHUNK_SIZE;
    this.editSpans.set(col, { minY: Math.min(minY, span?.minY ?? minY), maxY: Math.max(maxY, span?.maxY ?? maxY) });
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
    if (!resolved) return null;
    const range = this.generator.columnRange(resolved.cx, resolved.cz);
    const span = this.editSpans.get(`${resolved.cx},${resolved.cz}`);
    return span ? { minY: Math.min(range.minY, span.minY), maxY: Math.max(range.maxY, span.maxY) } : range;
  }

  /**
   * A top-down map of generated terrain (edits aren't included): `cols` x
   * `rows` surface samples, one per `step` units at each cell's centre.
   * Cached per requested width.
   */
  getMap(width: number): WorldMap {
    const hit = this.maps.get(width);
    if (hit) return hit;
    const step = Math.ceil(this.config.widthUnits / width);
    const cols = Math.ceil(this.config.widthUnits / step);
    const rows = Math.ceil(this.config.depthUnits / step);
    const n = Math.max(cols, rows);
    const s = this.generator.surfaceSamples(Math.floor(step / 2), Math.floor(step / 2), step, n);
    const heights = new Int16Array(cols * rows);
    const materials = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        heights[i + cols * j] = Math.max(-32767, Math.min(32767, s.heights[i + n * j]!));
        materials[i + cols * j] = Math.min(255, s.materials[i + n * j]!);
      }
    }
    const map = { cols, rows, step, seaLevel: this.seaLevel, heights, materials };
    this.maps.set(width, map);
    return map;
  }

  get cachedChunkCount(): number {
    return this.cache.size;
  }
}

/** How far around the chosen land to look for high ground, and how densely (units). */
const SPAWN_SEARCH_RADIUS = 1000 * 16;
const SPAWN_SEARCH_STEP = 32 * 16;
/** Sampling step when searching the whole world for land (units). */
const LAND_SEARCH_STEP = 128 * 16;

/**
 * Spawn on land: find the land nearest the world's centre (anywhere, if
 * there's no sea every point is land), then the highest ground within
 * SPAWN_SEARCH_RADIUS of it. Ties go to the point nearest the centre, so a
 * flat world spawns at its centre. A world with no land at all spawns at the
 * centre.
 */
export function findSpawn(config: WorldConfig, generator: ChunkGenerator): { x: number; y: number; z: number } {
  const cx = config.widthUnits / 2;
  const cz = config.depthUnits / 2;
  const sea = generator.seaLevel;
  const isLand = (y: number) => sea === null || y > sea + 16;

  // 1. The land sample nearest the centre (the centre itself if it's land).
  let anchor = { x: cx, z: cz };
  if (!isLand(generator.surfaceHeightAt(cx, cz))) {
    let best = Infinity;
    const cols = Math.floor(config.widthUnits / LAND_SEARCH_STEP), rows = Math.floor(config.depthUnits / LAND_SEARCH_STEP);
    const H = generator.surfaceSamples(LAND_SEARCH_STEP / 2, LAND_SEARCH_STEP / 2, LAND_SEARCH_STEP, Math.max(cols, rows)).heights;
    const n = Math.max(cols, rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!isLand(H[i + n * j]!)) continue;
        const x = LAND_SEARCH_STEP / 2 + i * LAND_SEARCH_STEP, z = LAND_SEARCH_STEP / 2 + j * LAND_SEARCH_STEP;
        const d = (x - cx) ** 2 + (z - cz) ** 2;
        if (d < best) [best, anchor] = [d, { x, z }];
      }
    }
  }

  // 2. The highest land within the search radius of it, nearest first so ties keep the anchor.
  const n = Math.floor(SPAWN_SEARCH_RADIUS / SPAWN_SEARCH_STEP);
  const samples: { x: number; z: number; d: number }[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = i * i + j * j;
      if (d > n * n) continue;
      const x = anchor.x + i * SPAWN_SEARCH_STEP;
      const z = anchor.z + j * SPAWN_SEARCH_STEP;
      if (x < 0 || x >= config.widthUnits || z < 0 || z >= config.depthUnits) continue;
      samples.push({ x, z, d });
    }
  }
  samples.sort((a, b) => a.d - b.d);
  let best = { x: anchor.x, y: generator.surfaceHeightAt(anchor.x, anchor.z), z: anchor.z };
  for (const { x, z } of samples) {
    const y = generator.surfaceHeightAt(x, z);
    if (isLand(y) && y > best.y) best = { x, y, z };
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
