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

describe('streaming', () => {
  /** A pool that records jobs and finishes them on request, honouring `current` like the real one. */
  function recordingPool() {
    const jobs: { current?: () => boolean; resolve: (r: unknown) => void }[] = [];
    let ran = 0, skipped = 0;
    const pool = {
      run: (_job: unknown, current?: () => boolean) => new Promise((resolve) => jobs.push({ ...(current ? { current } : {}), resolve })),
    } as unknown as MeshWorkerPool;
    const finishAll = async () => {
      while (jobs.length) {
        for (const j of jobs.splice(0)) {
          if (j.current && !j.current()) skipped++;
          else ran++;
          j.resolve({ id: 0, buffers: null, ms: 0 });
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    return { pool, finishAll, counts: () => ({ ran, skipped }) };
  }

  function streaming() {
    const sent: ClientMessage[] = [];
    const { pool, finishAll, counts } = recordingPool();
    const scene = { add: () => {}, remove: () => {} } as unknown as THREE.Scene;
    const cm = new ChunkManager(FLAT_WORLD_16KM, scene, {} as THREE.Material, {} as THREE.Material, (m) => sent.push(m), pool, 64, () => {});
    return { cm, sent, finishAll, counts };
  }

  it("counts a column's chunks as requested when the server says it is sending them", () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    // Ground between 0 and 1 m: layers -1..0 rendered, -2..1 sent.
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } });
    expect(sent.filter((m) => m.type === 'requestChunk')).toEqual([]);
    expect(cm.stats.inFlight).toBe(4);
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    expect(cm.stats.inFlight).toBe(0);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeDefined();
  });

  it("asks for neighbouring chunks only once their column is known, and only those it doesn't send", () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }, { cx: 1, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } }); // renders -1..0
    expect(sent.filter((m) => m.type === 'requestChunk')).toEqual([]);
    cm.onColumn({ cx: 1, cz: 5, minY: 40 * 16, maxY: 41 * 16, sent: { lo: 0, hi: 3 } }); // renders 1..2
    // Each column meshes against the other's chunks at its own layers: 1,-1 and 0,2 aren't coming.
    const asked = sent.filter((m) => m.type === 'requestChunk').map((m) => { const c = m as { cx: number; cy: number; cz: number }; return `${c.cx},${c.cy},${c.cz}`; });
    expect(asked.sort()).toEqual(['0,2,5', '1,-1,5']);
  });

  it('asks for the chunks itself when a column comes without them (e.g. after an edit)', () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16 });
    expect(sent.filter((m) => m.type === 'requestChunk')).toHaveLength(4);
  });

  it('cancels requests that left the region', () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }, { cx: 1, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } });
    // Column 1 is still being asked about; column 0's chunks are on their way.
    cm.setRegion([{ cx: 7, cz: 5 }], 7 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    const cancels = sent.filter((m) => m.type === 'cancel') as Extract<ClientMessage, { type: 'cancel' }>[];
    expect(cancels).toHaveLength(1);
    expect(new Set(cancels[0]!.chunks!.map((c) => c.join(',')))).toEqual(new Set(['0,-2,5', '0,-1,5', '0,0,5', '0,1,5']));
    expect(cancels[0]!.columns).toEqual([[1, 5]]);
    expect(cm.stats.inFlight).toBe(1); // column 7
    // Late answers to cancelled requests are dropped without upsetting the count.
    cm.onChunkBytes(chunkBytes(0, 0, 5));
    cm.onColumn({ cx: 1, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } });
    expect(cm.stats.inFlight).toBe(1);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeUndefined();
  });

  it("doesn't re-mesh for a chunk that arrives again unchanged, but does for a changed one", async () => {
    const { cm, finishAll, counts } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    await finishAll();
    const before = counts().ran;
    expect(before).toBeGreaterThan(0);
    cm.onChunkBytes(chunkBytes(0, 0, 5));
    await finishAll();
    expect(counts().ran).toBe(before);
    const edited = emptyChunk({ cx: 0, cy: 0, cz: 5 });
    edited.blocks[0] = { kind: 'uniform', size: 16, material: Material.Dirt };
    cm.onChunkBytes(encodeChunk(edited));
    await finishAll();
    expect(counts().ran).toBeGreaterThan(before);
  });

  it('skips meshing chunks that left the region before a worker was free', async () => {
    const { cm, finishAll, counts } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: { lo: -2, hi: 1 } });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    cm.setRegion([{ cx: 7, cz: 5 }], 7 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    await finishAll();
    expect(counts()).toMatchObject({ ran: 0 });
    expect(counts().skipped).toBeGreaterThan(0);
  });
});

