import type * as THREE from 'three';
import {
  readTileHeader,
  tileKey,
  tileSizeUnits,
  type ClientMessage,
  type TileCoord,
} from '@super-vox/shared';
import { createPackedMesh, disposePackedMesh, meshGpuBytes, meshQuads } from './meshFactory.js';
import type { MeshWorkerPool } from './workerPool.js';

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
  private readonly meshes = new Map<string, THREE.Mesh | null>();
  private readonly jobs = new Map<string, number>();
  private readonly stale = new Map<string, THREE.Mesh>();
  private nextToken = 1;
  private errors = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly material: THREE.Material,
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
    const d = (t: TileCoord) => {
      const s = tileSizeUnits(t.level);
      return Math.hypot((t.tx + 0.5) * s - focusX, (t.tz + 0.5) * s - focusZ);
    };
    this.queue = tiles.filter((t) => !this.loaded.has(tileKey(t)) && !this.requested.has(tileKey(t))).sort((a, b) => d(a) - d(b));
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

  retireStale(): void {
    for (const m of this.stale.values()) disposePackedMesh(m);
    this.stale.clear();
  }

  dispose(): void {
    this.retireStale();
    for (const m of this.meshes.values()) if (m) disposePackedMesh(m);
    this.meshes.clear();
  }

  private retire(key: string, mesh: THREE.Mesh): void {
    const old = this.stale.get(key);
    if (old) disposePackedMesh(old);
    this.stale.set(key, mesh);
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
    void this.pool.run({ kind: 'tile', tile: bytes }).then((res) => {
      if (this.jobs.get(key) !== token) return;
      this.jobs.delete(key);
      if (res.error) {
        this.errors++;
        console.error(`[super-vox] meshing tile ${key} failed: ${res.error}`);
      } else if (res.buffers && res.baseY !== undefined) {
        const size = tileSizeUnits(t.level);
        this.setMesh(key, createPackedMesh(res.buffers, { x: t.tx * size, y: res.baseY, z: t.tz * size }, this.material, `tile ${key}`));
      } else {
        this.setMesh(key, null);
      }
      this.onChange();
    });
  }

  private setMesh(key: string, mesh: THREE.Mesh | null): void {
    const prev = this.meshes.get(key);
    if (prev) disposePackedMesh(prev);
    const stale = this.stale.get(key);
    if (stale) {
      disposePackedMesh(stale);
      this.stale.delete(key);
    }
    if (mesh) this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }
}
