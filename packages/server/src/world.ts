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
  objectBox,
  objectRegions,
  BOAT,
  waterSurface,
  type Boat,
  voxelInRegions,
  boxesMeet,
  ownsWholeBlocks,
  designParts,
  type Box,
  isDesignOffset,
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
/** A block a build changed: where, as it was, and as it was left (see World.build). */
export interface BuildChange {
  bx: number;
  by: number;
  bz: number;
  before: Block;
  after: Block;
}

/** Whether two blocks hold the same voxels (blocks decoded again aren't the same objects). */
function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const key = (blk: Block) => blockVoxels(blk).map((v) => `${v.x},${v.y},${v.z},${v.size},${v.material}`).sort().join(';');
  return key(a) === key(b);
}

/** A moving boat is kept at most this often (ms; and whenever it's left). */
const BOATS_SAVE_MS = 2000;
/**
 * An object's own key: its block; a design owning only parts of its blocks, also its shift, design
 * and facing (several can start in one block, each in its own parts of it).
 */
const objectId = (o: PlacedObject) => objectKey(o.x, o.y, o.z) + (ownsWholeBlocks(o) ? '' : `+${(o.offset ?? [0, 0, 0]).join(',')}+${o.design}+${o.facing}`);
/** Whether any of one list of block-local boxes shares volume with any of another's. */
const regionsMeet = (a: readonly Box[], b: readonly Box[]) => a.some((r) => b.some((q) => boxesMeet(r, q)));

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
  /** A map of part of the world, encoded (see surfaceMap, encodeWorldMap). */
  map?(x0: number, z0: number, step: number, cols: number, rows: number): Promise<Uint8Array>;
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
  /** What's in each furnace and stove (see stations.ts), by its key (objectId). */
  private readonly stations = new Map<string, StationState>();
  /**
   * Every block a placed object takes (see objectCells), "bx,by,bz", to the objects there: one, or
   * designs off the grid sharing it, each in its own part of it (see objectRegion).
   */
  private readonly cells = new Map<string, PlacedObject[]>();
  /** Told whenever objects are placed, taken down or change (to tell players about designs: see designObjects). */
  onObjectsChanged: (() => void) | null = null;
  /** Running totals since the world was opened, for monitoring (see WorldStats). */
  readonly stats: WorldStats = {
    chunkHits: 0, chunkMisses: 0, tileHits: 0, tileMisses: 0,
    recentChunkMs: [], recentTileMs: [],
    edits: 0, waterSteps: 0, waterChanges: 0,
  };
  /**
   * Work done on the main thread for what looks at the world (mobs, water, light): chunks made
   * (not to hand), decoded, and column ranges worked out, with the time each took (ms). For
   * finding what holds the server up (see the 'slow task' log).
   */
  readonly mainThread = { chunksMade: 0, madeMs: 0, chunksDecoded: 0, decodedMs: 0, columnRanges: 0, rangesMs: 0 };

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
    for (const b of this.store?.loadBoats?.() ?? []) {
      this.boats.set(b.id, { id: b.id, design: b.design, x: b.x, y: b.y, z: b.z, yaw: b.yaw });
      this.nextBoat = Math.max(this.nextBoat, b.id + 1);
    }
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
    const bytes = this.cache.get(key), t0 = performance.now(), m = this.mainThread;
    if (bytes) {
      const chunk = decodeChunk(bytes);
      m.chunksDecoded++;
      m.decodedMs += performance.now() - t0;
      return chunk;
    }
    const chunk = this.generator.generateChunk(coord);
    m.chunksMade++;
    m.madeMs += performance.now() - t0;
    return chunk;
  }

  /** Stores, caches, and saves edited chunks; reports widened column ranges. */
  /** The last chunk materialAtUnit looked at (most lookups land in the same one as the last). */
  private last: { cx: number; cy: number; cz: number; chunk: Chunk | null } | null = null;

  /**
   * Chunk (cx, cy, cz) as it is now, from the recently looked-at ones (decoding one is far from
   * free: what looks at many blocks, mobs and light, shouldn't decode it for each); null outside
   * the world.
   */
  private lookedAt(cx: number, cy: number, cz: number): Chunk | null {
    const last = this.last;
    if (last && last.cx === cx && last.cy === cy && last.cz === cz) return last.chunk;
    const resolved = resolveChunk(this.config, { cx, cy, cz });
    let chunk: Chunk | null = null;
    if (resolved) {
      const key = chunkKey(resolved);
      const hit = this.decoded.get(key);
      if (hit) {
        this.decoded.delete(key);
        chunk = hit;
      } else {
        chunk = this.current(resolved);
        if (this.decoded.size >= DECODED_KEPT) this.decoded.delete(this.decoded.keys().next().value!);
      }
      this.decoded.set(key, chunk);
    }
    this.last = { cx, cy, cz, chunk };
    return chunk;
  }

  /** The material of the unit cell (world units), from recently looked-at chunks (mobs walking about); undefined outside the world. */
  materialAtUnit(x: number, y: number, z: number): number | undefined {
    const n = CHUNK_SIZE;
    const cx = Math.floor(x / n), cy = Math.floor(y / n), cz = Math.floor(z / n);
    const chunk = this.lookedAt(cx, cy, cz);
    if (!chunk) return undefined;
    return materialAt(chunk, x - cx * n, y - cy * n, z - cz * n);
  }

  /** Whether the unit cell (world units) is water; undefined outside the world. */
  readonly waterAt = (x: number, y: number, z: number): boolean | undefined => {
    const m = this.materialAtUnit(Math.floor(x), Math.floor(y), Math.floor(z));
    return m === undefined ? undefined : isWater(m);
  };

  // --- Boats (see boats.ts): kept as they're left; who's in one isn't (they're gone when the server starts).

  /** Told whenever a boat's put in, taken, or got into or out of (not as it moves). */
  onBoatsChanged: (() => void) | null = null;

  boatList(): Boat[] {
    return [...this.boats.values()];
  }

  boatById(id: number): Boat | undefined {
    return this.boats.get(id);
  }

  /**
   * Puts a boat made from `design` in the water at (x, z) (units), pointing `yaw`: floating there,
   * on the water near height `y`. Throws EditError if there's no water there.
   */
  launchBoat(design: ObjectDesign, x: number, y: number, z: number, yaw: number): Boat {
    const top = waterSurface(this.waterAt, x, y + BOAT.draft, z);
    if (top === null || top === undefined || Math.abs(top - BOAT.draft - y) > BLOCK_SIZE) throw new EditError('a boat goes in the water');
    const boat: Boat = { id: this.nextBoat++, design: design.id, x, y: top - BOAT.draft, z, yaw };
    this.boats.set(boat.id, boat);
    this.saveBoats();
    this.onBoatsChanged?.();
    return boat;
  }

  /** Puts player `rider` in boat `id`. Throws EditError if it's gone, or someone else is in it. */
  boardBoat(id: number, rider: number): Boat {
    const boat = this.boats.get(id);
    if (!boat) throw new EditError('that boat has gone');
    if (boat.rider !== undefined && boat.rider !== rider) throw new EditError("someone's in that boat");
    for (const b of this.boats.values()) if (b.rider === rider && b !== boat) delete b.rider;
    boat.rider = rider;
    this.onBoatsChanged?.();
    return boat;
  }

  /**
   * Boat `id` moved by player `rider` (in it) to (x, y, z), pointing `yaw`; `leave`: and they got
   * out. False (nothing changes) if they aren't in it, or it went further than a boat goes at once.
   */
  moveBoat(id: number, rider: number, x: number, y: number, z: number, yaw: number, leave = false): boolean {
    const boat = this.boats.get(id);
    if (!boat || boat.rider !== rider) return false;
    if (Math.hypot(x - boat.x, z - boat.z) > 8 * BLOCK_SIZE || Math.abs(y - boat.y) > 4 * BLOCK_SIZE) return false;
    Object.assign(boat, { x, y, z, yaw });
    if (leave) {
      delete boat.rider;
      this.saveBoats();
      this.onBoatsChanged?.();
    } else if (Date.now() - this.boatsSavedAt > BOATS_SAVE_MS) this.saveBoats();
    return true;
  }

  /** Takes boat `id` out of the world (back into someone's inventory). Throws EditError if it's gone or someone else is in it. */
  takeBoat(id: number, by: number): Boat {
    const boat = this.boats.get(id);
    if (!boat) throw new EditError('that boat has gone');
    if (boat.rider !== undefined && boat.rider !== by) throw new EditError("someone's in that boat");
    this.boats.delete(id);
    this.saveBoats();
    this.onBoatsChanged?.();
    return boat;
  }

  /** Player `rider` has gone: out of any boat they were in (where it was last). */
  riderGone(rider: number): void {
    let any = false;
    for (const b of this.boats.values())
      if (b.rider === rider) {
        delete b.rider;
        any = true;
      }
    if (!any) return;
    this.saveBoats();
    this.onBoatsChanged?.();
  }

  private saveBoats(): void {
    this.boatsSavedAt = Date.now();
    this.store?.saveBoats?.(this.boatList().map(({ rider: _, ...b }) => b));
  }
  private readonly boats = new Map<number, Boat>();
  private nextBoat = 1;
  private boatsSavedAt = 0;

  /** Whether the unit cell (world units) is solid (not air, not water); outside the world counts as solid. */
  readonly solidAt = (x: number, y: number, z: number): boolean => {
    const m = this.materialAtUnit(Math.floor(x), Math.floor(y), Math.floor(z));
    return m === undefined || (m !== 0 && !isWater(m));
  };

  private commit(chunks: Chunk[]): EditResult {
    for (const c of chunks) {
      this.decoded.delete(chunkKey(c));
      this.lightTops.delete(`${c.cx},${c.cz}`);
    }
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
    const here = this.objectsAt(bx, by, bz);
    // (Shared: the one starting here, if one does.)
    return here.find((o) => this.wrapBlockX(o.x) === this.wrapBlockX(bx) && o.y === by && o.z === bz) ?? here[0];
  }

  /** Every object taking block (bx, by, bz) (more than one: designs off the grid sharing it). */
  objectsAt(bx: number, by: number, bz: number): readonly PlacedObject[] {
    return this.cells.get(objectKey(this.wrapBlockX(bx), by, bz)) ?? [];
  }

  /** The furnace or stove (a design standing in for one) taking block (bx, by, bz), the one starting there first. */
  stationAt(bx: number, by: number, bz: number): PlacedObject | undefined {
    const here = this.objectsAt(bx, by, bz).filter((o) => isStationKind(objectStation(o)));
    return here.find((o) => this.wrapBlockX(o.x) === this.wrapBlockX(bx) && o.y === by && o.z === bz) ?? here[0];
  }

  /**
   * The object at unit cell (x, y, z), if any: as objectAt, but in a block a design off the grid
   * shares with what's beside it, only within its box.
   */
  objectAtPoint(x: number, y: number, z: number): PlacedObject | undefined {
    const B = BLOCK_SIZE, bx = Math.floor(x / B), by = Math.floor(y / B), bz = Math.floor(z / B);
    const lx = x - bx * B, ly = y - by * B, lz = z - bz * B;
    return this.objectsAt(bx, by, bz).find((o) => this.regionsIn(o, bx, by, bz).some((r) => lx >= r.x0 && lx < r.x1 && ly >= r.y0 && ly < r.y1 && lz >= r.z0 && lz < r.z1));
  }

  /** What of block (bx, by, bz) object `o` (taking it) owns, block-local (see objectRegions). */
  private regionsIn(o: PlacedObject, bx: number, by: number, bz: number): Box[] {
    const n = this.config.widthUnits / BLOCK_SIZE;
    const dx = this.config.wrapX ? mod(this.wrapBlockX(bx) - o.x, n) : bx - o.x;
    return objectRegions(o, dx, by - o.y, bz - o.z);
  }

  /**
   * Where a player whose bed is at block (bx, by, bz) (1 m block coordinates) comes back after
   * dying (feet, units: on top of it, in the middle), or why they can't: it isn't a bed there any
   * more ('gone'), or there's no room above it ('blocked').
   */
  bedSpot(bx: number, by: number, bz: number): { x: number; y: number; z: number } | 'gone' | 'blocked' {
    const o = this.objectsAt(bx, by, bz).find((o) => isBed(o) && this.wrapBlockX(o.x) === this.wrapBlockX(bx) && o.y === by && o.z === bz);
    if (!o) return 'gone';
    const b = objectBox(o);
    const x = o.x * BLOCK_SIZE + (b.x0 + b.x1) / 2, z = o.z * BLOCK_SIZE + (b.z0 + b.z1) / 2, top = o.y * BLOCK_SIZE + b.y1;
    // (The client stands them half a metre above where they're sent: room for them there, or a little higher.)
    const lift = liftOut(playerBox([x, top + BLOCK_SIZE / 2 + PLAYER.eye, z]), this.solidAt, BLOCK_SIZE);
    return lift === null ? 'blocked' : { x, y: top + lift, z };
  }

  /** The blocks an object takes, in world block coordinates (X in the world's range). */
  private objectBlocksAt(o: PlacedObject): [number, number, number][] {
    return objectCells(o).map(([dx, dy, dz]) => [this.wrapBlockX(o.x + dx), o.y + dy, o.z + dz]);
  }

  /** Registers `o` (in place of the one it was, changed: the same objectId). */
  private addObject(o: PlacedObject): void {
    const was = this.objects.get(objectId(o));
    if (was) this.unregister(was);
    this.objects.set(objectId(o), o);
    for (const [x, y, z] of this.objectBlocksAt(o)) {
      const key = objectKey(x, y, z);
      this.cells.set(key, [...(this.cells.get(key) ?? []), o]);
    }
  }

  private unregister(o: PlacedObject): void {
    this.objects.delete(objectId(o));
    for (const [x, y, z] of this.objectBlocksAt(o)) {
      const key = objectKey(x, y, z), left = (this.cells.get(key) ?? []).filter((p) => p !== o);
      if (left.length) this.cells.set(key, left);
      else this.cells.delete(key);
    }
  }

  /**
   * The furnace or stove `o` is (see objectStation), and what's in it (kept from here on: change
   * it, then saveStations); null if it isn't one.
   */
  station(o: PlacedObject, now: number): { kind: StationKind; state: StationState } | null {
    const kind = objectStation(o);
    if (!isStationKind(kind)) return null;
    const key = objectId(o);
    let state = this.stations.get(key);
    if (!state) this.stations.set(key, (state = emptyStation(now)));
    return { kind, state };
  }

  saveStations(): void {
    this.store?.saveStations?.(Object.fromEntries(this.stations));
  }

  private dropObject(o: PlacedObject): void {
    // (A station taken down loses what's in it: take it out first, see station.)
    if (this.stations.delete(objectId(o))) this.saveStations();
    this.unregister(this.objects.get(objectId(o)) ?? o);
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
          // (Designs owning parts of blocks: only if the bounds reach into their parts in this block.)
          const B = BLOCK_SIZE, part = { x0: b.x0 - bx * B, y0: b.y0 - by * B, z0: b.z0 - bz * B, x1: b.x1 - bx * B, y1: b.y1 - by * B, z1: b.z1 - bz * B };
          const o = this.objectsAt(bx, by, bz).find((o) => ownsWholeBlocks(o) || regionsMeet([part], this.regionsIn(o, bx, by, bz)));
          if (o) return o;
        }
    return undefined;
  }

  /** The current block at (bx, by, bz), and where it lives; null outside the world. */
  private blockAt(bx: number, by: number, bz: number): Block | undefined {
    const n = BLOCKS_PER_CHUNK_AXIS;
    const chunk = this.lookedAt(Math.floor(bx / n), Math.floor(by / n), Math.floor(bz / n));
    if (!chunk) return undefined;
    return chunk.blocks[blockIndex(mod(bx, n), mod(by, n), mod(bz, n))] ?? null;
  }

  /**
   * The light (sky and block, 0..15, see lightAt) in block (bx, by, bz), as players see it drawn.
   * `want`: only what's needed (torchlight is only looked for with a torch near).
   */
  lightAt(bx: number, by: number, bz: number, want: { sky?: boolean; block?: boolean; reach?: number } = { sky: true, block: true }): { sky: number; block: number } {
    const block = want.block && this.torchNear(bx, by, bz, SKY_LIGHT_LEVEL);
    if (!want.sky && !block) return { sky: 0, block: 0 };
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
      skyOpen: (x, y, z) => y > this.lightTop(x, z),
    };
    return lightAt(world, bx, by, bz, { sky: want.sky ?? false, block: !!block, ...(want.reach !== undefined ? { reach: want.reach } : {}) });
  }

  /** Whether block (bx, by, bz) is open to the sky (nothing above it stops light). */
  skyOpenAt(bx: number, by: number, bz: number): boolean {
    return by > this.lightTop(bx, bz);
  }

  /** The highest block (y) stopping light in column (bx, bz) (see lightTops); -Infinity for none. */
  private lightTop(bx: number, bz: number): number {
    const n = BLOCKS_PER_CHUNK_AXIS, cx = Math.floor(bx / n), cz = Math.floor(bz / n);
    const resolved = resolveChunk(this.config, { cx, cy: 0, cz });
    if (!resolved) return -Infinity;
    const key = `${resolved.cx},${resolved.cz}`;
    let tops = this.lightTops.get(key);
    if (tops) {
      this.lightTops.delete(key);
    } else {
      tops = this.columnLightTops(resolved.cx, resolved.cz);
      if (this.lightTops.size >= LIGHT_TOPS_KEPT) this.lightTops.delete(this.lightTops.keys().next().value!);
    }
    this.lightTops.set(key, tops);
    return tops[mod(bx, n) + n * mod(bz, n)]!;
  }

  /**
   * The highest block (y) stopping light in each of a chunk column's 16 x 16 block columns (index
   * x + 16 z): looked for top down through its range, a chunk at a time, each chunk decoded once
   * (block by block, a tall column decoded each of its chunks once a block). Below its range, rock;
   * -Infinity outside the world. Kept until an edit there (see commit).
   */
  private columnLightTops(cx: number, cz: number): Float64Array {
    const n = BLOCKS_PER_CHUNK_AXIS, tops = new Float64Array(n * n).fill(-Infinity);
    const range = this.columnRange(cx, cz);
    if (!range) return tops;
    const bottom = Math.floor(range.minY / BLOCK_SIZE) - 1;
    let left = n * n;
    const found = new Uint8Array(n * n);
    for (let cy = Math.floor(Math.floor(range.maxY / BLOCK_SIZE) / n); cy * n + n - 1 >= bottom && left > 0; cy--) {
      const chunk = this.lookedAt(cx, cy, cz);
      const yTop = Math.min(cy * n + n - 1, Math.floor(range.maxY / BLOCK_SIZE)), yBottom = Math.max(cy * n, bottom);
      for (let i = 0; i < n * n; i++) {
        if (found[i]) continue;
        for (let y = yTop; y >= yBottom; y--) {
          const b = chunk ? (chunk.blocks[blockIndex(i % n, y - cy * n, Math.floor(i / n))] ?? null) : undefined;
          if (b === undefined || (b !== null && b.kind === 'uniform' && blocksLight(b.material))) {
            tops[i] = y;
            found[i] = 1;
            left--;
            break;
          }
        }
      }
    }
    // (Nothing in the column's range: rock below it.)
    for (let i = 0; i < n * n; i++) if (!found[i]) tops[i] = bottom;
    return tops;
  }
  private readonly lightTops = new Map<string, Float64Array>();

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
    return objectBlocks(o, joins).map(({ dx, dy, dz, voxels }) => {
      const bx = this.wrapBlockX(o.x + dx), by = o.y + dy, bz = o.z + dz;
      // (Off the grid: what's beside it in the blocks it shares stays.)
      return { bx, by, bz, block: blockFromVoxels(ownsWholeBlocks(o) ? voxels : [...this.besideObject(o, bx, by, bz), ...voxels]) };
    });
  }

  /** The voxels of block (bx, by, bz) outside what object `o` owns of it (see objectRegion): none, for one on the grid. */
  private besideObject(o: PlacedObject, bx: number, by: number, bz: number): BlockVoxel[] {
    if (ownsWholeBlocks(o)) return [];
    const rs = this.regionsIn(o, bx, by, bz);
    return blockVoxels(withoutWater(this.blockAt(bx, by, bz) ?? null)).filter((v) => !voxelInRegions(v, rs));
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

  /**
   * Throws EditError unless every block `o` would take is in the world, empty (water aside) and free
   * of objects (a design off the grid: empty within its box; see objectRegion).
   */
  private checkRoom(o: PlacedObject, what: string): void {
    for (const [x, y, z] of this.objectBlocksAt(o)) {
      // (Designs off the grid may share a block, each in its own part of it.)
      const rs = this.regionsIn(o, x, y, z);
      if (this.objectsAt(x, y, z).some((p) => regionsMeet(rs, this.regionsIn(p, x, y, z)))) throw new EditError(`there's already something there`);
      const block = this.blockAt(x, y, z);
      if (block === undefined) throw new EditError('outside the world');
      if (blockVoxels(withoutWater(block)).some((v) => voxelInRegions(v, rs))) throw new EditError(what);
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
  placeDesign(design: ObjectDesign, bx: number, by: number, bz: number, facing: Facing, offset: [number, number, number] = [0, 0, 0]): EditResult {
    if (!isDesignOffset(offset)) throw new EditError('a design goes on a 1/4 m grid');
    const at = designOrigin(design, facing, bx, by, bz);
    const o: PlacedObject = { kind: 'design', design: design.id, state: 0, x: this.wrapBlockX(at.x), y: at.y, z: at.z, facing, open: false, span: designSpan(design, facing) };
    if (offset.some((c) => c !== 0)) o.offset = [...offset];
    o.parts = designParts(design, facing, offset);
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
    const empty = this.objectBlocksAt(o).map(([bx, by, bz]) => ({
      bx, by, bz,
      block: o.kind === 'torch' ? blockFromVoxels(blockVoxels(withoutWater(this.blockAt(bx, by, bz) ?? null)).filter((v) => !isTorchVoxel(v))) : blockFromVoxels(this.besideObject(o, bx, by, bz)),
    }));
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


  /**
   * Builds cells (units, each `size` across, on that grid: see buildCells) in one go: filled with
   * `material` (only where there's room: what's there stays; water there goes), or (`clear`)
   * cleared (every solid voxel touching them goes). Placed objects are kept clear of. Returns what
   * changed (null: nothing), how many cells went in (or voxels went), and each block changed, as it
   * was and as it is now (to undo it: see unbuild).
   */
  build(cells: readonly { x: number; y: number; z: number }[], size: number, material: MaterialId, clear: boolean): { result: EditResult | null; count: number; blocks: BuildChange[] } {
    const B = BLOCK_SIZE;
    const byBlock = new Map<string, { bx: number; by: number; bz: number; cells: { x: number; y: number; z: number }[] }>();
    for (const c of cells) {
      if (this.objects.size && this.objectIn({ x0: c.x, y0: c.y, z0: c.z, x1: c.x + size, y1: c.y + size, z1: c.z + size })) continue;
      const bx = this.wrapBlockX(Math.floor(c.x / B)), by = Math.floor(c.y / B), bz = Math.floor(c.z / B);
      const key = objectKey(bx, by, bz);
      let g = byBlock.get(key);
      if (!g) byBlock.set(key, (g = { bx, by, bz, cells: [] }));
      g.cells.push({ x: mod(c.x, B), y: mod(c.y, B), z: mod(c.z, B) });
    }
    const writes: { bx: number; by: number; bz: number; block: Block }[] = [], changes: BuildChange[] = [];
    let count = 0;
    // Which unit cells of a block the cells take (fill: and the solid voxels already there).
    const taken = new Uint8Array(B * B * B);
    for (const g of byBlock.values()) {
      const before = this.blockAt(g.bx, g.by, g.bz);
      if (before === undefined) continue;
      // (Filling an empty block: just the cells.)
      if (!clear && before === null) {
        const after = blockFromVoxels(g.cells.map((c) => ({ ...c, size, material })));
        count += g.cells.length;
        writes.push({ bx: g.bx, by: g.by, bz: g.bz, block: after });
        changes.push({ bx: g.bx, by: g.by, bz: g.bz, before, after });
        continue;
      }
      if (clear && before === null) continue;
      const voxels = blockVoxels(before);
      taken.fill(0);
      const mark = (v: { x: number; y: number; z: number; size: number }, into: Uint8Array) => {
        for (let y = v.y; y < v.y + v.size; y++) for (let z = v.z; z < v.z + v.size; z++) for (let x = v.x; x < v.x + v.size; x++) into[x + B * (z + B * y)] = 1;
      };
      const touches = (v: { x: number; y: number; z: number; size: number }, m: Uint8Array) => {
        for (let y = v.y; y < v.y + v.size; y++) for (let z = v.z; z < v.z + v.size; z++) for (let x = v.x; x < v.x + v.size; x++) if (m[x + B * (z + B * y)]) return true;
        return false;
      };
      let next: BlockVoxel[];
      if (clear) {
        for (const c of g.cells) mark({ ...c, size }, taken);
        next = voxels.filter((v) => isWater(v.material) || !touches(v, taken));
        count += voxels.length - next.length;
      } else {
        for (const v of voxels) if (!isWater(v.material)) mark(v, taken);
        const added: BlockVoxel[] = [];
        for (const c of g.cells) {
          const v = { ...c, size };
          if (touches(v, taken)) continue;
          mark(v, taken);
          added.push({ ...v, material });
        }
        if (!added.length) continue;
        count += added.length;
        // (Water where they went: gone, as placing a voxel does.)
        next = [...voxels.filter((v) => !isWater(v.material) || !touches(v, taken)), ...added];
      }
      if (next.length === voxels.length && clear) continue;
      const after = blockFromVoxels(next);
      writes.push({ bx: g.bx, by: g.by, bz: g.bz, block: after });
      changes.push({ bx: g.bx, by: g.by, bz: g.bz, before, after });
    }
    if (!writes.length) return { result: null, count: 0, blocks: [] };
    const result = this.writeBlocks(writes);
    for (const w of writes) this.flow.touch(w.bx, w.by, w.bz);
    this.stats.edits++;
    return { result, count, blocks: changes };
  }

  /**
   * Undoes a build (its blocks as they were: see build), if none of them has changed since (else
   * nothing, and why not).
   */
  unbuild(changes: readonly BuildChange[]): EditResult | string {
    for (const c of changes) {
      const now = this.blockAt(c.bx, c.by, c.bz);
      if (now === undefined || !sameBlock(now, c.after)) return 'something there has changed since';
    }
    const result = this.writeBlocks(changes.map((c) => ({ bx: c.bx, by: c.by, bz: c.bz, block: c.before })));
    for (const c of changes) this.flow.touch(c.bx, c.by, c.bz);
    this.stats.edits++;
    return result;
  }

  /**
   * An arrow's hit at unit cell (x, y, z): knocks out the `piece` (units) of the voxel there (a
   * bigger one broken down to pieces that size first; a smaller one, whole). Nothing for water, a
   * placed object, an explosive (it only sticks in those) or nothing solid there; null then.
   */
  chip(x: number, y: number, z: number, piece: number): EditResult | null {
    const n = CHUNK_SIZE, cx = Math.floor(x / n), cy = Math.floor(y / n), cz = Math.floor(z / n);
    const resolved = resolveChunk(this.config, { cx, cy, cz });
    if (!resolved) return null;
    const chunk = this.current(resolved);
    const lx = x - cx * n, ly = y - cy * n, lz = z - cz * n;
    const block = chunk.blocks[blockIndex(Math.floor(lx / BLOCK_SIZE), Math.floor(ly / BLOCK_SIZE), Math.floor(lz / BLOCK_SIZE))] ?? null;
    const v = blockVoxelContaining(block, lx % BLOCK_SIZE, ly % BLOCK_SIZE, lz % BLOCK_SIZE);
    if (!v || isWater(v.material) || isExplosive(v.material) || this.objectAtPoint(x, y, z)) return null;
    try {
      const broken = v.size > piece ? this.applyEdit({ op: 'break', x, y, z, pieceSize: piece }) : null;
      const gone = this.applyEdit({ op: 'remove', x, y, z });
      return broken ? mergeResults(broken, gone) : gone;
    } catch (err) {
      if (err instanceof EditError) return null;
      throw err;
    }
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
      const box = objectBox(o), B = BLOCK_SIZE;
      const near = (lo: number, hi: number, v: number) => Math.max(0, lo - v, v - hi);
      const cx = deltaX(this.config, x, o.x * B + (box.x0 + box.x1) / 2);
      const dx = o.kind === 'design' ? Math.max(0, Math.abs(cx) - (box.x1 - box.x0) / 2) : cx;
      const dz = o.kind === 'design' ? near(o.z * B + box.z0, o.z * B + box.z1, z) : (o.z + 0.5) * B - z;
      const dy = near(o.y * B + box.y0, o.y * B + box.y1, y);
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
      const changed = objectBlocks(next).length === 0 || (o.parts && JSON.stringify(designParts(design, o.facing, o.offset)) !== JSON.stringify(o.parts));
      if (changed) throw new EditError(`the ${design.name} design has changed since this one was placed: take it down and place it again`);
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
          if (this.objectsAt(bx, by, bz).some((o) => objectStation(o) === role)) return true;
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
    const t0 = performance.now(), range = this.generator.columnRange(resolved.cx, resolved.cz);
    this.mainThread.columnRanges++;
    this.mainThread.rangesMs += performance.now() - t0;
    return this.withEdits(resolved.cx, resolved.cz, range);
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
  getEncodedClimate(forWeather = false): Uint8Array | null {
    if (forWeather) {
      if (this.weatherClimateBytes === undefined) {
        const c = this.generator.climate?.(true) ?? null;
        this.weatherClimateBytes = c ? encodeClimate(c) : null;
      }
      return this.weatherClimateBytes;
    }
    if (this.climateBytes === undefined) {
      const c = this.generator.climate?.() ?? null;
      this.climateBytes = c ? encodeClimate(c) : null;
    }
    return this.climateBytes;
  }
  private weatherClimateBytes: Uint8Array | null | undefined;

  /**
   * A top-down map of generated terrain (edits aren't included): `cols` x
   * `rows` surface samples, one per `step` units at each cell's centre.
   * Cached per requested width.
   */
  private caves: ReturnType<NonNullable<ChunkGenerator['caveOverview']>> | undefined;

  /** Where the world's caves are, roughly (see caveOverview), worked out once; null without caves. */
  caveOverview(): ReturnType<NonNullable<ChunkGenerator['caveOverview']>> {
    if (this.caves === undefined) this.caves = this.generator.caveOverview?.() ?? null;
    return this.caves;
  }

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

  /**
   * The world's map `width` cells across (see getMap), encoded (see encodeWorldMap): made off the
   * main thread where there's a remote generator (a whole map takes about a second, which would
   * hold up everyone's edits), once (asking again while it's being made shares it).
   */
  encodedMap(width: number): Promise<Uint8Array> {
    let p = this.mapBytes.get(width);
    if (!p) {
      const step = Math.ceil(this.config.widthUnits / width);
      p = this.encodedMapArea(0, 0, step, Math.ceil(this.config.widthUnits / step), Math.ceil(this.config.depthUnits / step), false);
      this.mapBytes.set(width, p);
      p.catch(() => this.mapBytes.delete(width));
    }
    return p;
  }
  private readonly mapBytes = new Map<number, Promise<Uint8Array>>();

  /**
   * A map of part of the world (see mapArea), encoded: off the main thread where there's a remote
   * generator (half a second or more each); the last few kept (`keep`), so panning back is free.
   */
  encodedMapArea(x0: number, z0: number, step: number, cols: number, rows: number, keep = true): Promise<Uint8Array> {
    const key = `${x0},${z0},${step},${cols},${rows}`;
    const hit = this.areaBytes.get(key);
    if (hit) return hit;
    const p = this.remote?.map ? this.remote.map(x0, z0, step, cols, rows) : Promise.resolve(encodeWorldMap(this.mapArea(x0, z0, step, cols, rows)));
    if (keep) {
      this.areaBytes.set(key, p);
      p.catch(() => this.areaBytes.delete(key));
      while (this.areaBytes.size > MAP_AREAS_KEPT) this.areaBytes.delete(this.areaBytes.keys().next().value!);
    }
    return p;
  }
  private readonly areaBytes = new Map<string, Promise<Uint8Array>>();

  get cachedChunkCount(): number {
    return this.cache.size;
  }
}

/** Decoded chunks kept for looking at blocks (mobs, light: see lookedAt), and chunk columns' light tops (see lightTops, 1 KB each). */
const DECODED_KEPT = 512;
const LIGHT_TOPS_KEPT = 4096;

/** Zoomed-in maps kept (see encodedMapArea): each up to 768 KB. */
const MAP_AREAS_KEPT = 24;

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
