import * as THREE from 'three';
import {
  CHUNK_SIZE,
  MAX_CANCEL,
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
  private readonly meshes = new Map<string, { mesh: THREE.Object3D | null; mask: number }>();
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
    if (previous !== undefined) {
      // An update (e.g. an edit): rebuild this chunk's mesh and its neighbours',
      // whose border faces may change. Old meshes stay until replaced.
      for (const k of [key, ...this.neighborCoords(coord).map(chunkKey)]) {
        const m = this.meshes.get(k);
        if (m) m.mask = -1;
        // A job already meshing finishes (so a chunk changing faster than it meshes, like
        // flowing water, still updates), then meshes again.
        const job = this.jobs.get(k);
        if (job) job.stale = true;
      }
    }
    this.data.set(key, bytes);
    this.kinds.set(key, bytes ? summarizeChunk(bytes) : 'air');
    this.coords.set(key, coord);
    if (!meshNeighbors) return;
    this.tryMesh(key);
    for (const n of this.neighborCoords(coord)) this.tryMesh(chunkKey(n));
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
    const token = this.nextToken++;
    this.jobs.set(key, { token, mask });
    // Skipped if, by the time a worker is free, this job has been superseded or isn't rendered.
    void this.pool.run({ kind: 'chunk', center, neighbors }, () => this.jobs.get(key)?.token === token).then((res) => {
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
        this.setMesh(key, group.children.length ? group : null, mask);
      }
      if (job.stale) this.tryMesh(key);
      this.onChange();
    });
  }

  private setMesh(key: string, mesh: THREE.Object3D | null, mask: number): void {
    const prev = this.meshes.get(key)?.mesh;
    if (prev) disposePackedMesh(prev);
    const stale = this.stale.get(key);
    if (stale) {
      disposePackedMesh(stale);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
    if (mesh) this.scene.add(mesh);
    this.meshes.set(key, { mesh, mask });
  }
}
