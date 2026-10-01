import {
  CHUNK_SIZE,
  EditError,
  NO_CANOPY,
  encodeClimate,
  NO_GROUND,
  Material,
  BLOCK_SIZE,
  WaterFlow,
  blockHasRoom,
  blockIndex,
  isWater,
  setBlockWater,
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
  type ColumnRange,
  type MaterialId,
  volumeChange,
  type Edit,
  type TileCoord,
  type ChunkCoord,
  type ChunkGenerator,
  type WorldConfig,
  type Tile,
} from '@super-vox/shared';
import type { ChunkStore } from './chunkStore.js';

/** Running totals for monitoring a world. */
export interface WorldStats {
  chunkHits: number;
  chunkMisses: number;
  tileHits: number;
  tileMisses: number;
  /** How long the latest chunks and tiles not in the cache took to make (ms; the last RECENT). */
  recentChunkMs: number[];
  recentTileMs: number[];
  edits: number;
  waterSteps: number;
  /** Blocks whose water changed. */
  waterChanges: number;
}

const RECENT = 200;

function recent(list: number[], v: number): void {
  list.push(v);
  if (list.length > RECENT) list.splice(0, list.length - RECENT);
}

/** 1 m blocks along a chunk's edge. */
const BLOCKS_PER_CHUNK_AXIS = CHUNK_SIZE / BLOCK_SIZE;

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

/** What an edit changed: the new chunks, columns whose height range widened, and how much of each material (see volumeChange). */
export interface EditResult {
  changes: { coord: ChunkCoord; bytes: Uint8Array }[];
  columns: ({ cx: number; cz: number } & ColumnRange)[];
  /** Unit-voxel volume of each material added (positive) or removed (negative). */
  change: Map<MaterialId, number>;
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
  /** Water flowing after edits (see stepWater). */
  private readonly flow = new WaterFlow();
  /** Running totals since the world was opened, for monitoring (see WorldStats). */
  readonly stats: WorldStats = {
    chunkHits: 0, chunkMisses: 0, tileHits: 0, tileMisses: 0,
    recentChunkMs: [], recentTileMs: [],
    edits: 0, waterSteps: 0, waterChanges: 0,
  };

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
    if (hit) {
      this.stats.chunkHits++;
      return hit;
    }
    const t0 = performance.now();
    const bytes = encodeChunk(this.edited.get(key) ?? this.generator.generateChunk(resolved));
    lruSet(this.cache, key, bytes, this.cacheSize);
    this.stats.chunkMisses++;
    recent(this.stats.recentChunkMs, performance.now() - t0);
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
    const result = this.applyEditOnly(edit);
    this.stats.edits++;
    // Water around whatever changed may flow.
    const size = edit.op === 'place' || edit.op === 'removeBox' ? edit.size : 1;
    for (let by = edit.y >> 4; by <= (edit.y + size - 1) >> 4; by++)
      for (let bz = edit.z >> 4; bz <= (edit.z + size - 1) >> 4; bz++)
        for (let bx = edit.x >> 4; bx <= (edit.x + size - 1) >> 4; bx++) this.flow.touch(bx, by, bz);
    return result;
  }

  /** Blocks waiting for water to flow. */
  get waterPending(): number {
    return this.flow.pending;
  }

  /**
   * Lets water flow one step (see WaterFlow), saving the chunks it changed; null if nothing
   * changed. Call a few times a second.
   */
  stepWater(limit = 4096): EditResult | null {
    if (this.flow.pending === 0) return null;
    const working = new Map<string, Chunk>();
    const n = BLOCKS_PER_CHUNK_AXIS;
    const local = (b: number) => ((b % n) + n) % n;
    const chunkOf = (bx: number, by: number, bz: number) => {
      const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
      if (!resolved) return null;
      const key = chunkKey(resolved);
      return { key, chunk: working.get(key) ?? this.current(resolved) };
    };
    const changed = this.flow.step(
      {
        getBlock: (bx, by, bz) => {
          const c = chunkOf(bx, by, bz);
          return c ? c.chunk.blocks[blockIndex(local(bx), local(by), local(bz))] ?? null : undefined;
        },
        setBlock: (bx, by, bz, block) => {
          const c = chunkOf(bx, by, bz);
          if (!c) return;
          const blocks = working.has(c.key) ? c.chunk.blocks : c.chunk.blocks.slice();
          blocks[blockIndex(local(bx), local(by), local(bz))] = block;
          working.set(c.key, { cx: c.chunk.cx, cy: c.chunk.cy, cz: c.chunk.cz, blocks });
        },
      },
      limit,
    );
    this.stats.waterSteps++;
    this.stats.waterChanges += changed.length;
    return changed.length ? this.commit([...working.values()]) : null;
  }

  private applyEditOnly(edit: Edit): EditResult {
    if (edit.op === 'place' && isWater(edit.material)) {
      // Water fills the open space of every 1 m block the cube touches, as a source.
      const next = new Map<string, Chunk>();
      const n = BLOCKS_PER_CHUNK_AXIS;
      for (let by = edit.y >> 4; by <= (edit.y + edit.size - 1) >> 4; by++) {
        for (let bz = edit.z >> 4; bz <= (edit.z + edit.size - 1) >> 4; bz++) {
          for (let bx = edit.x >> 4; bx <= (edit.x + edit.size - 1) >> 4; bx++) {
            const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
            if (!resolved) continue;
            const key = chunkKey(resolved);
            const chunk = next.get(key) ?? this.current(resolved);
            const i = blockIndex(((bx % n) + n) % n, ((by % n) + n) % n, ((bz % n) + n) % n);
            const block = chunk.blocks[i] ?? null;
            if (!blockHasRoom(block)) continue;
            const blocks = chunk.blocks.slice();
            blocks[i] = setBlockWater(block, 0);
            next.set(key, { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, blocks });
          }
        }
      }
      if (next.size === 0) throw new EditError('no room for water there');
      return this.commit([...next.values()]);
    }
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
    const columns = new Map<string, { cx: number; cz: number; before: ColumnRange | null }>();
    for (const c of chunks) {
      const k = `${c.cx},${c.cz}`;
      if (!columns.has(k)) columns.set(k, { cx: c.cx, cz: c.cz, before: this.columnRange(c.cx, c.cz) });
    }
    const before = chunks.map((c) => this.current({ cx: c.cx, cy: c.cy, cz: c.cz }));
    const change = volumeChange(before, chunks);
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
      if (!before || after.minY !== before.minY || after.maxY !== before.maxY || after.solidTop !== before.solidTop) widened.push({ cx, cz, ...after });
    }
    return { changes, columns: widened, change };
  }

  /** Encoded chunks and tiles held in the caches, and how many each may hold. */
  get cacheUse(): { chunks: number; tiles: number; capacity: number } {
    return { chunks: this.cache.size, tiles: this.tileCache.size, capacity: this.cacheSize };
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
    if (hit) {
      this.stats.tileHits++;
      return hit;
    }
    const t0 = performance.now();
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
    // Forest canopy, if any, floats above the ground.
    let canopy: Pick<Tile, 'canopyTop' | 'canopyBottom' | 'canopyMaterials'> = {};
    if (s.canopy) {
      const top = new Int16Array(TILE_SAMPLES * TILE_SAMPLES).fill(NO_GROUND), bottom = new Int16Array(TILE_SAMPLES * TILE_SAMPLES).fill(NO_GROUND);
      for (let k = 0; k < top.length; k++) {
        if (s.canopy.top[k] === NO_CANOPY || heights[k] === NO_GROUND) continue;
        top[k] = Math.max(-32767, Math.min(32767, s.canopy.top[k]!));
        bottom[k] = Math.max(-32767, Math.min(32767, s.canopy.bottom[k]!));
      }
      canopy = { canopyTop: top, canopyBottom: bottom, canopyMaterials: s.canopy.material };
    }
    // Rivers and lakes, over the ground.
    let water: Int16Array | undefined;
    if (s.water) {
      water = new Int16Array(TILE_SAMPLES * TILE_SAMPLES).fill(NO_GROUND);
      for (let k = 0; k < water.length; k++) if (s.water[k]! > s.heights[k]! && heights[k] !== NO_GROUND) water[k] = Math.max(-32767, Math.min(32767, s.water[k]!));
    }
    const bytes = encodeTile({ ...t, heights, materials: s.materials, ...canopy, ...(water ? { water } : {}) });
    lruSet(this.tileCache, key, bytes, this.cacheSize);
    this.stats.tileMisses++;
    recent(this.stats.recentTileMs, performance.now() - t0);
    return bytes;
  }

  /**
   * Whether any 1 m block within `reach` units (Chebyshev) of (x, y, z) holds `material` (e.g. a
   * crafting table near a player). Looks at generated or edited chunks as they are now.
   */
  materialNear(x: number, y: number, z: number, reach: number, material: MaterialId): boolean {
    const n = BLOCKS_PER_CHUNK_AXIS;
    const b0 = (v: number) => Math.floor((v - reach) / BLOCK_SIZE), b1 = (v: number) => Math.floor((v + reach) / BLOCK_SIZE);
    for (let cy = Math.floor(b0(y) / n); cy <= Math.floor(b1(y) / n); cy++)
      for (let cz = Math.floor(b0(z) / n); cz <= Math.floor(b1(z) / n); cz++)
        for (let cx = Math.floor(b0(x) / n); cx <= Math.floor(b1(x) / n); cx++) {
          const resolved = resolveChunk(this.config, { cx, cy, cz });
          if (!resolved) continue;
          const chunk = this.current(resolved);
          for (let by = Math.max(0, b0(y) - cy * n); by <= Math.min(n - 1, b1(y) - cy * n); by++)
            for (let bz = Math.max(0, b0(z) - cz * n); bz <= Math.min(n - 1, b1(z) - cz * n); bz++)
              for (let bx = Math.max(0, b0(x) - cx * n); bx <= Math.min(n - 1, b1(x) - cx * n); bx++) {
                const b = chunk.blocks[blockIndex(bx, by, bz)];
                if (!b) continue;
                if (b.kind === 'uniform' ? b.material === material : b.materials.includes(material)) return true;
              }
        }
    return false;
  }

  /** Ground height range of a chunk column, or null outside the world. */
  columnRange(cx: number, cz: number): ColumnRange | null {
    const resolved = resolveChunk(this.config, { cx, cy: 0, cz });
    if (!resolved) return null;
    const range = this.generator.columnRange(resolved.cx, resolved.cz);
    const span = this.editSpans.get(`${resolved.cx},${resolved.cz}`);
    if (!span) return range;
    // Edited layers count as solid: whatever was built (or flowed) there is drawn.
    const out: ColumnRange = { minY: Math.min(range.minY, span.minY), maxY: Math.max(range.maxY, span.maxY) };
    if (range.water && range.solidTop !== undefined) {
      out.solidTop = Math.max(range.solidTop, span.maxY);
      out.water = { ...range.water };
    }
    return out;
  }

  private climateBytes: Uint8Array | null | undefined;

  /** The climate for blending biome colours (see encodeClimate), or null where biomes don't blend. */
  getEncodedClimate(): Uint8Array | null {
    if (this.climateBytes === undefined) {
      const c = this.generator.climate?.() ?? null;
      this.climateBytes = c ? encodeClimate(c) : null;
    }
    return this.climateBytes;
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
        // The map shows forests from above (their canopy), and rivers and lakes as water.
        const k = i + n * j, tree = s.canopy && s.canopy.top[k] !== NO_CANOPY;
        const wet = s.water && s.water[k]! > s.heights[k]!;
        heights[i + cols * j] = Math.max(-32767, Math.min(32767, wet ? s.water![k]! : tree ? s.canopy!.top[k]! : s.heights[k]!));
        materials[i + cols * j] = Math.min(255, wet ? Material.Water : tree ? s.canopy!.material[k]! : s.materials[k]!);
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
