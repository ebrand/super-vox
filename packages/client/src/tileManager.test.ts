import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { decodeTile, encodeTile, TILE_SAMPLES, type ClientMessage, type TileCoord } from '@super-vox/shared';
import { packQuads } from './mesher.js';
import { meshTile } from './tileMesher.js';
import { TileManager } from './tileManager.js';
import type { MeshWorkerPool } from './workerPool.js';

const N = TILE_SAMPLES * TILE_SAMPLES;
const tileBytes = (t: TileCoord) => encodeTile({ ...t, heights: new Int16Array(N), materials: new Uint16Array(N) });

/** A pool whose jobs finish only when the test says so. */
function heldPool() {
  const pending: (() => void)[] = [];
  const pool = {
    run: () => new Promise((resolve) => pending.push(() => resolve({ id: 0, ms: 0 }))),
  } as unknown as MeshWorkerPool;
  return { pool, finishAll: () => pending.splice(0).forEach((f) => f()) };
}

function setup() {
  const sent: ClientMessage[] = [];
  const { pool, finishAll } = heldPool();
  const scene = { add: () => {} } as unknown as THREE.Scene;
  const tm = new TileManager(scene, {} as THREE.Material, {} as THREE.Material, (m) => sent.push(m), pool, 8, () => {});
  return { tm, sent, finishAll };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const A: TileCoord = { level: 1, tx: 0, tz: 0 };
const B: TileCoord = { level: 1, tx: 5, tz: 5 };

describe('TileManager', () => {
  it('re-requests a tile that left the selection while it was being meshed', async () => {
    const { tm, sent, finishAll } = setup();
    tm.setTiles([A], 0, 0);
    expect(sent).toHaveLength(1);
    tm.onTileBytes(tileBytes(A)); // now meshing
    tm.setTiles([B], 0, 0); // A leaves mid-mesh
    tm.onTileUnavailable(B);
    finishAll();
    await flush();
    sent.length = 0;
    tm.setTiles([A], 0, 0); // A comes back
    expect(sent).toEqual([{ type: 'requestTile', ...A }]);
    tm.onTileBytes(tileBytes(A));
    finishAll();
    await flush();
    expect(tm.stats.loaded).toBe(1);
    expect(tm.idle).toBe(true);
  });

  it('keeps a finished tile loaded when it stays selected', async () => {
    const { tm, sent, finishAll } = setup();
    tm.setTiles([A], 0, 0);
    tm.onTileBytes(tileBytes(A));
    finishAll();
    await flush();
    sent.length = 0;
    tm.setTiles([A, B], 0, 0);
    expect(sent).toEqual([{ type: 'requestTile', ...B }]);
  });

  it('never reports idle while a selected tile has no mesh and nothing pending', async () => {
    const { tm, finishAll } = setup();
    for (let i = 0; i < 20; i++) {
      const sel = i % 2 ? [A] : [A, B];
      tm.setTiles(sel, 0, 0);
      if (i % 3 === 0) tm.onTileBytes(tileBytes(A));
      if (i % 4 === 0) tm.onTileBytes(tileBytes(B));
      if (i % 5 === 0) {
        finishAll();
        await flush();
      }
    }
    tm.setTiles([A, B], 0, 0);
    tm.onTileBytes(tileBytes(A));
    tm.onTileBytes(tileBytes(B));
    finishAll();
    await flush();
    expect(tm.idle).toBe(true);
    expect(tm.stats.loaded).toBe(2);
  });

  it('cancels requests for tiles that left the selection, and asks again if they come back', () => {
    const { tm, sent } = setup();
    const C: TileCoord = { level: 3, tx: -2, tz: 7 };
    tm.setTiles([A, C], 0, 0);
    tm.setTiles([B], 0, 0);
    expect(sent.filter((m) => m.type === 'cancel')).toEqual([{ type: 'cancel', tiles: [[1, 0, 0], [3, -2, 7]] }]);
    expect(tm.stats.inFlight).toBe(1); // B
    tm.setTiles([A, B], 0, 0);
    expect(sent.filter((m) => m.type === 'requestTile')).toHaveLength(4); // A, C, B, A again
    tm.onTileBytes(tileBytes(C)); // a late answer to the cancelled request: ignored
    expect(tm.stats.inFlight).toBe(2);
  });

  it('drops replaced tiles that have waited too long, even while others are still loading', async () => {
    const sent: ClientMessage[] = [];
    // A pool that really meshes, so tiles get meshes to retire.
    const pool = {
      run: async (job: { tile: Uint8Array }) => {
        const m = meshTile(decodeTile(job.tile))!;
        return { id: 0, ms: 0, buffers: packQuads(m.quads), baseY: m.baseY };
      },
    } as unknown as MeshWorkerPool;
    const scene = new THREE.Scene();
    const tm = new TileManager(scene, new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), (m) => sent.push(m), pool, 8, () => {});
    tm.setTiles([A], 0, 0);
    tm.onTileBytes(tileBytes(A));
    await flush();
    tm.setTiles([B], 0, 0); // A is replaced by B, which never arrives
    expect(tm.staleCount).toBe(1);
    const t = performance.now();
    tm.retireStale(3000, t + 1000);
    expect(tm.staleCount).toBe(1); // too soon
    tm.retireStale(3000, t + 4000);
    expect(tm.staleCount).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it('keeps a replaced tile until what replaced it is drawn', async () => {
    const pool = {
      run: async (job: { tile: Uint8Array }) => {
        const m = meshTile(decodeTile(job.tile))!;
        return { id: 0, ms: 0, buffers: packQuads(m.quads), baseY: m.baseY };
      },
    } as unknown as MeshWorkerPool;
    const scene = new THREE.Scene();
    const tm = new TileManager(scene, new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), () => {}, pool, 8, () => {});
    const big: TileCoord = { level: 2, tx: 0, tz: 0 };
    const halves: TileCoord[] = [{ level: 1, tx: 0, tz: 0 }, { level: 1, tx: 1, tz: 0 }, { level: 1, tx: 0, tz: 1 }, { level: 1, tx: 1, tz: 1 }];
    tm.setTiles([big], 0, 0);
    tm.onTileBytes(tileBytes(big));
    await flush();
    tm.setTiles(halves, 0, 0); // the big tile splits; its quarters are still on their way
    const covered = (f: Parameters<TileManager['covers']>[0]) => tm.covers(f);
    tm.retireCovered(covered, 30_000);
    expect(tm.staleCount).toBe(1);
    for (const h of halves.slice(0, 3)) tm.onTileBytes(tileBytes(h));
    await flush();
    tm.retireCovered(covered, 30_000);
    expect(tm.staleCount).toBe(1); // one quarter still missing: still shown
    tm.onTileBytes(tileBytes(halves[3]!));
    await flush();
    tm.retireCovered(covered, 30_000);
    expect(tm.staleCount).toBe(0);
  });

  it('asks first for ground with nothing drawn on it, then for finer or coarser tiles of ground already drawn', async () => {
    const pool = {
      run: async (job: { tile: Uint8Array }) => {
        const m = meshTile(decodeTile(job.tile))!;
        return { id: 0, ms: 0, buffers: packQuads(m.quads), baseY: m.baseY };
      },
    } as unknown as MeshWorkerPool;
    const sent: ClientMessage[] = [];
    const tm = new TileManager(new THREE.Scene(), new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), (m) => sent.push(m), pool, 2, () => {});
    const big: TileCoord = { level: 2, tx: 0, tz: 0 };
    const quarters: TileCoord[] = [{ level: 1, tx: 0, tz: 0 }, { level: 1, tx: 1, tz: 0 }, { level: 1, tx: 0, tz: 1 }, { level: 1, tx: 1, tz: 1 }];
    const edge: TileCoord[] = [{ level: 2, tx: 20, tz: 0 }, { level: 2, tx: 21, tz: 0 }];
    tm.setTiles([big], 0, 0);
    tm.onTileBytes(tileBytes(big));
    await flush();
    sent.length = 0;
    // The big tile splits (its quarters nearest), and new ground comes into view far off: that first.
    tm.setTiles([...quarters, ...edge], 0, 0);
    expect(sent).toEqual(edge.map((t) => ({ type: 'requestTile', ...t })));
    for (const t of edge) tm.onTileBytes(tileBytes(t));
    await flush();
    expect(sent.slice(2)).toEqual(quarters.slice(0, 2).map((t) => ({ type: 'requestTile', ...t })));
    for (const t of quarters) tm.onTileBytes(tileBytes(t));
    await flush();
    sent.length = 0;
    // The quarters merge back (drawn: they're still showing) while more new ground appears: that first.
    const more: TileCoord = { level: 2, tx: 30, tz: 0 };
    tm.setTiles([big, ...edge, more], 0, 0);
    expect(sent[0]).toEqual({ type: 'requestTile', ...more });
    expect(sent[1]).toEqual({ type: 'requestTile', ...big });
  });
});
