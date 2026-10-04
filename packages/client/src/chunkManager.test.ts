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
    // The region first (then the ring around it, see 'streaming').
    const asked = sent.filter((m) => m.type === 'requestColumn').map((m) => (m as { cx: number }).cx);
    expect(asked.slice(0, 2).sort((a, b) => a - b)).toEqual([-1, 0]);
    // The server answers for column -1 under its own name, as it does for edits it broadcasts.
    cm.onColumn({ cx: last, cz: 5, minY: 0, maxY: 10 });
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 10 });
    const chunks = sent.filter((m) => m.type === 'requestChunk') as { cx: number; cy: number; cz: number }[];
    expect(chunks.some((c) => c.cx === -1)).toBe(true);
    for (const c of chunks) cm.onChunkBytes(chunkBytes(((c.cx % (last + 1)) + last + 1) % (last + 1), c.cy, c.cz));
    // Both sides of the seam have their data, under the client's own coordinates.
    expect(cm.chunkAt({ cx: -1, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Stone });
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Stone });
    expect(cm.stats.inFlight).toBe(asked.length - 2); // only the ring's columns, unanswered here
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
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    expect(sent.filter((m) => m.type === 'requestChunk')).toEqual([]);
    // Its four chunks, and the 8 ring columns still being asked about.
    expect(cm.stats.inFlight).toBe(4 + 8);
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    expect(cm.stats.inFlight).toBe(8);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeDefined();
  });

  it("asks for neighbouring chunks only once their column is known, and only those it doesn't send", () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }, { cx: 1, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] }); // renders -1..0
    expect(sent.filter((m) => m.type === 'requestChunk')).toEqual([]);
    cm.onColumn({ cx: 1, cz: 5, minY: 40 * 16, maxY: 41 * 16, sent: [{ lo: 0, hi: 3 }] }); // renders 1..2
    // Each column meshes against the other's chunks at its own layers: 1,-1 and 0,2 aren't coming.
    const asked = sent.filter((m) => m.type === 'requestChunk').map((m) => { const c = m as { cx: number; cy: number; cz: number }; return `${c.cx},${c.cy},${c.cz}`; });
    expect(asked.sort()).toEqual(['0,2,5', '1,-1,5']);
  });

  it('draws only the surface over deep water until the viewer dives', () => {
    const { cm, sent } = streaming();
    const deep = { cx: 0, cz: 5, minY: -215 * 16, maxY: 0, solidTop: -200 * 16, water: { min: 0, max: 0 } };
    cm.setViewY(10 * 16); // above the sea
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ ...deep, sent: [{ lo: -2, hi: 1 }] });
    const rendered = () => [...(cm as unknown as { render: Set<string> }).render].map((k) => Number(k.split(',')[1])).sort((a, b) => a - b);
    expect(rendered()).toEqual([-1, 0]);
    expect(sent.filter((m) => m.type === 'requestChunk')).toEqual([]);
    // Diving to 150 m: the floor (200-215 m, within 96 m) and our own layer; asked for, not sent.
    cm.setViewY(-150 * 16);
    expect(rendered()).toEqual([-14, -13, -10, -1, 0]);
    expect(sent.filter((m) => m.type === 'requestChunk').length).toBeGreaterThan(0);
    // Back up: the surface again, and what was asked for underneath is cancelled.
    cm.setViewY(10 * 16);
    expect(rendered()).toEqual([-1, 0]);
    expect(sent.some((m) => m.type === 'cancel')).toBe(true);
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
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    // Column 1 is still being asked about; column 0's chunks are on their way.
    cm.setRegion([{ cx: 7, cz: 5 }], 7 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    const cancels = sent.filter((m) => m.type === 'cancel') as Extract<ClientMessage, { type: 'cancel' }>[];
    expect(cancels).toHaveLength(1);
    expect(new Set(cancels[0]!.chunks!.map((c) => c.join(',')))).toEqual(new Set(['0,-2,5', '0,-1,5', '0,0,5', '0,1,5']));
    // Column 1, and the old ring's columns (all within one of the old region).
    expect(cancels[0]!.columns).toContainEqual([1, 5]);
    expect(cancels[0]!.columns!.every(([cx, cz]) => cx >= -1 && cx <= 2 && cz >= 4 && cz <= 6)).toBe(true);
    expect(cm.stats.inFlight).toBe(Math.min(16, 1 + 8)); // column 7 and its ring
    // Late answers to cancelled requests are dropped without upsetting the count.
    cm.onChunkBytes(chunkBytes(0, 0, 5));
    cm.onColumn({ cx: 1, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    expect(cm.stats.inFlight).toBe(9);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeUndefined();
  });

  it("doesn't re-mesh for a chunk that arrives again unchanged, but does for a changed one", async () => {
    const { cm, finishAll, counts } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
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
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    cm.setRegion([{ cx: 7, cz: 5 }], 7 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    await finishAll();
    expect(counts()).toMatchObject({ ran: 0 });
    expect(counts().skipped).toBeGreaterThan(0);
  });

  it('loads the ring around the region without drawing it', () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    const asked = sent.filter((m) => m.type === 'requestColumn').map((m) => { const c = m as { cx: number; cz: number }; return `${c.cx},${c.cz}`; });
    expect(asked[0]).toBe('0,5'); // the region first
    expect(new Set(asked.slice(1))).toEqual(new Set(['-1,4', '0,4', '1,4', '-1,5', '1,5', '-1,6', '0,6', '1,6']));
    // A ring column's chunks are kept (the server sends them with it), not drawn.
    cm.onColumn({ cx: 1, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(1, cy, 5));
    expect(cm.chunkAt({ cx: 1, cy: 0, cz: 5 })).toBeDefined();
    expect([...(cm as unknown as { render: Set<string> }).render].some((k) => k.startsWith('1,'))).toBe(false);
    expect(sent.some((m) => m.type === 'cancel')).toBe(false); // not mistaken for unwanted
  });

  it('keeps chunks that leave, and brings them back without asking the server', () => {
    const { cm, sent } = streaming();
    const visit = (cx: number) => {
      cm.setRegion([{ cx, cz: 5 }], cx * CHUNK_SIZE, 5 * CHUNK_SIZE);
      for (const m of sent.splice(0)) {
        if (m.type === 'requestColumn') cm.onColumn({ cx: m.cx, cz: m.cz, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
      }
      // The server sends each answered column's chunks.
      for (const k of [...(cm as unknown as { requested: Set<string> }).requested]) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        cm.onChunkBytes(chunkBytes(x, y, z));
      }
    };
    visit(0);
    visit(40); // far away: column 0 and its ring are now only cached
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })).toBeUndefined();
    sent.splice(0);
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    // Back: everything from the cache, nothing asked.
    expect(sent.filter((m) => m.type === 'requestColumn' || m.type === 'requestChunk')).toEqual([]);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Stone });
  });

  it('keeps cached chunks current with edits, and forgets them after a reconnect', () => {
    const { cm, sent } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    cm.setRegion([{ cx: 40, cz: 5 }], 40 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    // Someone edits it while we're away: the server sends it to everyone.
    const edited = emptyChunk({ cx: 0, cy: 0, cz: 5 });
    edited.blocks[0] = { kind: 'uniform', size: 16, material: Material.Dirt };
    cm.onChunkBytes(encodeChunk(edited));
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    expect(cm.chunkAt({ cx: 0, cy: 0, cz: 5 })?.blocks[0]).toMatchObject({ material: Material.Dirt });
    // After a reconnect nothing cached is trusted.
    cm.setRegion([{ cx: 40, cz: 5 }], 40 * CHUNK_SIZE, 5 * CHUNK_SIZE);
    cm.resetRequests();
    sent.splice(0);
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    expect(sent.filter((m) => m.type === 'requestColumn')).toContainEqual({ type: 'requestColumn', cx: 0, cz: 5 });
  });

  it('says an area is covered only once its region columns are all meshed', async () => {
    const { cm, finishAll } = streaming();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    const column = { x0: 0, z0: 5 * CHUNK_SIZE, x1: CHUNK_SIZE, z1: 6 * CHUNK_SIZE };
    const elsewhere = { x0: 10 * CHUNK_SIZE, z0: 0, x1: 11 * CHUNK_SIZE, z1: CHUNK_SIZE };
    expect(cm.covers(column)).toBe(false); // not even its height range yet
    expect(cm.covers(elsewhere)).toBe(true); // nothing of ours there
    cm.onColumn({ cx: 0, cz: 5, minY: 0, maxY: 16, sent: [{ lo: -2, hi: 1 }] });
    for (const cy of [-2, -1, 0, 1]) cm.onChunkBytes(chunkBytes(0, cy, 5));
    expect(cm.covers(column)).toBe(false); // loaded, meshing
    await finishAll();
    expect(cm.covers(column)).toBe(true);
  });
});

describe('known', () => {
  it('knows chunks that came, and empty air above or below everything in a known column; nothing of unknown columns', () => {
    const { cm } = setup(FLAT_WORLD_16KM);
    cm.setRegion([{ cx: 0, cz: 5 }, { cx: 1, cz: 5 }], 0, 5 * CHUNK_SIZE);
    expect(cm.known({ cx: 0, cy: 3, cz: 5 })).toBe(false); // column not here yet
    cm.onColumn({ cx: 0, cz: 5, minY: -CHUNK_SIZE, maxY: 2 * CHUNK_SIZE - 1 }); // chunks -1..1
    expect(cm.known({ cx: 0, cy: 0, cz: 5 })).toBe(false); // in range: its chunk hasn't come
    cm.onChunkBytes(chunkBytes(0, 0, 5));
    expect(cm.known({ cx: 0, cy: 0, cz: 5 })).toBe(true);
    expect(cm.known({ cx: 0, cy: 2, cz: 5 })).toBe(true); // above everything: air
    expect(cm.known({ cx: 0, cy: 40, cz: 5 })).toBe(true);
    expect(cm.known({ cx: 0, cy: -2, cz: 5 })).toBe(true); // below everything
    expect(cm.known({ cx: 0, cy: 1, cz: 5 })).toBe(false);
    cm.onColumn({ cx: 1, cz: 5, minY: null, maxY: null }); // nothing in it at all
    expect(cm.known({ cx: 1, cy: 0, cz: 5 })).toBe(true);
    expect(cm.known({ cx: 2, cy: 0, cz: 5 })).toBe(false); // not in the region
  });
});

describe('sky light', () => {
  const rock = { kind: 'uniform', size: 16, material: Material.Stone } as const;
  /** Rock, but air where `air(bx, by, bz)`. */
  function rockBytes(cy: number, air: (bx: number, by: number, bz: number) => boolean = () => false) {
    const c = emptyChunk({ cx: 0, cy, cz: 5 });
    for (let by = 0; by < 16; by++) for (let bz = 0; bz < 16; bz++) for (let bx = 0; bx < 16; bx++) if (!air(bx, by, bz)) c.blocks[bx + 16 * (bz + 16 * by)] = rock;
    return encodeChunk(c);
  }
  const cave = (_bx: number, by: number) => by >= 4 && by <= 8;
  const shaft = (bx: number, _by: number, bz: number) => bx === 3 && bz === 3;

  /** Jobs by chunk; those of layer -3 (the cave) come back in shade. */
  function lit() {
    const jobs: { key: string; req: { light?: { opaque: unknown[]; above: Uint8Array } }; resolve: (r: unknown) => void }[] = [];
    const runs = new Map<string, number>();
    const pool = {
      run: (req: { center: Uint8Array; light?: { opaque: unknown[]; above: Uint8Array } }) =>
        new Promise((resolve) => {
          const v = new DataView(req.center.buffer, req.center.byteOffset);
          const key = `${v.getInt32(1, true)},${v.getInt32(5, true)},${v.getInt32(9, true)}`;
          jobs.push({ key, req, resolve });
        }),
    } as unknown as MeshWorkerPool;
    const last = new Map<string, (typeof jobs)[number]['req']>();
    const finishAll = async () => {
      while (jobs.length) {
        for (const j of jobs.splice(0)) {
          runs.set(j.key, (runs.get(j.key) ?? 0) + 1);
          last.set(j.key, j.req);
          j.resolve({ id: 0, buffers: null, ms: 0, shaded: j.key === '0,-3,5' });
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const scene = { add: () => {}, remove: () => {} } as unknown as THREE.Scene;
    const cm = new ChunkManager(FLAT_WORLD_16KM, scene, {} as THREE.Material, {} as THREE.Material, () => {}, pool, 64, () => {});
    return { cm, finishAll, runs: (k: string) => runs.get(k) ?? 0, last: (k: string) => last.get(k) };
  }

  it('sends what light is worked out from, and redoes shade below where the sky is let in', async () => {
    const { cm, finishAll, runs, last } = lit();
    cm.setRegion([{ cx: 0, cz: 5 }], 0, 5 * CHUNK_SIZE);
    // Ground at the top of layer 0, a cave in layer -3.
    cm.onColumn({ cx: 0, cz: 5, minY: -3 * CHUNK_SIZE, maxY: CHUNK_SIZE - 1, sent: [{ lo: -5, hi: 2 }] });
    for (let cy = -5; cy <= 2; cy++) cm.onChunkBytes(cy >= 1 ? encodeChunk(emptyChunk({ cx: 0, cy, cz: 5 })) : rockBytes(cy, cy === -3 ? cave : undefined));
    await finishAll();
    expect(runs('0,-3,5')).toBe(1);
    const req = last('0,-3,5')!;
    expect(req.light).toBeDefined();
    expect(req.light!.opaque[13]).toBeInstanceOf(Uint8Array);
    // Over its box (layers -4 .. -2): rock in layers -1 and 0.
    const mid = 16 + 3 + 48 * (16 + 3);
    expect(req.light!.above[mid]).toBe(1);
    // An edit that lets no light in: the cave, three layers down, isn't redone.
    const dirt = emptyChunk({ cx: 0, cy: 0, cz: 5 });
    dirt.blocks.fill(rock);
    dirt.blocks[0] = { kind: 'uniform', size: 16, material: Material.Dirt };
    cm.onChunkBytes(encodeChunk(dirt));
    await finishAll();
    expect(runs('0,-3,5')).toBe(1);
    // A shaft: first through layer -2 (next to the cave: redone, but still roofed over)...
    cm.onChunkBytes(rockBytes(-2, shaft));
    await finishAll();
    const after = runs('0,-3,5');
    expect(after).toBe(2);
    expect(last('0,-3,5')!.light!.above[mid]).toBe(1);
    // ...then through the top layer: the sky gets down to layer -1's rock, not the cave.
    cm.onChunkBytes(rockBytes(0, shaft));
    await finishAll();
    expect(runs('0,-3,5')).toBe(after);
    // Then through layer -1, two layers over the cave: the sky reaches it, and it's redone.
    cm.onChunkBytes(rockBytes(-1, shaft));
    await finishAll();
    expect(runs('0,-3,5')).toBe(after + 1);
    expect(last('0,-3,5')!.light!.above[mid]).toBe(0);
  });
});
