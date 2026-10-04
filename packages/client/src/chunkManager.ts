import * as THREE from 'three';
import {
  BLOCKS_PER_AXIS,
  CHUNK_SIZE,
  MAX_CANCEL,
  chunkLighting,
  chunkKey,
  columnSpans,
  type ColumnRange,
  type Span,
  decodeChunk,
  readChunkHeader,
  resolveChunk,
  summarizeChunk,
  type Chunk,
  type ChunkCoord,
  type ClientMessage,
  type WorldConfig,
} from '@super-vox/shared';
import type { ColumnCoord } from './lod.js';
import { overlaps, staleToRetire, type Footprint } from './coverage.js';
import { createPackedMesh, disposePackedMesh, meshGpuBytes, meshQuads } from './meshFactory.js';
import { WATER_LAYER } from './water.js';
import { DIRS } from './mesher.js';
import type { MeshWorkerPool } from './workerPool.js';
import { BOX, aroundIndex, type LightInput } from './skyLight.js';
import type { LightWorld } from '@super-vox/shared';

export interface ChunkStats {
  columns: number;
  loaded: number;
  inFlight: number;
  queued: number;
  meshed: number;
  meshing: number;
  triangles: number;
  gpuBytes: number;
  errors: number;
}

/** Horizontal directions (indices into DIRS) and their column offsets. */
const HORIZONTAL = [
  { dir: 0, dx: 1, dz: 0 },
  { dir: 1, dx: -1, dz: 0 },
  { dir: 4, dx: 0, dz: 1 },
  { dir: 5, dx: 0, dz: -1 },
] as const;

const colKey = (cx: number, cz: number) => `${cx},${cz}`;

/** Most chunk data (bytes) and columns kept after they leave the region (see ChunkManager.recent). */
const MAX_RECENT_BYTES = 32 * 1024 * 1024;
const MAX_RECENT_COLUMNS = 8192;

/**
 * Column requests outstanding at once, by default (see pump). Enough to cover the round trip to
 * a distant server for a wide detail area (detail 8 brings 17 new columns per 16 m flown).
 */
export const MAX_COLUMNS_IN_FLIGHT = 16;

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Full-detail chunks for a region of chunk columns. For each column it asks
 * the server for the ground's height range and renders only the chunk layers
 * that contain the surface. Chunks on the region's edge are meshed with their
 * outside neighbours treated as empty, so they draw walls that meet the
 * low-detail tiles beyond. Meshes that leave the region stay visible until
 * `retireStale()` so nothing disappears before its replacement is ready.
 */
export class ChunkManager {
  private region = new Set<string>();
  /** Columns just outside the region: their chunks are loaded (not drawn) so walking on finds them ready. */
  private ring = new Set<string>();
  /**
   * Recently used chunks and columns that left the region, kept (oldest first) so coming back
   * needs no server round trip. Kept current by the edits the server sends; cleared on reconnect.
   */
  private readonly recent = new Map<string, { coord: ChunkCoord; bytes: Uint8Array }>();
  private recentBytes = 0;
  private readonly recentRanges = new Map<string, ColumnRange | null>();
  /** Chunk-layer range per column; null for columns outside the world. */
  private readonly ranges = new Map<string, ColumnRange | null>();
  /** Height of the viewer (units), which decides how much is drawn under water (see columnSpans). */
  private viewY: number | undefined;
  private readonly columnRequested = new Set<string>();
  private columnQueue: ColumnCoord[] = [];

  /** Encoded chunk bytes; null means known empty (outside the world). */
  private readonly data = new Map<string, Uint8Array | null>();
  private readonly kinds = new Map<string, 'air' | 'solid' | 'mixed'>();
  /** Per loaded chunk, which blocks stop light (null: none; see chunkOpacity), and per block column the highest that does (-1: none). */
  private readonly opacity = new Map<string, Uint8Array | null>();
  private readonly tops = new Map<string, Int8Array | null>();
  /** Per loaded chunk, the blocks giving light (torches; see chunkLighting), null for none. */
  private readonly glow = new Map<string, Uint16Array | null>();
  /** Decoded chunks for picking, built on demand and dropped when data changes. */
  private readonly decoded = new Map<string, Chunk | null>();
  private readonly coords = new Map<string, ChunkCoord>();
  private readonly requested = new Set<string>();
  private queue: ChunkCoord[] = [];
  private inFlight = 0;

  private render = new Set<string>();
  /** The rendered chunks of each column (for covers). */
  private renderByColumn = new Map<string, string[]>();
  private wanted = new Set<string>();
  /** Current mesh per rendered chunk (null = no visible faces) and the open-side mask it was built with. */
  /** Per chunk: its terrain and water meshes (a group), or null for nothing to draw. */
  private readonly meshes = new Map<string, { mesh: THREE.Object3D | null; mask: number; shaded?: boolean }>();
  /** Mesh jobs running; `stale` once the chunk (or a neighbour) changed since it started. */
  private readonly jobs = new Map<string, { token: number; mask: number; stale?: boolean }>();
  /** Meshes kept, after leaving the selection, until their replacements are in (oldest first). */
  private readonly stale = new Map<string, THREE.Object3D>();
  /** When each stale mesh was retired (performance.now()). */
  private readonly staleAt = new Map<string, number>();
  private nextToken = 1;
  private errors = 0;
  private focusX = 0;
  private focusZ = 0;

  constructor(
    private readonly world: WorldConfig,
    private readonly scene: THREE.Scene,
    private readonly material: THREE.Material,
    /** For water surfaces (drawn on WATER_LAYER). */
    private readonly waterMaterial: THREE.Material,
    private readonly send: (msg: ClientMessage) => void,
    private readonly pool: MeshWorkerPool,
    private readonly maxInFlight: number,
    private readonly onChange: () => void,
    private readonly maxColumnsInFlight = MAX_COLUMNS_IN_FLIGHT,
  ) {}

  get stats(): ChunkStats {
    let triangles = 0, gpuBytes = 0, meshed = 0;
    const count = (m: THREE.Object3D) => {
      triangles += meshQuads(m) * 2;
      gpuBytes += meshGpuBytes(m);
    };
    for (const { mesh } of this.meshes.values()) {
      meshed++;
      if (mesh) count(mesh);
    }
    for (const m of this.stale.values()) count(m);
    return {
      columns: this.region.size,
      loaded: this.data.size,
      inFlight: this.inFlight,
      queued: this.queue.length + this.columnQueue.length,
      meshed,
      meshing: this.jobs.size,
      triangles,
      gpuBytes,
      errors: this.errors,
    };
  }

  /** True when nothing is queued, in flight, or being meshed. */
  get idle(): boolean {
    return this.queue.length === 0 && this.columnQueue.length === 0 && this.inFlight === 0 && this.jobs.size === 0;
  }

  get staleCount(): number {
    return this.stale.size;
  }

  /** Sets the full-detail region; `focusX/Z` (units) orders loading nearest first. */
  setRegion(columns: ColumnCoord[], focusX: number, focusZ: number): void {
    this.focusX = focusX;
    this.focusZ = focusZ;
    this.region = new Set(columns.map((c) => colKey(c.cx, c.cz)));
    // The ring: columns next to the region (8 neighbours) but not in it.
    const ring: ColumnCoord[] = [];
    this.ring = new Set();
    for (const c of columns) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = colKey(c.cx + dx, c.cz + dz);
          if (this.region.has(k) || this.ring.has(k)) continue;
          this.ring.add(k);
          ring.push({ cx: c.cx + dx, cz: c.cz + dz });
        }
      }
    }
    for (const [key, range] of [...this.ranges]) {
      if (this.knows(key)) continue;
      this.ranges.delete(key);
      this.remember(this.recentRanges, key, range, MAX_RECENT_COLUMNS);
    }
    // Columns seen recently need no asking.
    for (const key of [...this.region, ...this.ring]) {
      if (this.ranges.has(key) || !this.recentRanges.has(key)) continue;
      this.ranges.set(key, this.recentRanges.get(key)!);
      this.recentRanges.delete(key);
    }
    const d = (c: ColumnCoord) => Math.hypot((c.cx + 0.5) * CHUNK_SIZE - focusX, (c.cz + 0.5) * CHUNK_SIZE - focusZ);
    const missing = (c: ColumnCoord) => !this.ranges.has(colKey(c.cx, c.cz)) && !this.columnRequested.has(colKey(c.cx, c.cz));
    // The region nearest first, then the ring.
    this.columnQueue = [...columns.filter(missing).sort((a, b) => d(a) - d(b)), ...ring.filter(missing).sort((a, b) => d(a) - d(b))];
    this.recompute();
  }

  /** Whether a column's chunks are wanted (in the region or its ring). */
  private knows(key: string): boolean {
    return this.region.has(key) || this.ring.has(key);
  }

  /** Keeps `value` under `key` as the newest entry, dropping the oldest past `max`. */
  private remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value!);
  }

  private rememberChunk(key: string, coord: ChunkCoord, bytes: Uint8Array): void {
    const old = this.recent.get(key);
    if (old) {
      this.recentBytes -= old.bytes.byteLength;
      this.recent.delete(key);
    }
    this.recent.set(key, { coord, bytes });
    this.recentBytes += bytes.byteLength;
    while (this.recentBytes > MAX_RECENT_BYTES) {
      const [k, oldest] = this.recent.entries().next().value!;
      this.recent.delete(k);
      this.recentBytes -= oldest.bytes.byteLength;
    }
  }

  /**
   * The chunk X coordinates near the focus that `cx` stands for. On a world that wraps east-west
   * the client keeps going past the seam (chunk -1 is the world's last column), while the server
   * names chunks by where they are in the world; so what it sends goes to every copy near here.
   */
  private copiesOf(cx: number): number[] {
    if (!this.world.wrapX) return [cx];
    const n = this.world.widthUnits / CHUNK_SIZE;
    const k = Math.round((this.focusX / CHUNK_SIZE - cx) / n);
    return [cx + (k - 1) * n, cx + k * n, cx + (k + 1) * n];
  }

  /**
   * The viewer's height (units). Under water, more of the ground below is drawn (and the layer
   * the viewer is in is loaded); this reselects when that changes.
   */
  setViewY(y: number): void {
    const before = this.viewY;
    this.viewY = y;
    if (before !== undefined && Math.floor(y / CHUNK_SIZE) === Math.floor(before / CHUNK_SIZE)) return;
    // Only columns with water above the viewer (before or now) draw differently.
    const low = before === undefined ? y : Math.min(y, before);
    for (const range of this.ranges.values()) {
      if (range?.water && range.water.max > low) {
        this.recompute();
        return;
      }
    }
  }

  onColumn(msg: { cx: number; cz: number; minY: number | null; maxY: number | null; solidTop?: number; water?: { min: number; max: number }; sent?: Span[] }): void {
    let changed = false;
    for (const cx of this.copiesOf(msg.cx)) {
      const key = colKey(cx, msg.cz);
      if (this.columnRequested.delete(key)) {
        this.inFlight--;
        // The server sends these chunks next, unasked: count them as requested.
        for (const span of msg.sent ?? []) {
          for (let cy = span.lo; cy <= span.hi; cy++) {
            const k = chunkKey({ cx, cy, cz: msg.cz });
            if (this.requested.has(k)) continue;
            this.requested.add(k);
            this.inFlight++;
          }
        }
      }
      const { minY, maxY, solidTop, water } = msg;
      const range = minY === null || maxY === null ? null : { minY, maxY, ...(solidTop !== undefined && water ? { solidTop, water } : {}) };
      if (this.knows(key)) {
        this.ranges.set(key, range);
        changed = true;
      } else if (this.recentRanges.has(key)) this.recentRanges.set(key, range); // an edit while we're away
    }
    if (changed) this.recompute();
    else this.pump();
    this.onChange();
  }

  onChunkBytes(bytes: Uint8Array): void {
    const coord = readChunkHeader(bytes);
    for (const cx of this.copiesOf(coord.cx)) {
      const c = { ...coord, cx }, key = chunkKey(c);
      if (this.requested.delete(key)) this.inFlight--;
      if (this.wanted.has(key)) this.store(key, c, bytes);
      else if (this.recent.has(key)) this.rememberChunk(key, c, bytes); // an edit while we're away
    }
    this.pump();
    this.onChange();
  }

  onChunkUnavailable(coord: ChunkCoord): void {
    for (const cx of this.copiesOf(coord.cx)) {
      const c = { ...coord, cx }, key = chunkKey(c);
      if (this.requested.delete(key)) this.inFlight--;
      if (this.wanted.has(key)) this.store(key, c, null);
    }
    this.pump();
    this.onChange();
  }

  /** Forget everything in flight, e.g. after a reconnect. */
  resetRequests(): void {
    this.requested.clear();
    this.columnRequested.clear();
    this.inFlight = 0;
    // While disconnected, edits may have been missed: what isn't in use is asked for afresh.
    this.recent.clear();
    this.recentBytes = 0;
    this.recentRanges.clear();
  }

  /**
   * Removes meshes that left the region: all of them (once replacements are in place), or those
   * that left more than `maxAgeMs` ago (while moving, everything is never in place at once).
   */
  retireStale(maxAgeMs?: number, now = performance.now()): void {
    for (const [key, m] of this.stale) {
      if (maxAgeMs !== undefined && now - this.staleAt.get(key)! < maxAgeMs) break; // the rest are newer
      disposePackedMesh(m);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
  }

  /**
   * Drops replaced meshes whose ground `covered` (by chunks and tiles) says is drawn again, and
   * any older than `maxAgeMs`.
   */
  retireCovered(covered: (f: Footprint) => boolean, maxAgeMs: number, now = performance.now()): void {
    const footprint = (key: string): Footprint => {
      const [cx, , cz] = key.split(',').map(Number) as [number, number, number];
      return { x0: cx * CHUNK_SIZE, z0: cz * CHUNK_SIZE, x1: (cx + 1) * CHUNK_SIZE, z1: (cz + 1) * CHUNK_SIZE };
    };
    for (const key of staleToRetire(this.stale.keys(), (k) => this.staleAt.get(k)!, footprint, covered, maxAgeMs, now)) {
      disposePackedMesh(this.stale.get(key)!);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
  }

  /** Whether column (cx, cz) is drawn as voxel chunks now: in the region, known, its chunks all meshed. */
  drawnColumn(cx: number, cz: number): boolean {
    const key = colKey(cx, cz);
    if (!this.region.has(key) || !this.ranges.has(key)) return false;
    for (const chunk of this.renderByColumn.get(key) ?? []) if (!this.meshes.has(chunk)) return false;
    return true;
  }

  /** Whether every region column on this ground is drawn (its chunks all meshed). */
  covers(f: Footprint): boolean {
    for (const key of this.region) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      if (!overlaps(f, { x0: cx * CHUNK_SIZE, z0: cz * CHUNK_SIZE, x1: (cx + 1) * CHUNK_SIZE, z1: (cz + 1) * CHUNK_SIZE })) continue;
      if (!this.ranges.has(key)) return false;
      for (const chunk of this.renderByColumn.get(key) ?? []) if (!this.meshes.has(chunk)) return false;
    }
    return true;
  }

  dispose(): void {
    this.retireStale();
    for (const { mesh } of this.meshes.values()) if (mesh) disposePackedMesh(mesh);
    this.meshes.clear();
  }

  /** Bit d set when the horizontal neighbour in direction d lies outside the region. */
  private openMask(c: ChunkCoord): number {
    let mask = 0;
    for (const { dir, dx, dz } of HORIZONTAL) if (!this.region.has(colKey(c.cx + dx, c.cz + dz))) mask |= 1 << dir;
    return mask;
  }

  private recompute(): void {
    const render = new Set<string>();
    const wanted = new Set<string>();
    const coords = new Map<string, ChunkCoord>();
    const want = (c: ChunkCoord) => {
      const k = chunkKey(c);
      wanted.add(k);
      coords.set(k, c);
      return k;
    };
    for (const key of this.region) {
      const range = this.ranges.get(key);
      if (!range) continue;
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      for (const span of columnSpans(range, this.viewY)) for (let cy = span.lo; cy <= span.hi; cy++) {
        render.add(want({ cx, cy, cz }));
        want({ cx, cy: cy - 1, cz });
        want({ cx, cy: cy + 1, cz });
        // Neighbours in the region, once we know their column (whose own chunks come with it).
        for (const { dx, dz } of HORIZONTAL) {
          const n = colKey(cx + dx, cz + dz);
          if (this.region.has(n) && this.ranges.has(n)) want({ cx: cx + dx, cy, cz: cz + dz });
        }
      }
    }
    // The ring: what the server sends with each column (its drawn layers and one either side), not drawn.
    for (const key of this.ring) {
      const range = this.ranges.get(key);
      if (!range) continue;
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      for (const span of columnSpans(range, this.viewY)) for (let cy = span.lo - 1; cy <= span.hi + 1; cy++) want({ cx, cy, cz });
    }
    this.render = render;
    this.renderByColumn = new Map();
    for (const k of render) {
      const [cx, , cz] = k.split(',');
      const col = `${cx},${cz}`;
      const list = this.renderByColumn.get(col);
      if (list) list.push(k);
      else this.renderByColumn.set(col, [k]);
    }
    this.wanted = wanted;

    // Requests nobody wants any more (we moved on): tell the server not to bother.
    const chunks: [number, number, number][] = [], columns: [number, number][] = [];
    for (const key of this.requested) {
      if (wanted.has(key)) continue;
      this.requested.delete(key);
      this.inFlight--;
      chunks.push(key.split(',').map(Number) as [number, number, number]);
    }
    for (const key of this.columnRequested) {
      if (this.knows(key)) continue;
      this.columnRequested.delete(key);
      this.inFlight--;
      columns.push(key.split(',').map(Number) as [number, number]);
    }
    for (let i = 0; i < Math.max(chunks.length, columns.length); i += MAX_CANCEL) {
      this.send({ type: 'cancel', chunks: chunks.slice(i, i + MAX_CANCEL), columns: columns.slice(i, i + MAX_CANCEL) });
    }

    for (const key of [...this.data.keys()]) {
      if (!wanted.has(key)) {
        const bytes = this.data.get(key);
        if (bytes) this.rememberChunk(key, this.coords.get(key)!, bytes);
        this.data.delete(key);
        this.kinds.delete(key);
        this.opacity.delete(key);
        this.tops.delete(key);
        this.glow.delete(key);
        this.coords.delete(key);
        this.decoded.delete(key);
      }
    }
    for (const [key, { mesh }] of [...this.meshes]) {
      if (render.has(key)) continue;
      this.meshes.delete(key);
      if (mesh) this.retire(key, mesh);
    }
    for (const key of [...this.jobs.keys()]) if (!render.has(key)) this.jobs.delete(key);

    const toLoad: { c: ChunkCoord; d: number }[] = [];
    for (const key of wanted) {
      if (this.data.has(key) || this.requested.has(key)) continue;
      const c = coords.get(key)!;
      const cached = this.recent.get(key);
      if (cached) {
        // Seen recently: back from the cache, no request.
        this.recent.delete(key);
        this.recentBytes -= cached.bytes.byteLength;
        this.store(key, c, cached.bytes, false);
        continue;
      }
      if (!resolveChunk(this.world, c)) {
        this.store(key, c, null, false);
        continue;
      }
      const d = Math.hypot((c.cx + 0.5) * CHUNK_SIZE - this.focusX, (c.cz + 0.5) * CHUNK_SIZE - this.focusZ);
      toLoad.push({ c, d });
    }
    toLoad.sort((a, b) => a.d - b.d);
    this.queue = toLoad.map((t) => t.c);
    for (const key of render) this.tryMesh(key);
    this.pump();
  }

  private retire(key: string, mesh: THREE.Object3D): void {
    const old = this.stale.get(key);
    if (old) disposePackedMesh(old);
    this.stale.delete(key);
    this.stale.set(key, mesh);
    this.staleAt.set(key, performance.now());
  }

  private pump(): void {
    // Few columns at a time: each brings its chunks (counted in flight once its reply arrives), so
    // more would let the server's queue grow past what we can cancel when we move on.
    while (this.inFlight < this.maxInFlight && this.columnRequested.size < this.maxColumnsInFlight && this.columnQueue.length > 0) {
      const c = this.columnQueue.shift()!;
      const key = colKey(c.cx, c.cz);
      if (!this.knows(key) || this.ranges.has(key) || this.columnRequested.has(key)) continue;
      this.columnRequested.add(key);
      this.inFlight++;
      this.send({ type: 'requestColumn', cx: c.cx, cz: c.cz });
    }
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const c = this.queue.shift()!;
      const key = chunkKey(c);
      if (this.data.has(key) || this.requested.has(key) || !this.wanted.has(key)) continue;
      this.requested.add(key);
      this.inFlight++;
      this.send({ type: 'requestChunk', ...c });
    }
  }

  /**
   * The decoded chunk for picking: a Chunk, null if known empty, or
   * undefined if it isn't loaded.
   */
  /**
   * Whether we know what's in chunk `coord`: it's here, or its column is known and it's above (or
   * below) everything in it, so it's empty (never sent: nothing to send).
   */
  known(coord: ChunkCoord): boolean {
    if (this.chunkAt(coord) !== undefined) return true;
    const range = this.ranges.get(colKey(coord.cx, coord.cz));
    if (range === undefined) return false;
    return range === null || coord.cy * CHUNK_SIZE > range.maxY || (coord.cy + 1) * CHUNK_SIZE <= range.minY;
  }

  chunkAt(coord: ChunkCoord): Chunk | null | undefined {
    const key = chunkKey(coord);
    if (this.decoded.has(key)) return this.decoded.get(key);
    const bytes = this.data.get(key);
    if (bytes === undefined) return undefined;
    const chunk = bytes ? decodeChunk(bytes) : null;
    this.decoded.set(key, chunk);
    return chunk;
  }

  private store(key: string, coord: ChunkCoord, bytes: Uint8Array | null, meshNeighbors = true): void {
    const previous = this.data.get(key);
    // The same chunk again (e.g. sent with its column after we had it as a neighbour): nothing to do.
    if (previous !== undefined && sameBytes(previous, bytes)) return;
    this.decoded.delete(key);
    const { opaque: opacity, glow } = bytes ? chunkLighting(bytes) : { opaque: null, glow: null };
    const tops = opacity && topsOf(opacity);
    // Where its light may change (see lightChanged), worked out before it's stored.
    const relit = meshNeighbors ? this.lightChanged(coord, this.tops.get(key), tops, !sameGlow(this.glow.get(key) ?? null, glow)) : [];
    const redo = (k: string) => {
      const m = this.meshes.get(k);
      if (m) m.mask = -1;
      // A job already meshing finishes (so a chunk changing faster than it meshes, like
      // flowing water, still updates), then meshes again.
      const job = this.jobs.get(k);
      if (job) job.stale = true;
    };
    // An update (e.g. an edit): rebuild this chunk's mesh and its neighbours', whose border faces
    // may change. Old meshes stay until replaced.
    if (previous !== undefined) for (const k of [key, ...this.neighborCoords(coord).map(chunkKey)]) redo(k);
    for (const k of relit) redo(k);
    this.data.set(key, bytes);
    this.kinds.set(key, bytes ? summarizeChunk(bytes) : 'air');
    this.opacity.set(key, opacity);
    this.tops.set(key, tops);
    this.glow.set(key, glow);
    this.coords.set(key, coord);
    if (!meshNeighbors) return;
    this.tryMesh(key);
    for (const n of this.neighborCoords(coord)) this.tryMesh(chunkKey(n));
    // Those waiting for it for their light (around it, and below it in the columns around).
    for (const k of this.lightWaiters(coord)) this.tryMesh(k);
    for (const k of relit) this.tryMesh(k);
  }

  /**
   * The loaded world as light sees it (see lightAt): for shading what isn't meshed (mobs). Chunks
   * not here: above everything in their column, open; otherwise rock.
   */
  lightWorld(): LightWorld {
    const n = BLOCKS_PER_AXIS;
    const chunkOf = (bx: number, by: number, bz: number) => ({ cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) });
    const local = (bx: number, by: number, bz: number) => (((bx % n) + n) % n) + n * ((((bz % n) + n) % n) + n * (((by % n) + n) % n));
    const opaque = (bx: number, by: number, bz: number) => {
      const c = chunkOf(bx, by, bz), k = chunkKey(c);
      if (this.data.has(k)) return this.opacity.get(k)?.[local(bx, by, bz)] === 1;
      const range = this.ranges.get(colKey(c.cx, c.cz));
      return !(range === null || (range && c.cy * CHUNK_SIZE > range.maxY));
    };
    return {
      opaque,
      glow: (bx, by, bz) => {
        const g = this.glow.get(chunkKey(chunkOf(bx, by, bz)));
        if (!g) return 0;
        const i = local(bx, by, bz);
        for (const v of g) if (v >> 4 === i) return v & 15;
        return 0;
      },
      skyOpen: (bx, by, bz) => {
        const c = chunkOf(bx, by, bz), range = this.ranges.get(colKey(c.cx, c.cz));
        if (!range) return true;
        const i = local(bx, 0, bz), ly = by - c.cy * n;
        for (let cy = c.cy; cy * CHUNK_SIZE <= range.maxY; cy++) {
          const k = chunkKey({ cx: c.cx, cy, cz: c.cz });
          if (!this.data.has(k)) continue;
          const t = this.tops.get(k)?.[i] ?? -1;
          if (cy === c.cy ? t > ly : t >= 0) return false;
        }
        return true;
      },
    };
  }

  /** Rendered chunks whose light this one is part of: around it (3 x 3 x 3), and below it in the columns around. */
  private lightWaiters(c: ChunkCoord): string[] {
    const out: string[] = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const k of this.renderByColumn.get(colKey(c.cx + dx, c.cz + dz)) ?? []) {
          const cy = Number(k.split(',')[1]);
          if (cy <= c.cy + 1) out.push(k);
        }
    return out;
  }

  /**
   * Meshed chunks whose light may change when chunk `c`'s light-stopping blocks change (from
   * column tops `before` to `after`, see topsOf; undefined: it wasn't here): those around it in
   * shade (light reaches 15 blocks, so no further; those lit throughout stay so unless the sky is
   * shut off over them), all of those around it if `glowChanged` (a torch put up or taken down),
   * and, where the highest block stopping light in a column moves, those around the blocks that
   * are open to the sky now and weren't, or were and aren't.
   */
  private lightChanged(c: ChunkCoord, before: Int8Array | null | undefined, after: Int8Array | null, glowChanged = false): string[] {
    const out = new Set<string>();
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = chunkKey({ cx: c.cx + dx, cy: c.cy + dy, cz: c.cz + dz });
          const m = this.meshes.get(k);
          if (m && (m.shaded || glowChanged)) out.add(k);
        }
    // (Only meshed chunks need redoing: those still to mesh get it right when they are.)
    const meshed: string[] = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const k of this.renderByColumn.get(colKey(c.cx + dx, c.cz + dz)) ?? []) if (this.meshes.has(k)) meshed.push(k);
    if (!meshed.length) return [...out];
    const layer = new Map<number, Int8Array | null | undefined>();
    const topsAt = (cy: number) => {
      if (!layer.has(cy)) layer.set(cy, this.tops.get(chunkKey({ cx: c.cx, cy, cz: c.cz })));
      return layer.get(cy);
    };
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < BLOCKS_PER_AXIS * BLOCKS_PER_AXIS; i++) {
      const was = before?.[i] ?? -1, now = after?.[i] ?? -1;
      if (was === now || this.stopsAbove(c, i, topsAt)) continue;
      const below = was < 0 || now < 0 ? this.topBelow(c, i, topsAt) : 0;
      const a = was < 0 ? below : c.cy * BLOCKS_PER_AXIS + was, b = now < 0 ? below : c.cy * BLOCKS_PER_AXIS + now;
      lo = Math.min(lo, Math.min(a, b) + 1);
      hi = Math.max(hi, Math.max(a, b));
    }
    if (lo <= hi) {
      const l0 = Math.floor(lo / BLOCKS_PER_AXIS) - 1, l1 = Math.floor(hi / BLOCKS_PER_AXIS) + 1;
      for (const k of meshed) {
        const cy = Number(k.split(',')[1]);
        if (cy >= l0 && cy <= l1) out.add(k);
      }
    }
    return [...out];
  }

  /** Whether anything loaded above chunk `c` stops light in its block column `i` (bx + 16 bz). */
  private stopsAbove(c: ChunkCoord, i: number, topsAt: (cy: number) => Int8Array | null | undefined): boolean {
    const range = this.ranges.get(colKey(c.cx, c.cz));
    if (!range) return false;
    for (let cy = c.cy + 1; cy * CHUNK_SIZE <= range.maxY; cy++) {
      const t = topsAt(cy);
      if (t && t[i]! >= 0) return true;
    }
    return false;
  }

  /** The highest block (y, blocks) stopping light in block column `i` below chunk `c`, as far as we know. */
  private topBelow(c: ChunkCoord, i: number, topsAt: (cy: number) => Int8Array | null | undefined): number {
    const range = this.ranges.get(colKey(c.cx, c.cz));
    if (!range) return c.cy * BLOCKS_PER_AXIS - 1;
    for (let cy = c.cy - 1; ; cy--) {
      // (Below everything in the column: rock.)
      if ((cy + 1) * CHUNK_SIZE <= range.minY) return (cy + 1) * BLOCKS_PER_AXIS - 1;
      const t = topsAt(cy);
      if (t && t[i]! >= 0) return cy * BLOCKS_PER_AXIS + t[i]!;
    }
  }

  /**
   * What chunk `c`'s light is worked out from (see skyLight), or undefined while a chunk it needs
   * is on its way. Chunks not here are worked out from their column: above everything in it,
   * open; below, rock; unknown, rock (nothing lights through them).
   */
  private lightInput(c: ChunkCoord): LightInput | undefined {
    const opaque: (Uint8Array | 0 | 1)[] = new Array(27);
    const glow: (Uint16Array | null)[] = new Array(27).fill(null);
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const n = { cx: c.cx + dx, cy: c.cy + dy, cz: c.cz + dz }, k = chunkKey(n);
          let o: Uint8Array | 0 | 1;
          if (this.data.has(k)) o = this.opacity.get(k) ?? 0;
          else {
            const col = colKey(n.cx, n.cz), range = this.ranges.get(col);
            // (A column not known yet: rock. That can only make it darker than it is, and meshes
            // in shade are made again as what's around them comes in, see lightChanged.)
            if (range === undefined) o = 1;
            else if (range === null || n.cy * CHUNK_SIZE > range.maxY) o = 0;
            else if ((n.cy + 1) * CHUNK_SIZE <= range.minY) o = 1;
            else if (this.wanted.has(k)) return undefined;
            else o = 1;
          }
          opaque[aroundIndex(dx, dy, dz)] = o;
          glow[aroundIndex(dx, dy, dz)] = this.glow.get(k) ?? null;
        }
    // Above the box: anything in the columns around that stops light.
    const above = new Uint8Array(BOX * BOX), n = BLOCKS_PER_AXIS;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const range = this.ranges.get(colKey(c.cx + dx, c.cz + dz));
        if (!range) continue;
        for (let cy = c.cy + 2; cy * CHUNK_SIZE <= range.maxY; cy++) {
          const k = chunkKey({ cx: c.cx + dx, cy, cz: c.cz + dz });
          if (!this.data.has(k)) {
            if (this.wanted.has(k)) return undefined;
            continue;
          }
          const t = this.tops.get(k);
          if (!t) continue;
          for (let bz = 0; bz < n; bz++)
            for (let bx = 0; bx < n; bx++) if (t[bx + n * bz]! >= 0) above[(dx + 1) * n + bx + BOX * ((dz + 1) * n + bz)] = 1;
        }
      }
    return { opaque, above, ...(glow.some((g) => g) ? { glow } : {}) };
  }

  private neighborCoords(c: ChunkCoord): ChunkCoord[] {
    return DIRS.map(({ axis, sign }) => ({
      cx: c.cx + (axis === 0 ? sign : 0),
      cy: c.cy + (axis === 1 ? sign : 0),
      cz: c.cz + (axis === 2 ? sign : 0),
    }));
  }

  private tryMesh(key: string): void {
    if (!this.render.has(key)) return;
    const coord = this.coords.get(key);
    const center = this.data.get(key);
    if (!coord || center === undefined) return;
    let mask = this.openMask(coord);
    const running = this.jobs.get(key);
    if (running?.stale) return; // meshes again when it's done
    if (this.meshes.get(key)?.mask === mask || running?.mask === mask) return;

    if (center === null || this.kinds.get(key) === 'air') {
      this.setMesh(key, null, mask);
      return;
    }
    const neighbors: (Uint8Array | null)[] = [];
    let buried = this.kinds.get(key) === 'solid' && mask === 0;
    for (const [d, n] of this.neighborCoords(coord).entries()) {
      if (mask & (1 << d)) {
        neighbors.push(null);
        continue;
      }
      const nk = chunkKey(n);
      const bytes = this.data.get(nk);
      if (bytes === undefined) return; // not loaded yet
      neighbors.push(bytes);
      if (this.kinds.get(nk) !== 'solid') buried = false;
    }
    if (buried) {
      this.setMesh(key, null, mask);
      return;
    }
    const light = this.lightInput(coord);
    if (!light) return; // meshed once what it needs is in
    const token = this.nextToken++;
    this.jobs.set(key, { token, mask });
    // Skipped if, by the time a worker is free, this job has been superseded or isn't rendered.
    void this.pool.run({ kind: 'chunk', center, neighbors, light }, () => this.jobs.get(key)?.token === token).then((res) => {
      const job = this.jobs.get(key);
      if (job?.token !== token) return; // superseded or no longer rendered
      this.jobs.delete(key);
      if (job.stale) mask = -1; // out of date: shown now, redone below
      if (res.error) {
        this.errors++;
        console.error(`[super-vox] meshing chunk ${key} failed: ${res.error}`);
      } else {
        const origin = { x: coord.cx * CHUNK_SIZE, y: coord.cy * CHUNK_SIZE, z: coord.cz * CHUNK_SIZE };
        const group = new THREE.Group();
        group.name = `chunk ${key}`;
        if (res.buffers) group.add(createPackedMesh(res.buffers, origin, this.material, `chunk ${key}`));
        if (res.water) {
          const water = createPackedMesh(res.water, origin, this.waterMaterial, `water ${key}`);
          water.layers.set(WATER_LAYER);
          water.renderOrder = 4; // before the far sea, which it hides
          group.add(water);
        }
        this.setMesh(key, group.children.length ? group : null, mask, res.shaded);
      }
      if (job.stale) this.tryMesh(key);
      this.onChange();
    });
  }

  private setMesh(key: string, mesh: THREE.Object3D | null, mask: number, shaded = false): void {
    const prev = this.meshes.get(key)?.mesh;
    if (prev) disposePackedMesh(prev);
    const stale = this.stale.get(key);
    if (stale) {
      disposePackedMesh(stale);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
    if (mesh) this.scene.add(mesh);
    this.meshes.set(key, { mesh, mask, shaded });
  }
}

function sameGlow(a: Uint16Array | null, b: Uint16Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Per block column (bx + 16 bz) of a chunk, the highest block that stops light (see chunkOpacity), -1 for none. */
function topsOf(opacity: Uint8Array): Int8Array {
  const n = BLOCKS_PER_AXIS, out = new Int8Array(n * n).fill(-1);
  for (let i = 0; i < n * n; i++)
    for (let by = n - 1; by >= 0; by--)
      if (opacity[i + n * n * by]) {
        out[i] = by;
        break;
      }
  return out;
}
