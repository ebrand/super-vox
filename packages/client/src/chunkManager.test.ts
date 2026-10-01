import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { CHUNK_SIZE, FLAT_WORLD_16KM, Material, ROUND_WORLD_16x8KM, emptyChunk, encodeChunk, type ClientMessage, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from './chunkManager.js';
import type { MeshWorkerPool } from './workerPool.js';

/** A chunk manager whose meshing never finishes (these tests are about data). */
function setup(world: WorldConfig) {
  const sent: ClientMessage[] = [];
  const pool = { run: () => new Promise(() => {}) } as unknown as MeshWorkerPool;
  const scene = { add: () => {} } as unknown as THREE.Scene;
  const cm = new ChunkManager(world, scene, {} as THREE.Material, {} as THREE.Material, (m) => sent.push(m), pool, 64, () => {});
  return { cm, sent };
}

/** A chunk as the server sends it: named by where it is in the world. */
function chunkBytes(cx: number, cy: number, cz: number) {
  const c = emptyChunk({ cx, cy, cz });
  c.blocks[0] = { kind: 'uniform', size: 16, material: Material.Stone };
  return encodeChunk(c);
}

describe('chunks across the seam of a round world', () => {
  it('files what the server sends under the copies the client asked for', () => {
    const { cm, sent } = setup(ROUND_WORLD_16x8KM);
    const last = ROUND_WORLD_16x8KM.widthUnits / CHUNK_SIZE - 1; // 999: chunk column -1 is this one
    // Standing at the seam: columns -1 (the world's last) and 0.
    cm.setRegion([{ cx: -1, cz: 5 }, { cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    const asked = sent.filter((m) => m.type === 'requestColumn').map((m) => (m as { cx: number }).cx).sort((a, b) => a - b);
    expect(asked).toEqual([-1, 0]);
    // The server answers for column -1 under its own name, as it does for edits it broadcasts.
    cm.onColumn({ cx: last, cz: 5, minY: 0, maxY: 10 });
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 10 });
    const chunks = sent.filter((m) => m.type === 'requestChunk') as { cx: number; cy: number; cz: number }[];
    expect(chunks.some((c) => c.cx === -1)).toBe(true);
    for (const c of chunks) cm.onChunkBytes(chunkBytes(((c.cx % (last + 1)) + last + 1) % (last + 1), c.cy, c.cz));
    // Both sides of the seam have their data, under the client's own coordinates.
    expect(cm.chunkAt({ cx: -1, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Stone });
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Stone });
    expect(cm.stats.inFlight).toBe(0);
    // An edit's chunk, broadcast under the world's name, replaces the copy here.
    const edited = emptyChunk({ cx: last, cy: 0, cz: 5 });
    edited.blocks[0] = { kind: 'uniform', size: 16, material: Material.Dirt };
    cm.onChunkBytes(encodeChunk(edited));
    expect(cm.chunkAt({ cx: -1, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Dirt });
  });

  it("doesn't wrap flat worlds", () => {
    const { cm, sent } = setup(FLAT_WORLD_16KM);
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 10 });
    for (const c of sent.filter((m) => m.type === 'requestChunk') as { cx: number; cy: number; cz: number }[]) cm.onChunkBytes(chunkBytes(c.cx, c.cy, c.cz));
    const far = emptyChunk({ cx: 999, cy: 0, cz: 5 });
    cm.onChunkBytes(encodeChunk(far)); // nobody asked: ignored
    expect(cm.chunkAt({ cx: 999 - 1000, cy: 0, cz: 5 })).toBeUndefined();
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeDefined();
  });
});
