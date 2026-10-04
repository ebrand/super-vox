import {
  surfaceMap,
  CHUNK_SIZE,
  EditError,
  NO_CANOPY,
  encodeClimate,
  NO_GROUND,
  Material,
  BLOCK_SIZE,
  PouredWater,
  blockWaterTop,
  setPouredWater,
  waterAmount,
  waterCapacity,
  waterKind,
  blockHasRoom,
  blockIndex,
  isWater,
  isExplosive,
  craterShape,
  materialNearIn,
  setBlockWater,
  applyEdit,
  decodeChunk,
  editChunk,
  removeBoxChunks,
  removeBoxFromChunk,
  fillBoxInChunk,
  isObjectMaterial,
  opens,
  validateFillBox,
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
  type Block,
  materialAt,
  type Chunk,
  type ColumnRange,
  type Facing,
  type ObjectKind,
  type PlacedObject,
  FACINGS,
  FACING_STEP,
  blockFromVoxels,
  blockVoxelContaining,
  deltaX,
  blocksLight,
  LIGHT_LEVEL,
  lightAt,
  SKY_LIGHT_LEVEL,
  type LightWorld,
  type BlockVoxel,
  blockVoxels,
  editMiningTime,
  fenceJoins,
  objectBlocks,
  fitTorch,
  isTorchVoxel,
  objectHeight,
  objectCells,
  objectStation,
  emptyStation,
  isStationKind,
  isStationState,
  type StationKind,
  type StationState,
  isBed,
  liftOut,
  playerBox,
  PLAYER,
  type DesignRole,
  objectName,
  designById,
  designOrigin,
  designSpan,
  type ObjectDesign,
  withoutWater,
  type MaterialId,
  type ItemId,
  volumeChange,
  type Edit,
  type TileCoord,
  type ChunkCoord,
  type ChunkGenerator,
  type WorldConfig,
  type Tile,
} from '@super-vox/shared';
import type { ChunkStore } from './chunkStore.js';

/** An explosive voxel (TNT, C4): its corner and size (units), and material. */
export interface Explosive {
  x: number;
  y: number;
  z: number;
  size: number;
  material: MaterialId;
}
import type { DiskCache } from './diskCache.js';

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

const mod = (v: number, m: number) => ((v % m) + m) % m;
/** What a sword cuts. */
const LEAVES = new Set<number>([Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves]);
const objectKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** One edit's results after another's (later chunks win). */
function mergeResults(a: EditResult, b: EditResult): EditResult {
  const change = new Map(a.change);
  for (const [m, d] of b.change) change.set(m, (change.get(m) ?? 0) + d);
  return { changes: [...a.changes, ...b.changes], columns: [...a.columns, ...b.columns], change };
}

/** The unit box an edit touches. */
function editBounds(edit: Edit): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } {
  const size = edit.op === 'place' || edit.op === 'removeBox' || edit.op === 'fillBox' ? edit.size : 1;
  return { x0: edit.x, y0: edit.y, z0: edit.z, x1: edit.x + size, y1: edit.y + size, z1: edit.z + size };
}

/** Whether two cubes (corner and size, units) share part of a face: touching on one axis, overlapping (not just at an edge) on the other two. */
function sharesFace(a: { x: number; y: number; z: number; size: number }, b: { x: number; y: number; z: number; size: number }): boolean {
  const lo = [a.x, a.y, a.z], blo = [b.x, b.y, b.z];
  let touching = 0;
  for (let k = 0; k < 3; k++) {
    const a0 = lo[k]!, a1 = a0 + a.size, b0 = blo[k]!, b1 = b0 + b.size;
    if (a1 === b0 || b1 === a0) touching++;
    else if (Math.min(a1, b1) - Math.max(a0, b0) <= 0) return false;
  }
  return touching === 1;
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
/** Makes a world's generated chunks, tiles and column ranges elsewhere (see GenPool): `ms`, how long they took. */
export interface RemoteGenerator {
  /** (`buildMs`: what building the world's generator took first, if it had to.) */
  chunk(coord: ChunkCoord): Promise<{ bytes: Uint8Array; ms: number; buildMs?: number }>;
  tile(t: TileCoord): Promise<{ bytes: Uint8Array; ms: number }>;
  column(cx: number, cz: number): Promise<ColumnRange>;
}

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
  /** Poured water moving after edits and pours (see stepWater). */
  private readonly flow = new PouredWater();
  /** Decoded chunks recently looked at by solidAt (mobs walking about), oldest first. */
  private readonly decoded = new Map<string, Chunk>();
  /** Placed objects (fences, gates, doors, designs) by their bottom block, "bx,by,bz" (block X in the world's range). */
  private readonly objects = new Map<string, PlacedObject>();
  /** What's in each furnace and stove (see stations.ts), by its origin block (objectKey). */
  private readonly stations = new Map<string, StationState>();
  /** Every block a placed object takes (see objectCells), "bx,by,bz", to the object. */
  private readonly cells = new Map<string, PlacedObject>();
  /** Told whenever objects are placed, taken down or change (to tell players about designs: see designObjects). */
  onObjectsChanged: (() => void) | null = null;
  /** Running totals since the world was opened, for monitoring (see WorldStats). */
  readonly stats: WorldStats = {
    chunkHits: 0, chunkMisses: 0, tileHits: 0, tileMisses: 0,
    recentChunkMs: [], recentTileMs: [],
    edits: 0, waterSteps: 0, waterChanges: 0,
  };

  /** Where generated chunks, tiles and column ranges are made off the main thread (see GenPool), or null: here. */
  private readonly remote: RemoteGenerator | null;
  /** Generated terrain kept on disk (see DiskCache), or null. */
  readonly disk: DiskCache | null;
  /** Requests on their way from `remote`, by key (players asking for the same thing share one). */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    readonly config: WorldConfig,
    private readonly generator: ChunkGenerator,
    opts: { cacheSize?: number; tolerance?: number | null; store?: ChunkStore; remote?: RemoteGenerator; disk?: DiskCache } = {},
  ) {
    this.remote = opts.remote ?? null;
    this.disk = opts.disk ?? null;
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
    for (const o of this.store?.loadObjects?.() ?? []) this.addObject(o);
    for (const [k, s] of Object.entries(this.store?.loadStations?.() ?? {})) if (isStationState(s) && this.objects.has(k)) this.stations.set(k, s);
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
   * As getEncodedChunk, but from the disk cache if it's there, else made off the main thread
   * where the world has a remote generator (a promise; what's to hand, cached in memory or edited,
   * comes at once). An edit landing meanwhile wins: the edited chunk is what's returned (and cached).
   */
  encodedChunk(coord: ChunkCoord): Uint8Array | null | Promise<Uint8Array | null> {
    const resolved = resolveChunk(this.config, coord);
    if (!resolved || (!this.remote && !this.disk)) return this.getEncodedChunk(coord);
    const key = chunkKey(resolved);
    if (this.cache.has(key) || this.edited.has(key)) return this.getEncodedChunk(coord);
    const { cx, cy, cz } = resolved;
    return this.share(`c:${key}`, async () => {
      const t0 = performance.now();
      let bytes = this.disk ? await this.disk.chunk(cx, cy, cz) : null;
      let ms = performance.now() - t0;
      if (!bytes) {
        if (this.remote) ({ bytes, ms } = await this.remote.chunk(resolved));
        else bytes = encodeChunk(this.generator.generateChunk(resolved));
        this.disk?.putChunk(cx, cy, cz, bytes);
      }
      if (this.edited.has(key)) return this.getEncodedChunk(resolved);
      lruSet(this.cache, key, bytes, this.cacheSize);
      this.stats.chunkMisses++;
      recent(this.stats.recentChunkMs, ms);
      return bytes;
    });
  }

  /**
   * Gets ready the chunks within `reach` (units) of (x, y, z) that aren't to hand: made off the main
   * thread (or read from disk) and cached, so what then reads them (a blast that's coming: see
   * Explosives.light) only decodes them. Nothing where there's no other thread or disk to do it.
   */
  prefetch(x: number, y: number, z: number, reach: number): number {
    if (!this.remote && !this.disk) return 0;
    let asked = 0;
    const n = CHUNK_SIZE;
    for (let cy = Math.floor((y - reach) / n); cy <= Math.floor((y + reach) / n); cy++) {
      for (let cz = Math.floor((z - reach) / n); cz <= Math.floor((z + reach) / n); cz++) {
        for (let cx = Math.floor((x - reach) / n); cx <= Math.floor((x + reach) / n); cx++) {
          const resolved = resolveChunk(this.config, { cx, cy, cz });
          if (!resolved) continue;
          const key = chunkKey(resolved);
          if (this.cache.has(key) || this.edited.has(key)) continue;
          const got = this.encodedChunk(resolved);
          if (got instanceof Promise) got.catch(() => {}); // (if it fails, the blast makes it itself)
          asked++;
        }
      }
    }
    return asked;
  }

  /** As getEncodedTile, from the disk cache or made off the main thread (as encodedChunk). */
  encodedTile(t: TileCoord): Uint8Array | null | Promise<Uint8Array | null> {
    if (!tileInWorld(this.config, t) || (!this.remote && !this.disk)) return this.getEncodedTile(t);
    const key = tileKey(t);
    if (this.tileCache.has(key)) return this.getEncodedTile(t);
    return this.share(`t:${key}`, async () => {
      const t0 = performance.now();
      let bytes = this.disk ? await this.disk.tile(t.level, t.tx, t.tz) : null;
      let ms = performance.now() - t0;
      if (!bytes) {
        if (this.remote) ({ bytes, ms } = await this.remote.tile(t));
        else bytes = tileBytes(this.generator, this.config, t);
        this.disk?.putTile(t.level, t.tx, t.tz, bytes);
      }
      lruSet(this.tileCache, key, bytes, this.cacheSize);
      this.stats.tileMisses++;
      recent(this.stats.recentTileMs, ms);
      return bytes;
    });
  }

  /** As columnRange, from the disk cache or worked out off the main thread (a promise). */
  columnRangeOf(cx: number, cz: number): ColumnRange | null | Promise<ColumnRange | null> {
    const resolved = resolveChunk(this.config, { cx, cy: 0, cz });
    if (!resolved || (!this.remote && !this.disk)) return this.columnRange(cx, cz);
    const { cx: x, cz: z } = resolved;
    return this.share(`k:${x},${z}`, async () => {
      let range = this.disk ? await this.disk.column<ColumnRange>(x, z) : null;
      if (!range) {
        range = this.remote ? await this.remote.column(x, z) : this.generator.columnRange(x, z);
        this.disk?.putColumn(x, z, range);
      }
      return range;
    }).then((range) => this.withEdits(x, z, range));
  }

  /** One request at a time for each thing (later askers wait for the first). */
  private share<T>(key: string, make: () => Promise<T>): Promise<T> {
    const on = this.pending.get(key) as Promise<T> | undefined;
    if (on) return on;
    const p = make().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /**
   * Applies an edit and returns the chunks it changed (one, or up to eight
   * for a removeBox or a placement crossing chunk borders) plus any column
   * whose height range widened. Throws
   * EditError, changing nothing, if the edit is invalid, outside the world,
   * or (for removeBox) removes nothing.
   */
  applyEdit(edit: Edit): EditResult {
    const held = this.objectIn(editBounds(edit));
    if (held) throw new EditError(`that's a ${objectName(held)}: left-click takes it down`);
    const result = this.applyEditOnly(edit);
    this.stats.edits++;
    // Water around whatever changed may flow, and the sea fills what was opened beside it.
    const size = edit.op === 'place' || edit.op === 'removeBox' || edit.op === 'fillBox' ? edit.size : 1;
    const touched: [number, number, number][] = [];
    for (let by = edit.y >> 4; by <= (edit.y + size - 1) >> 4; by++)
      for (let bz = edit.z >> 4; bz <= (edit.z + size - 1) >> 4; bz++)
        for (let bx = edit.x >> 4; bx <= (edit.x + size - 1) >> 4; bx++) {
          this.flow.touch(bx, by, bz);
          touched.push([bx, by, bz]);
        }
    const refill = this.refillFromNatural(touched);
    return refill ? mergeResults(result, refill) : result;
  }

  /**
   * Places small voxels (debris come to rest; each inside one 1 m block) all at once: each where it
   * is, else one step (its size) up, else not at all. One commit for the lot (placing them one by
   * one re-encodes a chunk for each); null if none went in.
   */
  placeMany(voxels: readonly { x: number; y: number; z: number; size: number; material: MaterialId }[]): EditResult | null {
    const next = new Map<string, Chunk>();
    const touched = new Map<string, [number, number, number]>();
    for (const v of voxels) {
      for (const y of [v.y, v.y + v.size]) {
        const e: Edit = { op: 'place', x: normalizeX(this.config, v.x), y, z: v.z, size: v.size, material: v.material };
        if (this.objectIn(editBounds(e))) continue;
        const resolved = resolveChunk(this.config, editChunk(e));
        if (!resolved) break;
        const key = chunkKey(resolved);
        try {
          next.set(key, applyEdit(next.get(key) ?? this.current(resolved), e));
        } catch (err) {
          if (err instanceof EditError) continue; // taken (or not a valid place): a step up, or not at all
          throw err;
        }
        const b: [number, number, number] = [e.x >> 4, y >> 4, e.z >> 4];
        touched.set(b.join(), b);
        break;
      }
    }
    if (next.size === 0) return null;
    this.stats.edits++;
    for (const [bx, by, bz] of touched.values()) this.flow.touch(bx, by, bz);
    const result = this.commit([...next.values()]);
    const refill = this.refillFromNatural([...touched.values()]);
    return refill ? mergeResults(result, refill) : result;
  }

  /**
   * Natural water (the sea, lakes, rivers) fills open space opened beside it, at once: dry,
   * open blocks among `seeds` (and, from those, connected open blocks) next to natural water
   * (beside it: up to its surface; under it: all the way) fill with it. Natural water never runs
   * across the land or drains, so only digging (or building) next to it lets it in. At most
   * `limit` blocks an edit (the rest wait for another edit nearby).
   */
  private refillFromNatural(seeds: [number, number, number][], limit = 512): EditResult | null {
    const writes = new Map<string, { bx: number; by: number; bz: number; block: Block }>();
    const top = (x: number, y: number, z: number) => {
      const w = writes.get(`${x},${y},${z}`);
      const b = w ? w.block : this.blockAt(x, y, z);
      return b !== undefined && waterKind(b) === 'natural' ? blockWaterTop(b) : 0;
    };
    const queue = [...seeds], seen = new Set<string>();
    while (queue.length && writes.size < limit) {
      const [x, y, z] = queue.shift()!;
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const block = this.blockAt(x, y, z);
      if (block === undefined || !blockHasRoom(block) || waterKind(block) !== null || this.objectAt(x, y, z)) continue;
      const level = top(x, y + 1, z) > 0 ? 16 : Math.max(...FACINGS.map((f) => top(x + FACING_STEP[f][0], y, z + FACING_STEP[f][1])));
      if (level <= 0) continue;
      writes.set(key, { bx: x, by: y, bz: z, block: setBlockWater(block, 0, level) });
      for (const f of FACINGS) queue.push([x + FACING_STEP[f][0], y, z + FACING_STEP[f][1]]);
      queue.push([x, y - 1, z]);
    }
    return writes.size ? this.writeBlocks([...writes.values()]) : null;
  }

  /** Blocks waiting for water to flow. */
  get waterPending(): number {
    return this.flow.pending;
  }

  /**
   * Lets poured water move one step (see PouredWater), saving the chunks it changed; null if nothing
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
      // Water (poured: finite, see PouredWater) fills the open space of every 1 m block the cube touches.
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
            if (!blockHasRoom(block) || waterKind(block) === 'natural') continue;
            const blocks = chunk.blocks.slice();
            blocks[i] = setPouredWater(block, 16);
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
    if (edit.op === 'fillBox') {
      validateFillBox(edit);
      if (isObjectMaterial(edit.material)) throw new EditError("fences, gates, doors and crafting tables aren't filled in boxes");
      const changed: Chunk[] = [];
      for (const c of removeBoxChunks(edit)) {
        const resolved = resolveChunk(this.config, c);
        if (!resolved) continue;
        const shift = (resolved.cx - c.cx) * CHUNK_SIZE;
        const next = fillBoxInChunk(this.current(resolved), { ...edit, x: edit.x + shift });
        if (next) changed.push(next);
      }
      if (changed.length === 0) throw new EditError('outside the world');
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

  /**
   * Seconds a survival player takes to mine what an edit removes (see mining.ts): the voxel at a
   * point, or everything in a box, with `tool` (null: by hand); 0 for nothing there (or outside the world).
   */
  miningTime(edit: { op: 'remove'; x: number; y: number; z: number } | { op: 'removeBox'; x: number; y: number; z: number; size: number }, tool: ItemId | null = null): number {
    return editMiningTime(
      edit,
      (cx, cy, cz) => {
        const resolved = resolveChunk(this.config, { cx, cy, cz });
        return resolved ? this.current(resolved) : null;
      },
      tool,
    );
  }

  private current(coord: ChunkCoord): Chunk {
    const key = chunkKey(coord);
    const edited = this.edited.get(key);
    if (edited) return edited;
    // Already made (sent to someone): decoding it is about ten times quicker than making it again.
    const bytes = this.cache.get(key);
    return bytes ? decodeChunk(bytes) : this.generator.generateChunk(coord);
  }

  /** Stores, caches, and saves edited chunks; reports widened column ranges. */
  /** The last chunk materialAtUnit looked at (most lookups land in the same one as the last). */
  private last: { cx: number; cy: number; cz: number; chunk: Chunk | null } | null = null;

  /** The material of the unit cell (world units), from recently looked-at chunks (mobs walking about); undefined outside the world. */
  materialAtUnit(x: number, y: number, z: number): number | undefined {
    const n = CHUNK_SIZE;
    const cx = Math.floor(x / n), cy = Math.floor(y / n), cz = Math.floor(z / n);
    const last = this.last;
    let chunk: Chunk | null;
    if (last && last.cx === cx && last.cy === cy && last.cz === cz) chunk = last.chunk;
    else {
      const resolved = resolveChunk(this.config, { cx, cy, cz });
      if (!resolved) chunk = null;
      else {
        const key = chunkKey(resolved);
        const hit = this.decoded.get(key);
        if (hit) {
          this.decoded.delete(key);
          chunk = hit;
        } else {
          chunk = this.current(resolved);
          if (this.decoded.size >= 256) this.decoded.delete(this.decoded.keys().next().value!);
        }
        this.decoded.set(key, chunk);
      }
      this.last = { cx, cy, cz, chunk };
    }
    if (!chunk) return undefined;
    return materialAt(chunk, x - cx * n, y - cy * n, z - cz * n);
  }

  /** Whether the unit cell (world units) is solid (not air, not water); outside the world counts as solid. */
  readonly solidAt = (x: number, y: number, z: number): boolean => {
    const m = this.materialAtUnit(Math.floor(x), Math.floor(y), Math.floor(z));
    return m === undefined || (m !== 0 && !isWater(m));
  };

  private commit(chunks: Chunk[]): EditResult {
    for (const c of chunks) this.decoded.delete(chunkKey(c));
    this.last = null;
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

  /**
   * The chunk columns players have built in: those with edited chunks (blocks placed or dug,
   * water poured, leaves cut) or placed objects. Terraforming keeps clear of them.
   */
  protectedColumns(): { cx: number; cz: number }[] {
    const keys = new Set(this.editSpans.keys());
    for (const o of this.objects.values())
      for (const [x, , z] of this.objectBlocksAt(o)) keys.add(`${Math.floor((x * BLOCK_SIZE) / CHUNK_SIZE)},${Math.floor((z * BLOCK_SIZE) / CHUNK_SIZE)}`);
    return [...keys].map((k) => {
      const [cx, cz] = k.split(',').map(Number);
      return { cx: cx!, cz: cz! };
    });
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
    const bytes = tileBytes(this.generator, this.config, t);
    lruSet(this.tileCache, key, bytes, this.cacheSize);
    this.stats.tileMisses++;
    recent(this.stats.recentTileMs, performance.now() - t0);
    return bytes;
  }

  /** Block X in the world's range (round worlds wrap). */
  private wrapBlockX(bx: number): number {
    const n = this.config.widthUnits / BLOCK_SIZE;
    return this.config.wrapX ? ((bx % n) + n) % n : bx;
  }

  /** The object occupying block (bx, by, bz) (1 m block coordinates), if any (doors: either block; designs: any in their box). */
  objectAt(bx: number, by: number, bz: number): PlacedObject | undefined {
    return this.cells.get(objectKey(this.wrapBlockX(bx), by, bz));
  }

  /**
   * Where a player whose bed is at block (bx, by, bz) (1 m block coordinates) comes back after
   * dying (feet, units: on top of it, in the middle), or why they can't: it isn't a bed there any
   * more ('gone'), or there's no room above it ('blocked').
   */
  bedSpot(bx: number, by: number, bz: number): { x: number; y: number; z: number } | 'gone' | 'blocked' {
    const o = this.objectAt(bx, by, bz);
    if (!o || !isBed(o) || this.wrapBlockX(o.x) !== this.wrapBlockX(bx) || o.y !== by || o.z !== bz) return 'gone';
    const [w, h, d] = o.span ?? [1, 1, 1];
    const x = (o.x + w / 2) * BLOCK_SIZE, z = (o.z + d / 2) * BLOCK_SIZE, top = (o.y + h) * BLOCK_SIZE;
    // (The client stands them half a metre above where they're sent: room for them there, or a little higher.)
    const lift = liftOut(playerBox([x, top + BLOCK_SIZE / 2 + PLAYER.eye, z]), this.solidAt, BLOCK_SIZE);
    return lift === null ? 'blocked' : { x, y: top + lift, z };
  }

  /** The blocks an object takes, in world block coordinates (X in the world's range). */
  private objectBlocksAt(o: PlacedObject): [number, number, number][] {
    return objectCells(o).map(([dx, dy, dz]) => [this.wrapBlockX(o.x + dx), o.y + dy, o.z + dz]);
  }

  private addObject(o: PlacedObject): void {
    this.objects.set(objectKey(o.x, o.y, o.z), o);
    for (const [x, y, z] of this.objectBlocksAt(o)) this.cells.set(objectKey(x, y, z), o);
  }

  /**
   * The furnace or stove `o` is (see objectStation), and what's in it (kept from here on: change
   * it, then saveStations); null if it isn't one.
   */
  station(o: PlacedObject, now: number): { kind: StationKind; state: StationState } | null {
    const kind = objectStation(o);
    if (!isStationKind(kind)) return null;
    const key = objectKey(o.x, o.y, o.z);
    let state = this.stations.get(key);
    if (!state) this.stations.set(key, (state = emptyStation(now)));
    return { kind, state };
  }

  saveStations(): void {
    this.store?.saveStations?.(Object.fromEntries(this.stations));
  }

  private dropObject(o: PlacedObject): void {
    // (A station taken down loses what's in it: take it out first, see station.)
    if (this.stations.delete(objectKey(o.x, o.y, o.z))) this.saveStations();
    this.objects.delete(objectKey(o.x, o.y, o.z));
    for (const [x, y, z] of this.objectBlocksAt(o)) this.cells.delete(objectKey(x, y, z));
  }

  /** The designs placed in this world (see ObjectDesign). */
  designObjects(): PlacedObject[] {
    return [...this.objects.values()].filter((o) => o.kind === 'design');
  }

  /** Any object in the blocks a unit box [x0, x1) x [y0, y1) x [z0, z1) touches. */
  private objectIn(b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }): PlacedObject | undefined {
    if (this.objects.size === 0) return undefined;
    for (let by = Math.floor(b.y0 / BLOCK_SIZE); by <= Math.floor((b.y1 - 1) / BLOCK_SIZE); by++)
      for (let bz = Math.floor(b.z0 / BLOCK_SIZE); bz <= Math.floor((b.z1 - 1) / BLOCK_SIZE); bz++)
        for (let bx = Math.floor(b.x0 / BLOCK_SIZE); bx <= Math.floor((b.x1 - 1) / BLOCK_SIZE); bx++) {
          const o = this.objectAt(bx, by, bz);
          if (o) return o;
        }
    return undefined;
  }

  /** The current block at (bx, by, bz), and where it lives; null outside the world. */
  private blockAt(bx: number, by: number, bz: number): Block | undefined {
    const n = BLOCKS_PER_CHUNK_AXIS;
    const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
    if (!resolved) return undefined;
    return this.current(resolved).blocks[blockIndex(mod(bx, n), mod(by, n), mod(bz, n))] ?? null;
  }

  /**
   * The light (sky and block, 0..15, see lightAt) in block (bx, by, bz), as players see it drawn.
   * `want`: only what's needed (torchlight is only looked for with a torch near).
   */
  lightAt(bx: number, by: number, bz: number, want: { sky?: boolean; block?: boolean; reach?: number } = { sky: true, block: true }): { sky: number; block: number } {
    const block = want.block && this.torchNear(bx, by, bz, SKY_LIGHT_LEVEL);
    if (!want.sky && !block) return { sky: 0, block: 0 };
    const tops = new Map<string, number>();
    const world: LightWorld = {
      opaque: (x, y, z) => {
        const b = this.blockAt(x, y, z);
        return b === undefined || (b !== null && b.kind === 'uniform' && blocksLight(b.material));
      },
      glow: (x, y, z) => {
        const b = this.blockAt(x, y, z);
        if (!b) return 0;
        if (b.kind === 'uniform') return LIGHT_LEVEL[b.material] ?? 0;
        let l = 0;
        for (const m of b.materials) l = Math.max(l, LIGHT_LEVEL[m] ?? 0);
        return l;
      },
      skyOpen: (x, y, z) => y > this.lightTop(x, z, tops),
    };
    return lightAt(world, bx, by, bz, { sky: want.sky ?? false, block: !!block, ...(want.reach !== undefined ? { reach: want.reach } : {}) });
  }

  /** Whether block (bx, by, bz) is open to the sky (nothing above it stops light). */
  skyOpenAt(bx: number, by: number, bz: number): boolean {
    return by > this.lightTop(bx, bz, new Map());
  }

  /** The highest block (y) stopping light in column (bx, bz), memoized in `tops`; -Infinity for none. */
  private lightTop(bx: number, bz: number, tops: Map<string, number>): number {
    const k = `${bx},${bz}`;
    const known = tops.get(k);
    if (known !== undefined) return known;
    const n = BLOCKS_PER_CHUNK_AXIS;
    const range = this.columnRange(Math.floor(bx / n), Math.floor(bz / n));
    let top = -Infinity;
    if (range) {
      const bottom = Math.floor(range.minY / BLOCK_SIZE) - 1;
      for (let y = Math.floor(range.maxY / BLOCK_SIZE); y >= bottom; y--) {
        const b = this.blockAt(bx, y, bz);
        if (b === undefined || (b !== null && b.kind === 'uniform' && blocksLight(b.material))) {
          top = y;
          break;
        }
      }
      // (Nothing in the column's range: rock below it.)
      if (top === -Infinity) top = bottom;
    }
    tops.set(k, top);
    return top;
  }

  /** Whether a torch is within `reach` blocks (each way) of block (bx, by, bz). */
  private torchNear(bx: number, by: number, bz: number, reach: number): boolean {
    for (const o of this.objects.values()) {
      if (o.kind !== 'torch') continue;
      const dx = Math.abs(deltaX(this.config, bx * BLOCK_SIZE, o.x * BLOCK_SIZE)) / BLOCK_SIZE;
      if (dx <= reach && Math.abs(o.y - by) <= reach + 1 && Math.abs(o.z - bz) <= reach) return true;
    }
    return false;
  }

  /** Replaces whole blocks (1 m block coordinates) and commits the chunks they're in. */
  private writeBlocks(blocks: { bx: number; by: number; bz: number; block: Block }[]): EditResult {
    const n = BLOCKS_PER_CHUNK_AXIS;
    const next = new Map<string, Chunk>();
    for (const { bx, by, bz, block } of blocks) {
      const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
      if (!resolved) throw new EditError('outside the world');
      const key = chunkKey(resolved);
      let chunk = next.get(key);
      if (!chunk) {
        const cur = this.current(resolved);
        chunk = { cx: cur.cx, cy: cur.cy, cz: cur.cz, blocks: cur.blocks.slice() };
        next.set(key, chunk);
      }
      chunk.blocks[blockIndex(mod(bx, n), mod(by, n), mod(bz, n))] = block;
    }
    return this.commit([...next.values()]);
  }

  /** The blocks of an object as it should be now (fences join their neighbours). */
  private objectWrites(o: PlacedObject): { bx: number; by: number; bz: number; block: Block }[] {
    const joins = o.kind === 'fence' ? fenceJoins(o.x, o.y, o.z, (x, y, z) => this.objectAt(x, y, z)) : [];
    return objectBlocks(o, joins).map(({ dx, dy, dz, voxels }) => ({ bx: this.wrapBlockX(o.x + dx), by: o.y + dy, bz: o.z + dz, block: blockFromVoxels(voxels) }));
  }

  /** Fences beside block (bx, by, bz), redrawn (they may join or part from what's there now). */
  private neighbourFenceWrites(bx: number, by: number, bz: number): { bx: number; by: number; bz: number; block: Block }[] {
    return FACINGS.flatMap((f) => {
      const [dx, dz] = FACING_STEP[f];
      const o = this.objectAt(bx + dx, by, bz + dz);
      return o?.kind === 'fence' ? this.objectWrites(o) : [];
    });
  }

  private saveObjects(): void {
    this.store?.saveObjects?.([...this.objects.values()]);
    this.onObjectsChanged?.();
  }

  /** Throws EditError unless every block `o` would take is in the world, empty (water aside) and free of objects. */
  private checkRoom(o: PlacedObject, what: string): void {
    for (const [x, y, z] of this.objectBlocksAt(o)) {
      if (this.objectAt(x, y, z)) throw new EditError(`there's already something there`);
      const block = this.blockAt(x, y, z);
      if (block === undefined) throw new EditError('outside the world');
      if (blockVoxels(withoutWater(block)).length > 0) throw new EditError(what);
    }
  }

  /**
   * Places an object with its (bottom) block at (bx, by, bz). Throws EditError if a block it
   * needs is outside the world, holds something solid, or holds another object.
   */
  placeObject(kind: ObjectKind, bx: number, by: number, bz: number, facing: Facing, wall = false): EditResult {
    const o: PlacedObject = { kind, x: this.wrapBlockX(bx), y: by, z: bz, facing, open: false, ...(kind === 'torch' && wall ? { wall: true } : {}) };
    if (kind === 'torch') return this.placeTorch(o, wall);
    this.checkRoom(o, `a ${kind} needs ${kind === 'door' ? 'two empty blocks' : 'an empty block'}`);
    this.addObject(o);
    const result = this.writeBlocks([...this.objectWrites(o), ...this.neighbourFenceWrites(o.x, o.y, o.z)]);
    this.stats.edits++;
    this.saveObjects();
    return result;
  }

  /**
   * Places a torch: in an empty block, or one partly filled (as the ground's surface often is), if
   * it fits (standing on what's under it there); held up by the block below it (standing, unless
   * the ground in its own block holds it) or the wall it's on.
   */
  private placeTorch(o: PlacedObject, wall: boolean): EditResult {
    // Standing, where the ground under it fills its block (aimed at the block's low edge, say):
    // on that ground, in the block above.
    if (!wall && !this.objectAt(o.x, o.y, o.z)) {
      const here = this.blockAt(o.x, o.y, o.z);
      const fit = here === undefined ? null : fitTorch(blockVoxels(withoutWater(here)), blockVoxels(withoutWater(this.blockAt(o.x, o.y + 1, o.z) ?? null)), o.facing, false);
      if (!fit || !fit.lower.length) {
        const up = this.blockAt(o.x, o.y + 1, o.z);
        if (up !== undefined && fitTorch(blockVoxels(withoutWater(up)), blockVoxels(withoutWater(this.blockAt(o.x, o.y + 2, o.z) ?? null)), o.facing, false)) o.y++;
      }
    }
    if (this.objectAt(o.x, o.y, o.z)) throw new EditError(`there's already something there`);
    const block = this.blockAt(o.x, o.y, o.z), up = this.blockAt(o.x, o.y + 1, o.z);
    if (block === undefined) throw new EditError('outside the world');
    const ground = blockVoxels(withoutWater(block)), above = blockVoxels(withoutWater(up ?? null));
    const torch = fitTorch(ground, above, o.facing, wall);
    if (!torch) throw new EditError("a torch doesn't fit there");
    if (torch.upper.length) {
      if (up === undefined || this.objectAt(o.x, o.y + 1, o.z)) throw new EditError("a torch doesn't fit there");
      o.span = [1, 2, 1];
    }
    // (Not standing at the bottom of its block: the ground in it holds it up.)
    const standsOnGround = !wall && !torch.lower.some((v) => v.y === 0);
    if (!standsOnGround) {
      const [dx, dz] = wall ? FACING_STEP[o.facing] : [0, 0];
      const x = o.x + dx, y = wall ? o.y : o.y - 1, z = o.z + dz;
      const on = this.blockAt(x, y, z);
      if (!on || blockVoxels(withoutWater(on)).length === 0 || this.objectAt(x, y, z)) throw new EditError(wall ? 'a torch goes on a wall: nothing to hold it there' : 'a torch stands on something: nothing under it');
    }
    this.addObject(o);
    const result = this.writeBlocks([
      { bx: o.x, by: o.y, bz: o.z, block: blockFromVoxels([...ground, ...torch.lower]) },
      ...(torch.upper.length ? [{ bx: o.x, by: o.y + 1, bz: o.z, block: blockFromVoxels([...above, ...torch.upper]) }] : []),
    ]);
    this.stats.edits++;
    this.saveObjects();
    return result;
  }

  /**
   * Places a design (see ObjectDesign) in its first state, the middle of its front row at block
   * (bx, by, bz) (see designOrigin), facing `facing`. Throws EditError if any block of its box is
   * outside the world, holds something solid, or holds another object.
   */
  placeDesign(design: ObjectDesign, bx: number, by: number, bz: number, facing: Facing): EditResult {
    const at = designOrigin(design, facing, bx, by, bz);
    const o: PlacedObject = { kind: 'design', design: design.id, state: 0, x: this.wrapBlockX(at.x), y: at.y, z: at.z, facing, open: false, span: designSpan(design, facing) };
    const [w, h, d] = o.span!;
    this.checkRoom(o, `a ${design.name} needs ${w} x ${h} x ${d} m of empty space`);
    this.addObject(o);
    const result = this.writeBlocks(this.objectWrites(o));
    this.stats.edits++;
    this.saveObjects();
    return result;
  }

  /** Takes an object down (its blocks become empty); fences beside it let go. */
  removeObject(o: PlacedObject): EditResult {
    this.dropObject(o);
    // (A torch may share its block with the ground: that stays.)
    const empty = this.objectBlocksAt(o).map(([bx, by, bz]) => ({ bx, by, bz, block: o.kind === 'torch' ? blockFromVoxels(blockVoxels(withoutWater(this.blockAt(bx, by, bz) ?? null)).filter((v) => !isTorchVoxel(v))) : null }));
    const result = this.writeBlocks([...empty, ...this.neighbourFenceWrites(o.x, o.y, o.z)]);
    this.stats.edits++;
    this.saveObjects();
    return result;
  }

  /**
   * The explosives (TNT, C4) touching `start` (sharing a face, directly or through others), `start`
   * included: what goes off with it. At most `max` voxels.
   */
  explosiveCluster(start: Explosive, max = 512): Explosive[] {
    const key = (t: Explosive) => `${t.x},${t.y},${t.z}`;
    const found = new Map<string, Explosive>([[key(start), start]]);
    const queue = [start];
    while (queue.length && found.size < max) {
      const t = queue.shift()!;
      // The explosives in the 1 m blocks around it that share part of a face with it (any size: a
      // 1/8 m voxel in the corner of a 1 m block's face counts).
      const B = BLOCK_SIZE;
      for (let by = Math.floor((t.y - 1) / B); by <= Math.floor((t.y + t.size) / B); by++) {
        for (let bz = Math.floor((t.z - 1) / B); bz <= Math.floor((t.z + t.size) / B); bz++) {
          for (let bx = Math.floor((t.x - 1) / B); bx <= Math.floor((t.x + t.size) / B); bx++) {
            for (const v of this.explosivesInBlock(bx, by, bz)) {
              if (found.has(key(v)) || !sharesFace(t, v)) continue;
              found.set(key(v), v);
              queue.push(v);
              if (found.size >= max) return [...found.values()];
            }
          }
        }
      }
    }
    return [...found.values()];
  }

  /** The explosive voxels in 1 m block (bx, by, bz) (world block coordinates; corners in units). */
  private explosivesInBlock(bx: number, by: number, bz: number): Explosive[] {
    const n = BLOCKS_PER_CHUNK_AXIS;
    const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
    if (!resolved) return [];
    const block = this.current(resolved).blocks[blockIndex(((bx % n) + n) % n, ((by % n) + n) % n, ((bz % n) + n) % n)] ?? null;
    if (!block || (block.kind === 'uniform' && !isExplosive(block.material))) return [];
    const B = BLOCK_SIZE;
    return blockVoxels(block)
      .filter((v) => isExplosive(v.material))
      .map((v) => ({ x: bx * B + v.x, y: by * B + v.y, z: bz * B + v.z, size: v.size, material: v.material }));
  }


  /** The explosive voxel (TNT, C4) covering unit (x, y, z) (its corner and size, units, and material), or null if there's none. */
  explosiveAt(x: number, y: number, z: number): Explosive | null {
    const n = CHUNK_SIZE, cx = Math.floor(x / n), cy = Math.floor(y / n), cz = Math.floor(z / n);
    const resolved = resolveChunk(this.config, { cx, cy, cz });
    if (!resolved) return null;
    const chunk = this.current(resolved);
    const lx = x - cx * n, ly = y - cy * n, lz = z - cz * n;
    const block = chunk.blocks[blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE))] ?? null;
    const v = blockVoxelContaining(block, lx % BLOCK_SIZE, ly % BLOCK_SIZE, lz % BLOCK_SIZE);
    if (!v || !isExplosive(v.material)) return null;
    const ox = x - (lx % BLOCK_SIZE), oy = y - (ly % BLOCK_SIZE), oz = z - (lz % BLOCK_SIZE);
    return { x: ox + v.x, y: oy + v.y, z: oz + v.z, size: v.size, material: v.material };
  }

  /**
   * Blows out a crater of `radius` (units) around (x, y, z): everything solid within it goes
   * (voxels cut by its edge broken down to 1/4 m, or 1/16 m for a small blast, so it's round),
   * placed objects in it too; water stays (and the sea flows into what's opened beside it). TNT in
   * it stays, to be lit (returned: its voxels), except `blowing`, the TNT going off (corners,
   * "x,y,z"). Null result if nothing changed.
   */
  explode(x: number, y: number, z: number, radius: number, blowing: ReadonlySet<string> = new Set(), seed?: number): {
    result: EditResult | null;
    tnt: Explosive[];
    /** What it took out (voxels, corner and size in units, and material): for its debris. */
    removed: { x: number; y: number; z: number; size: number; material: MaterialId }[];
  } {
    // Its shape: from `seed`, lobed and rough (see craterShape); without one, the sphere.
    const shape = craterShape(radius, seed), reach = shape.outer;
    const r2 = radius * radius, minPiece = radius >= 32 ? 4 : 1;
    const results: EditResult[] = [];
    // Objects in it: gone.
    for (const o of [...this.objects.values()]) {
      // (The nearest point of its box: a 1 m column's middle, as ever, for the built-in ones.)
      const [w, h, d] = o.kind === 'design' ? (o.span ?? [1, 1, 1]) : [1, objectHeight(o.kind), 1];
      const near = (lo: number, hi: number, v: number) => Math.max(0, lo - v, v - hi);
      const cx = deltaX(this.config, x, (o.x + w / 2) * BLOCK_SIZE);
      const dx = o.kind === 'design' ? Math.max(0, Math.abs(cx) - (w / 2) * BLOCK_SIZE) : cx;
      const dz = o.kind === 'design' ? near(o.z * BLOCK_SIZE, (o.z + d) * BLOCK_SIZE, z) : (o.z + 0.5) * BLOCK_SIZE - z;
      const dy = near(o.y * BLOCK_SIZE, (o.y + h) * BLOCK_SIZE, y);
      if (dx * dx + dy * dy + dz * dz <= r2) results.push(this.removeObject(o));
    }
    const tnt: Explosive[] = [];
    const removed: { x: number; y: number; z: number; size: number; material: MaterialId }[] = [];
    const next = new Map<string, Chunk>(), seen = new Map<string, Chunk>();
    const touched: [number, number, number][] = [];
    const B = BLOCK_SIZE, n = BLOCKS_PER_CHUNK_AXIS;
    for (let by = Math.floor((y - reach) / B); by <= Math.floor((y + reach) / B); by++) {
      for (let bz = Math.floor((z - reach) / B); bz <= Math.floor((z + reach) / B); bz++) {
        for (let bx = Math.floor((x - reach) / B); bx <= Math.floor((x + reach) / B); bx++) {
          // (Quickly past blocks the crater misses.)
          if (shape.classify(bx * B - x, by * B - y, bz * B - z, B) === -1) continue;
          const resolved = resolveChunk(this.config, { cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
          if (!resolved) continue;
          const key = chunkKey(resolved);
          let chunk = next.get(key) ?? seen.get(key);
          // (Each chunk made once: generating one is costly. Those just looked at are decoded already.)
          if (!chunk) seen.set(key, (chunk = this.decoded.get(key) ?? this.current(resolved)));
          const i = blockIndex(((bx % n) + n) % n, ((by % n) + n) % n, ((bz % n) + n) % n);
          const block = chunk.blocks[i] ?? null;
          if (!block) continue;
          const kept: BlockVoxel[] = [];
          const gone: { x: number; y: number; z: number; size: number; material: MaterialId }[] = [];
          /** Decides a voxel: what of it stays (`into.kept`) and goes (`into.gone`), whole where it can. */
          const visit = (v: BlockVoxel, into: { kept: BlockVoxel[]; gone: typeof gone }) => {
            const wx = bx * B + v.x, wy = by * B + v.y, wz = bz * B + v.z;
            if (isWater(v.material)) return void into.kept.push(v);
            const inside = () => shape.contains(wx + v.size / 2 - x, wy + v.size / 2 - y, wz + v.size / 2 - z);
            if (isExplosive(v.material) && !blowing.has(`${wx},${wy},${wz}`)) {
              if (inside()) tnt.push({ x: wx, y: wy, z: wz, size: v.size, material: v.material });
              return void into.kept.push(v);
            }
            const where = shape.classify(wx - x, wy - y, wz - z, v.size);
            if (where === -1) return void into.kept.push(v); // untouched
            if (where === 1) return void into.gone.push({ x: wx, y: wy, z: wz, size: v.size, material: v.material }); // all inside: gone
            if (v.size > minPiece) {
              // Maybe cut by the edge: in eighths, each decided again; if they all go (or all stay), it does whole.
              const h = v.size / 2, parts = { kept: [] as BlockVoxel[], gone: [] as typeof gone };
              for (let k = 0; k < 8; k++) visit({ x: v.x + (k & 1) * h, y: v.y + ((k >> 1) & 1) * h, z: v.z + ((k >> 2) & 1) * h, size: h, material: v.material }, parts);
              if (parts.kept.length === 0) into.gone.push({ x: wx, y: wy, z: wz, size: v.size, material: v.material });
              else if (parts.gone.length === 0) into.kept.push(v);
              else {
                into.kept.push(...parts.kept);
                into.gone.push(...parts.gone);
              }
              return;
            }
            if (!inside()) into.kept.push(v);
            else into.gone.push({ x: wx, y: wy, z: wz, size: v.size, material: v.material });
          };
          for (const v of blockVoxels(block)) visit(v, { kept, gone });
          if (gone.length === 0) continue;
          removed.push(...gone);
          const blocks = chunk.blocks.slice();
          blocks[i] = blockFromVoxels(kept);
          next.set(key, { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, blocks });
          touched.push([bx, by, bz]);
          this.flow.touch(bx, by, bz);
        }
      }
    }
    if (next.size) {
      results.push(this.commit([...next.values()]));
      const refill = this.refillFromNatural(touched);
      if (refill) results.push(refill);
      this.stats.edits++;
    }
    return { result: results.length ? results.reduce(mergeResults) : null, tnt, removed };
  }

  /**
   * Opens or closes a gate or door, or steps a design to its next state; throws EditError for
   * anything else (or a design that's changed since it was placed: it can't be redrawn).
   */
  toggleObject(o: PlacedObject): EditResult {
    if (o.kind === 'design') {
      const design = designById(o.design ?? '');
      if (!design || design.states.length < 2) throw new EditError(`a ${objectName(o)} doesn't change`);
      const next = { ...o, state: ((o.state ?? 0) + 1) % design.states.length };
      if (objectBlocks(next).length === 0) throw new EditError(`the ${design.name} design has changed since this one was placed: take it down and place it again`);
      this.addObject(next);
      const result = this.writeBlocks(this.objectWrites(next));
      this.saveObjects();
      return result;
    }
    if (!opens(o.kind)) throw new EditError(`${o.kind === 'table' ? 'crafting tables' : 'fences'} don't open`);
    const next = { ...o, open: !o.open };
    this.addObject(next);
    const result = this.writeBlocks(this.objectWrites(next));
    this.saveObjects();
    return result;
  }

  /**
   * Takes up to `amount` units (height in a 1 m block, see PouredWater) of water from block
   * (bx, by, bz): natural water gives it all and stays; poured water gives what it has. Returns
   * how much was taken and what changed (null if nothing did).
   */
  scoopWater(bx: number, by: number, bz: number, amount: number): { taken: number; result: EditResult | null } {
    const block = this.blockAt(bx, by, bz);
    if (block === undefined) return { taken: 0, result: null };
    const kind = waterKind(block);
    if (kind === 'natural') return { taken: amount, result: null };
    if (kind !== 'poured') return { taken: 0, result: null };
    const have = waterAmount(block), taken = Math.min(have, amount);
    const result = this.writeBlocks([{ bx, by, bz, block: setPouredWater(block, have - taken) }]);
    this.flow.touch(bx, by, bz);
    return { taken, result };
  }

  /**
   * Pours up to `amount` units of water into block (bx, by, bz), as much as it has room for, and
   * the rest into the block above (e.g. aiming at ground that fills most of its block); it moves
   * on from there. Returns how much was poured and what changed (null if nothing).
   */
  pourWater(bx: number, by: number, bz: number, amount: number): { poured: number; result: EditResult | null } {
    const writes: { bx: number; by: number; bz: number; block: Block }[] = [];
    let left = amount;
    for (let y = by; y <= by + 1 && left > 0; y++) {
      if (this.objectAt(bx, y, bz)) break;
      const block = this.blockAt(bx, y, bz);
      if (block === undefined || !blockHasRoom(block) || waterKind(block) === 'natural') break;
      const have = waterAmount(block), n = Math.min(waterCapacity(block) - have, left);
      if (n <= 0) continue;
      writes.push({ bx, by: y, bz, block: setPouredWater(block, have + n) });
      left -= n;
    }
    if (!writes.length) return { poured: 0, result: null };
    const result = this.writeBlocks(writes);
    for (const w of writes) this.flow.touch(w.bx, w.by, w.bz);
    return { poured: amount - left, result };
  }

  /**
   * Cuts leaves (and only leaves) in the blocks within `radius` (Chebyshev, 1 m blocks) of block
   * (bx, by, bz): a sword's sweep. Returns what changed, or null if there were none.
   */
  cutLeaves(bx: number, by: number, bz: number, radius: number): EditResult | null {
    const writes: { bx: number; by: number; bz: number; block: Block }[] = [];
    for (let y = by - radius; y <= by + radius; y++)
      for (let z = bz - radius; z <= bz + radius; z++)
        for (let x = bx - radius; x <= bx + radius; x++) {
          if (this.objectAt(x, y, z)) continue;
          const block = this.blockAt(x, y, z);
          if (!block) continue;
          const voxels = blockVoxels(block);
          const kept = voxels.filter((v) => !LEAVES.has(v.material));
          if (kept.length !== voxels.length) writes.push({ bx: x, by: y, bz: z, block: blockFromVoxels(kept) });
        }
    if (!writes.length) return null;
    const result = this.writeBlocks(writes);
    for (const w of writes) this.flow.touch(w.bx, w.by, w.bz);
    this.stats.edits++;
    return result;
  }

  /**
   * Whether any 1 m block within `reach` units (Chebyshev) of (x, y, z) holds `material` (e.g. a
   * crafting table near a player). Looks at generated or edited chunks as they are now.
   */
  /** Whether station `role` (a design standing in for it; the crafting table: the built-in one too) is placed within `reach` (units, as materialNear) of (x, y, z). */
  stationNear(role: DesignRole, x: number, y: number, z: number, reach: number): boolean {
    for (let by = Math.floor((y - reach) / BLOCK_SIZE); by <= Math.floor((y + reach) / BLOCK_SIZE); by++)
      for (let bz = Math.floor((z - reach) / BLOCK_SIZE); bz <= Math.floor((z + reach) / BLOCK_SIZE); bz++)
        for (let bx = Math.floor((x - reach) / BLOCK_SIZE); bx <= Math.floor((x + reach) / BLOCK_SIZE); bx++) {
          const o = this.objectAt(bx, by, bz);
          if (o && objectStation(o) === role) return true;
        }
    return false;
  }

  materialNear(x: number, y: number, z: number, reach: number, material: MaterialId): boolean {
    return materialNearIn(
      (cx, cy, cz) => {
        const resolved = resolveChunk(this.config, { cx, cy, cz });
        return resolved ? this.current(resolved) : null;
      },
      x, y, z, reach, material,
    );
  }

  /** Ground height range of a chunk column, or null outside the world. */
  columnRange(cx: number, cz: number): ColumnRange | null {
    const resolved = resolveChunk(this.config, { cx, cy: 0, cz });
    if (!resolved) return null;
    return this.withEdits(resolved.cx, resolved.cz, this.generator.columnRange(resolved.cx, resolved.cz));
  }

  /** A generated column's range, widened over its edited chunks. */
  private withEdits(cx: number, cz: number, range: ColumnRange): ColumnRange {
    const span = this.editSpans.get(`${cx},${cz}`);
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
    const map = this.mapArea(0, 0, step, Math.ceil(this.config.widthUnits / step), Math.ceil(this.config.depthUnits / step));
    this.maps.set(width, map);
    return map;
  }

  /**
   * Surface samples (as getMap) for `cols` x `rows` cells of `step` units from (x0, z0) (units),
   * each sampled at its centre: a closer look at part of the world. Round worlds wrap in x.
   */
  mapArea(x0: number, z0: number, step: number, cols: number, rows: number): WorldMap {
    return surfaceMap(this.generator, x0, z0, step, cols, rows);
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

/** A low-detail tile's bytes (see encodeTile), made by `generator`. */
export function tileBytes(generator: ChunkGenerator, config: WorldConfig, t: TileCoord): Uint8Array {
  const size = tileSizeUnits(t.level);
  const step = tileStep(t.level);
  // Sample each cell at its centre column.
  const x0 = t.tx * size + Math.floor(step / 2);
  const z0 = t.tz * size + Math.floor(step / 2);
  const s = generator.surfaceSamples(x0, z0, step, TILE_SAMPLES);
  const heights = new Int16Array(TILE_SAMPLES * TILE_SAMPLES);
  for (let j = 0; j < TILE_SAMPLES; j++) {
    for (let i = 0; i < TILE_SAMPLES; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const outside = (!config.wrapX && (x < 0 || x >= config.widthUnits)) || z < 0 || z >= config.depthUnits;
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
  return encodeTile({ ...t, heights, materials: s.materials, ...canopy, ...(water ? { water } : {}) });
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
