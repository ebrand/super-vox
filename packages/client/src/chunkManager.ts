import * as THREE from 'three';
import {
  CHUNK_SIZE,
  UNITS_PER_METER,
  chunkKey,
  readChunkHeader,
  resolveChunk,
  summarizeChunk,
  type ChunkCoord,
  type ClientMessage,
  type WorldConfig,
} from '@super-vox/shared';
import { DIRS } from './mesher.js';
import type { MeshRequest, MeshResponse } from './mesher.worker.js';

export interface StreamOptions {
  /** Horizontal radius, in chunks, that is rendered around the focus. */
  radius: number;
  /** Vertical radius, in chunks, that is rendered around the focus. */
  verticalRadius: number;
  /** Maximum outstanding chunk requests. */
  maxInFlight: number;
}

export interface StreamStats {
  loaded: number;
  inFlight: number;
  queued: number;
  meshed: number;
  meshing: number;
  triangles: number;
  errors: number;
  /** Average worker time per meshed chunk. */
  meshMsAvg: number;
  /** Milliseconds from the last focus change until everything in range was loaded and meshed; null while busy. */
  settledMs: number | null;
}

const CHUNK_METERS = CHUNK_SIZE / UNITS_PER_METER;

/**
 * Streams chunks around a focus point and keeps one mesh per chunk. Chunks
 * are loaded one ring beyond the render radius so every rendered chunk has
 * all six neighbors available for face culling.
 */
export class ChunkManager {
  /** Encoded chunk bytes; null means known empty (outside the world). */
  private readonly data = new Map<string, Uint8Array | null>();
  /** Summary per loaded chunk; outside-the-world chunks count as air. */
  private readonly kinds = new Map<string, 'air' | 'solid' | 'mixed'>();
  private readonly coords = new Map<string, ChunkCoord>();
  private readonly requested = new Set<string>();
  private queue: ChunkCoord[] = [];
  private inFlight = 0;

  private readonly meshes = new Map<string, THREE.Mesh>();
  /** key -> id of the outstanding mesh job; results for other ids are stale. */
  private readonly meshJobs = new Map<string, number>();
  /** Chunks meshed with no visible faces. */
  private readonly emptyMeshes = new Set<string>();
  private readonly jobKeys = new Map<number, string>();
  private nextJobId = 1;
  private nextWorker = 0;
  private readonly workers: Worker[];

  private focusKey = '';
  private wanted = new Set<string>();
  private renderSet = new Set<string>();
  private triangles = 0;
  private errors = 0;
  private retargetAt = 0;
  private meshMsTotal = 0;
  private meshCount = 0;
  private settledMs: number | null = null;

  constructor(
    private readonly world: WorldConfig,
    private readonly scene: THREE.Scene,
    private readonly material: THREE.Material,
    private readonly send: (msg: ClientMessage) => void,
    private readonly opts: StreamOptions,
  ) {
    const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    this.workers = Array.from({ length: count }, () => {
      const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<MeshResponse>) => this.onMeshed(ev.data);
      return w;
    });
  }

  get stats(): StreamStats {
    return {
      loaded: this.data.size,
      inFlight: this.inFlight,
      queued: this.queue.length,
      meshed: this.meshes.size + this.emptyMeshes.size,
      meshing: this.meshJobs.size,
      triangles: this.triangles,
      errors: this.errors,
      settledMs: this.settledMs,
      meshMsAvg: this.meshCount ? this.meshMsTotal / this.meshCount : 0,
    };
  }

  /** Call every frame with the point to stream around (world meters). */
  update(focus: THREE.Vector3): void {
    const fc = {
      cx: Math.floor(focus.x / CHUNK_METERS),
      cy: Math.floor(focus.y / CHUNK_METERS),
      cz: Math.floor(focus.z / CHUNK_METERS),
    };
    const key = chunkKey(fc);
    if (key !== this.focusKey) {
      this.focusKey = key;
      this.retarget(fc);
    }
    this.pump();
  }

  onChunkBytes(bytes: Uint8Array): void {
    const coord = readChunkHeader(bytes);
    const key = chunkKey(coord);
    this.settleRequest(key);
    if (this.wanted.has(key)) this.store(key, coord, bytes);
    this.checkSettled();
  }

  onChunkUnavailable(coord: ChunkCoord): void {
    const key = chunkKey(coord);
    this.settleRequest(key);
    if (this.wanted.has(key)) this.store(key, coord, null);
    this.checkSettled();
  }

  /** Forget everything in flight, e.g. after a reconnect. */
  resetRequests(): void {
    this.requested.clear();
    this.inFlight = 0;
    this.focusKey = '';
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const key of [...this.meshes.keys()]) this.dropMesh(key);
  }

  /** Marks a request answered and immediately sends more, so loading does not wait for the next frame. */
  private settleRequest(key: string): void {
    if (this.requested.delete(key)) this.inFlight--;
    this.pump();
  }

  private retarget(fc: ChunkCoord): void {
    this.retargetAt = performance.now();
    this.settledMs = null;
    const { radius: r, verticalRadius: vr } = this.opts;
    const wanted = new Set<string>();
    const render = new Set<string>();
    const toLoad: { c: ChunkCoord; d: number }[] = [];
    for (let dy = -(vr + 1); dy <= vr + 1; dy++) {
      for (let dz = -(r + 1); dz <= r + 1; dz++) {
        for (let dx = -(r + 1); dx <= r + 1; dx++) {
          const c = { cx: fc.cx + dx, cy: fc.cy + dy, cz: fc.cz + dz };
          const key = chunkKey(c);
          wanted.add(key);
          if (Math.abs(dx) <= r && Math.abs(dz) <= r && Math.abs(dy) <= vr) render.add(key);
          if (this.data.has(key) || this.requested.has(key)) continue;
          if (!resolveChunk(this.world, c)) {
            this.store(key, c, null, false);
            continue;
          }
          toLoad.push({ c, d: dx * dx + dz * dz + 4 * dy * dy });
        }
      }
    }
    this.wanted = wanted;
    this.renderSet = render;

    for (const key of [...this.data.keys()]) {
      if (!wanted.has(key)) {
        this.data.delete(key);
        this.kinds.delete(key);
        this.coords.delete(key);
      }
    }
    for (const key of [...this.meshes.keys(), ...this.emptyMeshes]) {
      if (!render.has(key)) this.dropMesh(key);
    }
    for (const key of [...this.meshJobs.keys()]) {
      if (!render.has(key)) this.meshJobs.delete(key);
    }

    toLoad.sort((a, b) => a.d - b.d);
    this.queue = toLoad.map((t) => t.c);
    // Chunks that were already loaded may now be renderable.
    for (const key of render) this.tryMesh(key);
    this.checkSettled();
  }

  private checkSettled(): void {
    if (this.settledMs !== null || this.queue.length > 0 || this.inFlight > 0 || this.meshJobs.size > 0) return;
    this.settledMs = performance.now() - this.retargetAt;
  }

  private pump(): void {
    while (this.inFlight < this.opts.maxInFlight && this.queue.length > 0) {
      const c = this.queue.shift()!;
      const key = chunkKey(c);
      if (this.data.has(key) || this.requested.has(key) || !this.wanted.has(key)) continue;
      this.requested.add(key);
      this.inFlight++;
      this.send({ type: 'requestChunk', ...c });
    }
  }

  private store(key: string, coord: ChunkCoord, bytes: Uint8Array | null, meshNeighbors = true): void {
    this.data.set(key, bytes);
    this.kinds.set(key, bytes ? summarizeChunk(bytes) : 'air');
    this.coords.set(key, coord);
    if (!meshNeighbors) return;
    this.tryMesh(key);
    for (const { axis, sign } of DIRS) {
      const n = { ...coord };
      if (axis === 0) n.cx += sign;
      else if (axis === 1) n.cy += sign;
      else n.cz += sign;
      this.tryMesh(chunkKey(n));
    }
  }

  private neighborCoords(c: ChunkCoord): ChunkCoord[] {
    return DIRS.map(({ axis, sign }) => ({
      cx: c.cx + (axis === 0 ? sign : 0),
      cy: c.cy + (axis === 1 ? sign : 0),
      cz: c.cz + (axis === 2 ? sign : 0),
    }));
  }

  private tryMesh(key: string): void {
    if (!this.renderSet.has(key) || this.meshes.has(key) || this.emptyMeshes.has(key) || this.meshJobs.has(key)) return;
    const center = this.data.get(key);
    const coord = this.coords.get(key);
    if (center === undefined || !coord) return;
    if (center === null || this.kinds.get(key) === 'air') {
      this.emptyMeshes.add(key);
      return;
    }
    const neighbors: (Uint8Array | null)[] = [];
    let buried = this.kinds.get(key) === 'solid';
    for (const n of this.neighborCoords(coord)) {
      const nk = chunkKey(n);
      const bytes = this.data.get(nk);
      if (bytes === undefined) return; // not loaded yet
      neighbors.push(bytes);
      if (this.kinds.get(nk) !== 'solid') buried = false;
    }
    if (buried) {
      // Solid and enclosed by solid chunks: no face can be visible.
      this.emptyMeshes.add(key);
      return;
    }
    const id = this.nextJobId++;
    this.meshJobs.set(key, id);
    this.jobKeys.set(id, key);
    const req: MeshRequest = { id, center, neighbors };
    this.workers[this.nextWorker++ % this.workers.length]!.postMessage(req);
  }

  private onMeshed(res: MeshResponse): void {
    this.meshMsTotal += res.ms;
    this.meshCount++;
    this.handleMeshed(res);
    this.checkSettled();
  }

  private handleMeshed(res: MeshResponse): void {
    const key = this.jobKeys.get(res.id);
    this.jobKeys.delete(res.id);
    if (key === undefined || this.meshJobs.get(key) !== res.id) return; // stale
    this.meshJobs.delete(key);
    if (res.error) {
      this.errors++;
      console.error(`[super-vox] meshing ${key} failed: ${res.error}`);
      return;
    }
    const coord = this.coords.get(key);
    if (!coord || !res.buffers) {
      this.emptyMeshes.add(key);
      return;
    }
    const b = res.buffers;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
    geom.setAttribute('voxelSize', new THREE.BufferAttribute(b.voxelSizes, 1));
    geom.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geom.computeBoundingSphere();
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.position.set(coord.cx * CHUNK_METERS, coord.cy * CHUNK_METERS, coord.cz * CHUNK_METERS);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `chunk ${key}`;
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
    this.triangles += b.indices.length / 3;
  }

  private dropMesh(key: string): void {
    this.emptyMeshes.delete(key);
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    this.triangles -= (mesh.geometry.index?.count ?? 0) / 3;
    mesh.geometry.dispose();
    this.meshes.delete(key);
  }
}
