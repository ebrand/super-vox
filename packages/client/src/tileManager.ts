import * as THREE from 'three';
import {
  MAX_CANCEL,
  MAX_TILE_LEVEL,
  readTileHeader,
  tileKey,
  tileSizeUnits,
  type ClientMessage,
  type TileCoord,
} from '@super-vox/shared';
import { createPackedMesh, disposePackedMesh, meshGpuBytes, meshQuads } from './meshFactory.js';
import { WATER_LAYER } from './water.js';
import type { MeshWorkerPool } from './workerPool.js';
import { overlaps, staleToRetire, type Footprint } from './coverage.js';

export interface TileStats {
  tiles: number;
  loaded: number;
  inFlight: number;
  queued: number;
  meshing: number;
  triangles: number;
  gpuBytes: number;
  errors: number;
}

/**
 * Low-detail tiles for distant terrain: requests the selected tiles nearest
 * first, meshes them in workers, and shows them. Tiles that leave the
 * selection stay visible until `retireStale()`.
 */
export class TileManager {
  private wanted = new Map<string, TileCoord>();
  private readonly loaded = new Set<string>();
  private readonly requested = new Set<string>();
  private queue: TileCoord[] = [];
  private inFlight = 0;
  private readonly meshes = new Map<string, THREE.Object3D | null>();
  private readonly jobs = new Map<string, number>();
  /** Meshes kept, after leaving the selection, until their replacements are in (oldest first). */
  private readonly stale = new Map<string, THREE.Object3D>();
  /** When each stale mesh was retired (performance.now()). */
  private readonly staleAt = new Map<string, number>();
  private nextToken = 1;
  private errors = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly material: THREE.Material,
    /** For rivers' and lakes' surfaces (drawn on WATER_LAYER). */
    private readonly waterMaterial: THREE.Material,
    private readonly send: (msg: ClientMessage) => void,
    private readonly pool: MeshWorkerPool,
    private readonly maxInFlight: number,
    private readonly onChange: () => void,
  ) {}

  get stats(): TileStats {
    let triangles = 0, gpuBytes = 0;
    for (const m of [...this.meshes.values(), ...this.stale.values()]) {
      if (!m) continue;
      triangles += meshQuads(m) * 2;
      gpuBytes += meshGpuBytes(m);
    }
    return {
      tiles: this.wanted.size,
      loaded: this.meshes.size,
      inFlight: this.inFlight,
      queued: this.queue.length,
      meshing: this.jobs.size,
      triangles,
      gpuBytes,
      errors: this.errors,
    };
  }

  get idle(): boolean {
    return this.queue.length === 0 && this.inFlight === 0 && this.jobs.size === 0;
  }

  get staleCount(): number {
    return this.stale.size;
  }

  setTiles(tiles: TileCoord[], focusX: number, focusZ: number): void {
    this.wanted = new Map(tiles.map((t) => [tileKey(t), t]));
    for (const [key, mesh] of [...this.meshes]) {
      if (this.wanted.has(key)) continue;
      this.meshes.delete(key);
      this.loaded.delete(key);
      if (mesh) this.retire(key, mesh);
    }
    // A tile dropped mid-mesh has no mesh yet: forget it arrived so it is
    // requested again if it comes back into the selection.
    for (const key of [...this.loaded]) if (!this.wanted.has(key)) this.loaded.delete(key);
    for (const key of [...this.jobs.keys()]) if (!this.wanted.has(key)) this.jobs.delete(key);
    // Requested tiles nobody wants any more (we moved on): tell the server not to bother.
    const cancelled: [number, number, number][] = [];
    for (const key of this.requested) {
      if (this.wanted.has(key)) continue;
      this.requested.delete(key);
      this.inFlight--;
      const [level, tx, tz] = key.split(/[:,]/).map(Number) as [number, number, number]; // see tileKey
      cancelled.push([level, tx, tz]);
    }
    for (let i = 0; i < cancelled.length; i += MAX_CANCEL) this.send({ type: 'cancel', tiles: cancelled.slice(i, i + MAX_CANCEL) });
    const d = (t: TileCoord) => {
      const s = tileSizeUnits(t.level);
      return Math.hypot((t.tx + 0.5) * s - focusX, (t.tz + 0.5) * s - focusZ);
    };
    // Ground with nothing drawn on it first (the edge we're flying into), then finer or coarser
    // tiles for ground already drawn; each nearest first.
    const order = new Map(tiles.filter((t) => !this.loaded.has(tileKey(t)) && !this.requested.has(tileKey(t))).map((t) => [t, (this.drawn(t) ? 1e12 : 0) + d(t)]));
    this.queue = [...order.keys()].sort((a, b) => order.get(a)! - order.get(b)!);
    this.pump();
  }

  onTileBytes(bytes: Uint8Array): void {
    const t = readTileHeader(bytes);
    const key = tileKey(t);
    if (this.requested.delete(key)) this.inFlight--;
    if (this.wanted.has(key) && !this.loaded.has(key)) {
      this.loaded.add(key);
      this.mesh(key, t, bytes);
    }
    this.pump();
    this.onChange();
  }

  onTileUnavailable(t: TileCoord): void {
    const key = tileKey(t);
    if (this.requested.delete(key)) this.inFlight--;
    if (this.wanted.has(key)) {
      this.loaded.add(key);
      this.setMesh(key, null);
    }
    this.pump();
    this.onChange();
  }

  resetRequests(): void {
    this.requested.clear();
    this.inFlight = 0;
  }

  /** Removes tiles that left the selection: all, or those that left more than `maxAgeMs` ago. */
  retireStale(maxAgeMs?: number, now = performance.now()): void {
    for (const [key, m] of this.stale) {
      if (maxAgeMs !== undefined && now - this.staleAt.get(key)! < maxAgeMs) break; // the rest are newer
      disposePackedMesh(m);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
  }

  /** Drops replaced tiles whose ground `covered` says is drawn again, and any older than `maxAgeMs`. */
  retireCovered(covered: (f: Footprint) => boolean, maxAgeMs: number, now = performance.now()): void {
    for (const key of staleToRetire(this.stale.keys(), (k) => this.staleAt.get(k)!, (k) => tileFootprint(parseTileKey(k)), covered, maxAgeMs, now)) {
      disposePackedMesh(this.stale.get(key)!);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
  }

  /**
   * Whether something's drawn on tile `t`'s ground already (or nothing needs to be): it, a tile
   * containing it, or one of the four it's made of (current or replaced but still showing).
   */
  private drawn(t: TileCoord): boolean {
    const has = (k: string) => this.meshes.has(k) || this.stale.has(k);
    if (has(tileKey(t))) return true;
    for (let level = t.level + 1, tx = t.tx, tz = t.tz; level <= MAX_TILE_LEVEL; level++) {
      tx = Math.floor(tx / 2);
      tz = Math.floor(tz / 2);
      if (has(tileKey({ level, tx, tz }))) return true;
    }
    if (t.level === 0) return false;
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) if (has(tileKey({ level: t.level - 1, tx: t.tx * 2 + dx, tz: t.tz * 2 + dz }))) return true;
    return false;
  }

  /** Whether every selected tile on this ground is drawn (meshed). */
  covers(f: Footprint): boolean {
    for (const [key, t] of this.wanted) if (!this.meshes.has(key) && overlaps(f, tileFootprint(t))) return false;
    return true;
  }

  dispose(): void {
    this.retireStale();
    for (const m of this.meshes.values()) if (m) disposePackedMesh(m);
    this.meshes.clear();
  }

  private retire(key: string, mesh: THREE.Object3D): void {
    const old = this.stale.get(key);
    if (old) disposePackedMesh(old);
    this.stale.delete(key);
    this.stale.set(key, mesh);
    this.staleAt.set(key, performance.now());
  }

  private pump(): void {
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const t = this.queue.shift()!;
      const key = tileKey(t);
      if (!this.wanted.has(key) || this.loaded.has(key) || this.requested.has(key)) continue;
      this.requested.add(key);
      this.inFlight++;
      this.send({ type: 'requestTile', ...t });
    }
  }

  private mesh(key: string, t: TileCoord, bytes: Uint8Array): void {
    const token = this.nextToken++;
    this.jobs.set(key, token);
    void this.pool.run({ kind: 'tile', tile: bytes }, () => this.jobs.get(key) === token).then((res) => {
      if (this.jobs.get(key) !== token) return;
      this.jobs.delete(key);
      if (res.error) {
        this.errors++;
        console.error(`[super-vox] meshing tile ${key} failed: ${res.error}`);
      } else if ((res.buffers || res.water) && res.baseY !== undefined) {
        const size = tileSizeUnits(t.level);
        const origin = { x: t.tx * size, y: res.baseY, z: t.tz * size };
        const group = new THREE.Group();
        group.name = `tile ${key}`;
        if (res.buffers) group.add(createPackedMesh(res.buffers, origin, this.material, `tile ${key}`));
        if (res.water) {
          const water = createPackedMesh(res.water, origin, this.waterMaterial, `tile water ${key}`);
          water.layers.set(WATER_LAYER);
          water.renderOrder = 4;
          group.add(water);
        }
        this.setMesh(key, group);
      } else {
        this.setMesh(key, null);
      }
      this.onChange();
    });
  }

  private setMesh(key: string, mesh: THREE.Object3D | null): void {
    const prev = this.meshes.get(key);
    if (prev) disposePackedMesh(prev);
    const stale = this.stale.get(key);
    if (stale) {
      disposePackedMesh(stale);
      this.stale.delete(key);
      this.staleAt.delete(key);
    }
    if (mesh) this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }
}

function tileFootprint(t: TileCoord): Footprint {
  const s = tileSizeUnits(t.level);
  return { x0: t.tx * s, z0: t.tz * s, x1: (t.tx + 1) * s, z1: (t.tz + 1) * s };
}

/** The tile a tileKey names. */
function parseTileKey(key: string): TileCoord {
  const [level, tx, tz] = key.split(/[:,]/).map(Number) as [number, number, number];
  return { level, tx, tz };
}

