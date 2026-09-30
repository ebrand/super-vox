import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { encodeTile, TILE_SAMPLES, type ClientMessage, type TileCoord } from '@super-vox/shared';
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
  const tm = new TileManager(scene, {} as THREE.Material, (m) => sent.push(m), pool, 8, () => {});
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
});
