import * as THREE from 'three';
import {
  CHUNK_SIZE,
  MAX_CANCEL,
  chunkKey,
  columnLayers,
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

/** Column requests outstanding at once (see pump). */
const MAX_COLUMNS_IN_FLIGHT = 4;

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
  /** Chunk-layer range per column; null for columns outside the world. */
  private readonly ranges = new Map<string, { lo: number; hi: number } | null>();
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
  private wanted = new Set<string>();
  /** Current mesh per rendered chunk (null = no visible faces) and the open-side mask it was built with. */
  /** Per chunk: its terrain and water meshes (a group), or null for nothing to draw. */
  private readonly meshes = new Map<string, { mesh: THREE.Object3D | null; mask: number }>();
  /** Mesh jobs running; `stale` once the chunk (or a neighbour) changed since it started. */
  private readonly jobs = new Map<string, { token: number; mask: number; stale?: boolean }>();
  private readonly stale = new Map<string, THREE.Object3D>();
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
    for (const key of [...this.ranges.keys()]) if (!this.region.has(key)) this.ranges.delete(key);
    const d = (c: ColumnCoord) => Math.hypot((c.cx + 0.5) * CHUNK_SIZE - focusX, (c.cz + 0.5) * CHUNK_SIZE - focusZ);
    this.columnQueue = columns
      .filter((c) => !this.ranges.has(colKey(c.cx, c.cz)) && !this.columnRequested.has(colKey(c.cx, c.cz)))
      .sort((a, b) => d(a) - d(b));
    this.recompute();
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

  onColumn(msg: { cx: number; cz: number; minY: number | null; maxY: number | null; sent?: { lo: number; hi: number } }): void {
    let changed = false;
    for (const cx of this.copiesOf(msg.cx)) {
      const key = colKey(cx, msg.cz);
      if (this.columnRequested.delete(key)) {
        this.inFlight--;
        // The server sends these chunks next, unasked: count them as requested.
        if (msg.sent) {
          for (let cy = msg.sent.lo; cy <= msg.sent.hi; cy++) {
            const k = chunkKey({ cx, cy, cz: msg.cz });
            if (this.requested.has(k)) continue;
            this.requested.add(k);
            this.inFlight++;
          }
        }
      }
      if (this.region.has(key)) {
        this.ranges.set(key, msg.minY === null || msg.maxY === null ? null : columnLayers(msg.minY, msg.maxY));
        changed = true;
      }
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
  }

  /** Removes meshes that left the region (call once replacements are in place). */
  retireStale(): void {
    for (const m of this.stale.values()) disposePackedMesh(m);
    this.stale.clear();
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
      for (let cy = range.lo; cy <= range.hi; cy++) {
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
    this.render = render;
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
      if (this.region.has(key)) continue;
      this.columnRequested.delete(key);
      this.inFlight--;
      columns.push(key.split(',').map(Number) as [number, number]);
    }
    for (let i = 0; i < Math.max(chunks.length, columns.length); i += MAX_CANCEL) {
      this.send({ type: 'cancel', chunks: chunks.slice(i, i + MAX_CANCEL), columns: columns.slice(i, i + MAX_CANCEL) });
    }

    for (const key of [...this.data.keys()]) {
      if (!wanted.has(key)) {
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
    this.stale.set(key, mesh);
  }

  private pump(): void {
    // Few columns at a time: each brings its chunks (counted in flight once its reply arrives), so
    // more would let the server's queue grow past what we can cancel when we move on.
    while (this.inFlight < this.maxInFlight && this.columnRequested.size < MAX_COLUMNS_IN_FLIGHT && this.columnQueue.length > 0) {
      const c = this.columnQueue.shift()!;
      const key = colKey(c.cx, c.cz);
      if (!this.region.has(key) || this.ranges.has(key) || this.columnRequested.has(key)) continue;
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
    }
    if (mesh) this.scene.add(mesh);
    this.meshes.set(key, { mesh, mask });
  }
}
