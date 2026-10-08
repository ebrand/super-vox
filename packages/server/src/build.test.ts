import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Material, PROTOCOL_VERSION, blockIndex, blockVoxels, buildCells, decodeChunk, defaultFlatGen, extrudePieces, flatFace, type Block, type BuildOp, type ServerMessage } from '@super-vox/shared';
import { buildApp } from './app.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const flat = () => new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), {});
function block(w: World, bx: number, by: number, bz: number): Block {
  const n = 16, mod = (v: number) => ((v % n) + n) % n;
  return decodeChunk(w.getEncodedChunk({ cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) })!).blocks[blockIndex(mod(bx), mod(by), mod(bz))] ?? null;
}
const solidIn = (w: World, bx: number, by: number, bz: number) => blockVoxels(block(w, bx, by, bz)).filter((v) => v.material !== Material.Water);

describe('building with shapes', () => {
  it('fills where there is room (keeping what is there), clears, and undoes', () => {
    const w = flat();
    // Something there already: a 1/2 m plank in the corner of block (100, 1, 100).
    w.applyEdit({ op: 'place', x: 1600, y: 16, z: 1600, size: 8, material: Material.Planks });
    // A 2 x 1 x 1 m box of 1/4 m stone over it.
    const op: BuildOp = { shape: { kind: 'box', a: { x: 1600, y: 16, z: 1600 }, b: { x: 1628, y: 28, z: 1612 } }, size: 4, material: Material.Stone, clear: false };
    const cells = buildCells(op) as { x: number; y: number; z: number }[];
    expect(cells.length).toBe(8 * 4 * 4);
    const r = w.build(cells, 4, Material.Stone, false);
    // All but the 8 quarter-metre cells the plank takes.
    expect(r.count).toBe(128 - 8);
    expect(solidIn(w, 100, 1, 100).filter((v) => v.material === Material.Planks).length).toBe(1);
    expect(solidIn(w, 100, 1, 100).length).toBe(1 + 56);
    expect(solidIn(w, 101, 1, 100).length).toBe(64);
    // Undone: as it was (the plank alone).
    expect(typeof w.unbuild(r.blocks)).toBe('object');
    expect(solidIn(w, 100, 1, 100).map((v) => v.material)).toEqual([Material.Planks]);
    expect(block(w, 101, 1, 100)).toBeNull();
    // Cleared: everything touching the cells goes (the plank too).
    w.build(cells, 4, Material.Stone, false);
    const c = w.build(cells, 4, Material.Stone, true);
    expect(c.count).toBe(1 + 120);
    expect(block(w, 100, 1, 100)).toBeNull();
  });

  it("won't undo over someone else's change since, and keeps clear of placed objects", () => {
    const w = flat();
    const cells = buildCells({ shape: { kind: 'box', a: { x: 1600, y: 16, z: 1600 }, b: { x: 1616, y: 16, z: 1600 } }, size: 16, material: Material.Stone, clear: false }) as { x: number; y: number; z: number }[];
    const r = w.build(cells, 16, Material.Stone, false);
    expect(r.count).toBe(2);
    w.applyEdit({ op: 'remove', x: 1616, y: 16, z: 1600 });
    expect(w.unbuild(r.blocks)).toMatch(/changed since/);
    // A fence in the way: built round it.
    w.placeObject('fence', 110, 1, 110, 'n');
    const around = buildCells({ shape: { kind: 'box', a: { x: 109 * 16, y: 16, z: 110 * 16 }, b: { x: 111 * 16, y: 16, z: 110 * 16 } }, size: 16, material: Material.Stone, clear: false }) as { x: number; y: number; z: number }[];
    expect(w.build(around, 16, Material.Stone, false).count).toBe(2);
    expect(w.objectAt(110, 1, 110)?.kind).toBe('fence');
  });

  it('builds round shapes as the designer does, and refuses ones too big', () => {
    const sphere: BuildOp = { shape: { kind: 'round', spec: { kind: 'sphere', centre: { x: 1608, y: 200, z: 1608 }, axis: 1, sign: 1, outer: 40, thickness: 8 } }, size: 8, material: Material.Stone, clear: false };
    const cells = buildCells(sphere) as unknown[];
    expect(cells.length).toBeGreaterThan(50);
    expect(buildCells({ ...sphere, shape: { kind: 'round', spec: { ...(sphere.shape as { spec: object }).spec, outer: 33 * 16 } as never } })).toMatch(/too big/);
    expect(buildCells({ ...sphere, size: 3 })).toMatch(/1\/16 m to 1 m/);
    expect(buildCells({ shape: { kind: 'box', a: { x: 0, y: 0, z: 0 }, b: { x: 1023, y: 1023, z: 1023 } }, size: 1, material: 1, clear: false })).toMatch(/too many|off its/);
    expect(buildCells({ shape: { kind: 'box', a: { x: 0, y: 0, z: 0 }, b: { x: 1104, y: 0, z: 0 } }, size: 8, material: 1, clear: false })).toMatch(/too big/);
  });

  it('are for creative worlds; built and undone over the connection, everyone told', async () => {
    // (A survival world: no.)
    {
      const app = await buildApp({ catalog: singleWorld(flat(), undefined, 'default', 24, 'survival') });
      try {
        const base = await app.listen({ port: 0, host: '127.0.0.1' });
        const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
        const msgs: ServerMessage[] = [];
        ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
        await new Promise((r) => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
        for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 10));
        ws.send(JSON.stringify({ type: 'undo', id: 1 }));
        for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'editResult'); i++) await new Promise((r) => setTimeout(r, 10));
        expect(msgs.find((m) => m.type === 'editResult')).toMatchObject({ ok: false, error: /creative/ });
        ws.close();
      } finally {
        await app.close();
      }
    }
    const world = flat();
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'creative') });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      let id = 0;
      const ask = async (msg: object) => {
        const n = ++id;
        ws.send(JSON.stringify({ ...msg, id: n }));
        await until(() => msgs.some((m) => m.type === 'editResult' && m.id === n));
        return msgs.find((m) => m.type === 'editResult' && m.id === n) as Extract<ServerMessage, { type: 'editResult' }>;
      };
      await until(() => msgs.some((m) => m.type === 'welcome'));
      expect(await ask({ type: 'undo' })).toMatchObject({ ok: false, error: 'nothing to undo' });
      const op = { shape: { kind: 'box', a: { x: 1600, y: 16, z: 1600 }, b: { x: 1632, y: 16, z: 1600 } }, size: 16, material: Material.Stone, clear: false };
      expect(await ask({ type: 'build', op })).toMatchObject({ ok: true, note: 'built: 3 voxels' });
      expect(solidIn(world, 102, 1, 100).length).toBe(1);
      expect(await ask({ type: 'build', op: { ...op, material: Material.Water } })).toMatchObject({ ok: false });
      expect(await ask({ type: 'undo' })).toMatchObject({ ok: true });
      expect(block(world, 102, 1, 100)).toBeNull();
      ws.close();
    } finally {
      await app.close();
    }
  });
});

describe('extruding in the world', () => {
  /** A slab of stone 3 x 2 m, 1 m thick (blocks x 100..102, y 1, z 100..101), its block (102, 1, 100) broken to 1/4 m. */
  function slab() {
    const w = flat();
    for (let bx = 100; bx <= 102; bx++) for (let bz = 100; bz <= 101; bz++) w.applyEdit({ op: 'place', x: bx * 16, y: 16, z: bz * 16, size: 16, material: Material.Stone });
    w.applyEdit({ op: 'break', x: 1632, y: 16, z: 1600, pieceSize: 4 });
    return w;
  }
  const top = (w: World, at = [1600, 31, 1600]) => flatFace(w.blockReader, at, 1, 1);

  it('takes the flat open face joined edge to edge, of any sizes, and nothing past it', () => {
    const w = slab();
    const face = top(w);
    if (typeof face === 'string') throw new Error(face);
    expect(face.length).toBe(5 + 16);
    expect(face.every((v) => v.y + v.size === 32)).toBe(true);
    // From a quarter-metre voxel: the same face.
    expect((top(w, [1645, 31, 1610]) as unknown[]).length).toBe(21);
    // A side face: only that side's (x = 100's west side: 2 blocks).
    expect((flatFace(w.blockReader, [1600, 20, 1600], 0, -1) as unknown[]).length).toBe(2);
    // Something on top of one: that one isn't open, and the rest still are.
    w.applyEdit({ op: 'place', x: 1600, y: 32, z: 1600, size: 4, material: Material.Planks });
    expect(top(w)).toMatch(/isn't open/);
    expect((top(w, [1616, 31, 1600]) as unknown[]).length).toBe(20);
    // The ground of a flat world: far too big.
    expect(flatFace(w.blockReader, [1700, -1, 1700], 1, 1)).toMatch(/too big/);
    // Nothing there.
    expect(flatFace(w.blockReader, [1700, 100, 1700], 1, 1)).toMatch(/nothing/);
  });

  it('grows each voxel a column of copies of itself (whole ones), cuts back, and undoes', () => {
    const w = slab();
    const face = top(w) as Exclude<ReturnType<typeof top>, string>;
    // 1 m up: a block on each 1 m voxel, four on each 1/4 m one.
    const up = extrudePieces(face, 1, 1, 16);
    if (typeof up === 'string') throw new Error(up);
    const r = w.buildPieces(up.pieces, up.clear);
    expect(r.count).toBe(5 + 16 * 4);
    expect(block(w, 101, 2, 101)).toMatchObject({ kind: 'uniform', material: Material.Stone });
    expect(solidIn(w, 102, 2, 100).length).toBe(64);
    expect(typeof w.unbuild(r.blocks)).toBe('object');
    expect(block(w, 101, 2, 101)).toBeNull();
    // 1/2 m: the 1 m voxels don't fit a whole copy; the 1/4 m ones get two each.
    const half = extrudePieces(face, 1, 1, 8) as { pieces: unknown[] };
    expect(half.pieces.length).toBe(32);
    // Cut back 1/4 m: everything it touches goes (the 1 m blocks whole, as clearing a shape does).
    const cut = extrudePieces(face, 1, 1, -4);
    if (typeof cut === 'string') throw new Error(cut);
    expect(cut.clear).toBe(true);
    expect(w.buildPieces(cut.pieces, true).count).toBe(5 + 16);
    expect(block(w, 100, 1, 100)).toBeNull();
    expect(solidIn(w, 102, 1, 100).length).toBe(48);
    // Not at all, or too far.
    expect(extrudePieces(face, 1, 1, 0)).toMatch(/aim out/);
    expect(extrudePieces(face, 1, 1, 65 * 16)).toMatch(/too far/);
  });

  it('over the connection, in creative, and undone', async () => {
    const world = slab();
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'creative') });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error('timed out');
      };
      let id = 0;
      const ask = async (msg: object) => {
        const n = ++id;
        ws.send(JSON.stringify({ ...msg, id: n }));
        await until(() => msgs.some((m) => m.type === 'editResult' && m.id === n));
        return msgs.find((m) => m.type === 'editResult' && m.id === n) as Extract<ServerMessage, { type: 'editResult' }>;
      };
      await until(() => msgs.some((m) => m.type === 'welcome'));
      expect(await ask({ type: 'extrude', x: 1600, y: 31, z: 1600, axis: 1, sign: 1, depth: 32 })).toMatchObject({ ok: true, note: 'extruded: 138 voxels (a face of 21)' });
      expect(block(world, 100, 3, 100)).toMatchObject({ kind: 'uniform' });
      expect(await ask({ type: 'extrude', x: 1700, y: -1, z: 1700, axis: 1, sign: 1, depth: 16 })).toMatchObject({ ok: false, error: /too big/ });
      expect(await ask({ type: 'undo' })).toMatchObject({ ok: true });
      expect(block(world, 100, 3, 100)).toBeNull();
      ws.close();
    } finally {
      await app.close();
    }
  });
});
