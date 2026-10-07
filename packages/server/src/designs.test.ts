import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  EditError,
  FIRST_DESIGN_ITEM,
  FLAT_WORLD_16KM,
  FlatGenerator,
  HOTBAR_SLOTS,
  Item,
  Material,
  PROTOCOL_VERSION,
  blockIndex,
  blockVoxels,
  decodeChunk,
  defaultFlatGen,
  designOfItem,
  itemName,
  recipeById,
  setDesigns,
  type Block,
  type ObjectDesign,
  type ServerMessage,
} from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { FileChunkStore } from './chunkStore.js';
import { DesignLibrary } from './designs.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const P = Material.Planks, S = Material.Stone;

/** A 2 x 1 x 1 m bench (as drawn: facing north): a 1/2 m seat across the top, and legs; and a "folded" state (a slab on the ground). */
function bench(): Omit<ObjectDesign, 'item'> {
  return {
    id: 'bench',
    name: 'Bench',
    size: [2, 1, 1],
    recipe: { inputs: [[P, 3]], count: 2, table: false },
    states: [
      {
        name: 'up',
        voxels: [
          ...[0, 8, 16, 24].flatMap((x) => [0, 8].map((z) => ({ x, y: 8, z, size: 8, material: P }))),
          { x: 0, y: 0, z: 0, size: 8, material: S },
          { x: 24, y: 0, z: 8, size: 8, material: S },
        ],
      },
      { name: 'folded', voxels: [0, 8, 16, 24].map((x) => ({ x, y: 0, z: 0, size: 8, material: P })) },
    ],
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  setDesigns([]);
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'designs-'));
  dirs.push(d);
  return d;
};

describe('DesignLibrary', () => {
  it('keeps designs (each its own item, never reused), on disk, and puts them in play', () => {
    const file = join(tempDir(), 'designs.json');
    const lib = new DesignLibrary(file);
    const a = lib.put(bench()) as ObjectDesign;
    expect(a.item).toBe(FIRST_DESIGN_ITEM);
    expect(designOfItem(a.item)?.id).toBe('bench');
    expect(itemName(a.item)).toBe('Bench');
    expect(recipeById('design:bench')?.output).toEqual([a.item, 2]);
    // Replaced: the same item. Another: the next.
    expect((lib.put({ ...bench(), name: 'Park bench' }) as ObjectDesign).item).toBe(FIRST_DESIGN_ITEM);
    const b = lib.put({ ...bench(), id: 'stool', size: [1, 1, 1], states: [{ name: 's', voxels: [{ x: 0, y: 0, z: 0, size: 16, material: P }] }] }) as ObjectDesign;
    expect(b.item).toBe(FIRST_DESIGN_ITEM + 1);
    // Bad ones: why (and nothing changes).
    expect(lib.put({ ...bench(), size: [17, 1, 1] })).toMatch(/size/);
    expect(lib.list().map((d) => d.id)).toEqual(['bench', 'stool']);
    // Deleted: gone; its number isn't given again.
    expect(lib.delete('stool')).toBe(true);
    expect(lib.delete('stool')).toBe(false);
    expect(designOfItem(b.item)).toBeUndefined();
    const c = lib.put({ ...bench(), id: 'chair' }) as ObjectDesign;
    expect(c.item).toBe(FIRST_DESIGN_ITEM + 2);
    // Opened again: the same.
    setDesigns([]);
    const again = new DesignLibrary(file);
    expect(again.list()).toEqual(lib.list());
    expect(designOfItem(c.item)?.id).toBe('chair');
    expect((again.put({ ...bench(), id: 'table-2' }) as ObjectDesign).item).toBe(FIRST_DESIGN_ITEM + 3);
  });
});

/** Flat ground at y = 0 (block y 0 is the first air). */
function flat(store?: FileChunkStore) {
  return new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), store ? { store } : {});
}
function block(w: World, bx: number, by: number, bz: number): Block {
  const n = 16, mod = (v: number) => ((v % n) + n) % n;
  return decodeChunk(w.getEncodedChunk({ cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) })!).blocks[blockIndex(mod(bx), mod(by), mod(bz))] ?? null;
}

describe('placed designs', () => {
  it('stand in their box, turned to face the way the placer looked; any block of it is the object', () => {
    const lib = new DesignLibrary(null);
    const d = lib.put(bench()) as ObjectDesign;
    const w = flat();
    // Facing north at (100, 0, 100): the front row (its only row) there, x 100 (the left of two) and 101.
    w.placeDesign(d, 100, 0, 100, 'n');
    expect(w.objectAt(100, 0, 100)).toBe(w.objectAt(101, 0, 100));
    expect(w.objectAt(100, 0, 100)).toMatchObject({ kind: 'design', design: 'bench', x: 100, z: 100, span: [2, 1, 1], state: 0 });
    expect(w.objectAt(99, 0, 100)).toBeUndefined();
    expect(blockVoxels(block(w, 100, 0, 100)).length).toBe(5); // 4 of the seat, a leg
    expect(blockVoxels(block(w, 101, 0, 100)).length).toBe(5);
    // Facing east: along z instead.
    w.placeDesign(d, 200, 0, 200, 'e');
    expect(w.objectAt(200, 0, 200)).toBe(w.objectAt(200, 0, 201)); // (the left of two in front, as the placer sees it: to its right, +z)
    expect(w.objectAt(200, 0, 200)!.span).toEqual([1, 1, 2]);
    expect(blockVoxels(block(w, 200, 0, 200)).length + blockVoxels(block(w, 200, 0, 201)).length).toBe(10);
    // Ordinary edits can't touch it; nothing else can go in its box.
    expect(() => w.applyEdit({ op: 'remove', x: 101 * 16, y: 8, z: 100 * 16 })).toThrow(/Bench/i);
    expect(() => w.placeDesign(d, 101, 0, 100, 'e')).toThrow(EditError);
    expect(() => w.placeObject('fence', 101, 0, 100, 'n')).toThrow(/already/);
    // Not into the ground.
    expect(() => w.placeDesign(d, 300, -1, 300, 'n')).toThrow(/2 x 1 x 1 m of empty space/);
  });

  it('step through their states, come down whole, and are kept', () => {
    const dir = tempDir();
    new DesignLibrary(null).put(bench());
    const d = designOfItem(FIRST_DESIGN_ITEM)!;
    const w = flat(new FileChunkStore(dir));
    w.placeDesign(d, 100, 0, 100, 'n');
    w.toggleObject(w.objectAt(101, 0, 100)!);
    expect(w.objectAt(100, 0, 100)!.state).toBe(1);
    expect(blockVoxels(block(w, 100, 0, 100)).map((v) => v.y)).toEqual([0, 0]); // folded flat
    w.toggleObject(w.objectAt(101, 0, 100)!);
    expect(w.objectAt(100, 0, 100)!.state).toBe(0);
    w.toggleObject(w.objectAt(101, 0, 100)!);
    // Opened again: there, folded, both blocks of it.
    const again = flat(new FileChunkStore(dir));
    expect(again.objectAt(101, 0, 100)).toMatchObject({ design: 'bench', state: 1 });
    expect(again.designObjects().length).toBe(1);
    // Taken down: every block of it empty.
    again.removeObject(again.objectAt(101, 0, 100)!);
    expect(block(again, 100, 0, 100)).toBeNull();
    expect(block(again, 101, 0, 100)).toBeNull();
    expect(again.objectAt(100, 0, 100)).toBeUndefined();
    expect(again.designObjects()).toEqual([]);
  });

  it("won't change once its design has (but still comes down), and a blast takes it", () => {
    const lib = new DesignLibrary(null);
    const d = lib.put(bench()) as ObjectDesign;
    const w = flat();
    let told = 0;
    w.onObjectsChanged = () => told++;
    w.placeDesign(d, 100, 0, 100, 'n');
    expect(told).toBe(1);
    lib.put({ ...bench(), size: [3, 1, 1] });
    expect(() => w.toggleObject(w.objectAt(100, 0, 100)!)).toThrow(/changed since/);
    w.removeObject(w.objectAt(101, 0, 100)!);
    expect(block(w, 101, 0, 100)).toBeNull();
    // A blast 3 m off its far end (radius 4 m) reaches its box.
    lib.put(bench());
    w.placeDesign(lib.get('bench')!, 100, 0, 100, 'n');
    w.explode(102 * 16 + 48, 8, 100 * 16 + 8, 64);
    expect(w.objectAt(100, 0, 100)).toBeUndefined();
    expect(block(w, 100, 0, 100)).toBeNull();
  });
});

/** A 1 x 2 x 1 m door (as drawn: facing north): a 1/8 m panel across the middle; open, against the west side. */
function door(): Omit<ObjectDesign, 'item'> {
  const panel = (x0: number, x1: number, z0: number, z1: number) => {
    const out: { x: number; y: number; z: number; size: number; material: number }[] = [];
    for (let y = 0; y < 32; y += 2) for (let z = z0; z < z1; z += 2) for (let x = x0; x < x1; x += 2) out.push({ x, y, z, size: 2, material: P });
    return out;
  };
  return { id: 'door', name: 'Door', size: [1, 2, 1], recipe: { inputs: [[P, 1]], count: 1, table: false }, states: [{ name: 'closed', voxels: panel(0, 16, 6, 8) }, { name: 'open', voxels: panel(0, 2, 0, 16) }] };
}

describe('designs off the grid', () => {
  // A wall with a 1 m gap straddling blocks 100 and 101 (x): their outer halves are wall, 2 m high.
  const wall = (w: World) => {
    for (const [x0, by] of [[100 * 16, 0], [101 * 16 + 8, 0], [100 * 16, 1], [101 * 16 + 8, 1]] as const)
      for (const y of [0, 8]) for (const z of [0, 8]) w.applyEdit({ op: 'place', x: x0, y: by * 16 + y, z: 100 * 16 + z, size: 8, material: S });
  };
  const wallIn = (b: Block) => blockVoxels(b).filter((v) => v.material === S).length;

  it('go in at 1/4 m steps, sharing the blocks at their edges with what is beside them', () => {
    const dir = tempDir();
    const d = new DesignLibrary(null).put(door()) as ObjectDesign;
    const w = flat(new FileChunkStore(dir));
    wall(w);
    // On the 1 m grid, or 1/4 m off it: into the wall.
    expect(() => w.placeDesign(d, 100, 0, 100, 'n')).toThrow(/1 x 2 x 1 m of empty space/);
    expect(() => w.placeDesign(d, 100, 0, 100, 'n', [4, 0, 0])).toThrow(/empty space/);
    expect(() => w.placeDesign(d, 100, 0, 100, 'n', [6, 0, 0])).toThrow(/1\/4 m/);
    // 1/2 m off: in the gap. It takes the four blocks it's in; the wall in them stays.
    w.placeDesign(d, 100, 0, 100, 'n', [8, 0, 0]);
    const o = w.objectAt(100, 0, 100)!;
    expect(o).toMatchObject({ x: 100, y: 0, z: 100, span: [1, 2, 1], offset: [8, 0, 0] });
    for (const [bx, by] of [[101, 0], [100, 1], [101, 1]]) expect(w.objectAt(bx!, by!, 100)).toBe(o);
    for (const [bx, by] of [[100, 0], [101, 0], [100, 1], [101, 1]]) {
      expect(wallIn(block(w, bx!, by!, 100))).toBe(4);
      expect(blockVoxels(block(w, bx!, by!, 100)).filter((v) => v.material === P).length).toBe(4 * 8);
    }
    // Clicks: on its panel, the door; on the wall beside it (in the same block), not.
    expect(w.objectAtPoint(100 * 16 + 12, 4, 100 * 16 + 6)).toBe(o);
    expect(w.objectAtPoint(100 * 16 + 2, 4, 100 * 16 + 6)).toBeUndefined();
    // The wall there can be dug and built again; nothing goes into the door's box.
    w.applyEdit({ op: 'remove', x: 100 * 16 + 2, y: 4, z: 100 * 16 + 2 });
    expect(wallIn(block(w, 100, 0, 100))).toBe(3);
    w.applyEdit({ op: 'place', x: 100 * 16, y: 0, z: 100 * 16, size: 8, material: S });
    expect(() => w.applyEdit({ op: 'place', x: 100 * 16 + 8, y: 0, z: 100 * 16, size: 8, material: S })).toThrow(/Door/);
    expect(() => w.applyEdit({ op: 'remove', x: 100 * 16 + 12, y: 4, z: 100 * 16 + 6 })).toThrow(/Door/);
    // Nothing else in its blocks.
    expect(() => w.placeObject('torch', 100, 0, 100, 'n')).toThrow();
    // Opened: the panel swings, the wall stays.
    w.toggleObject(o);
    const swung = blockVoxels(block(w, 100, 0, 100)).filter((v) => v.material === P);
    expect(swung.length).toBe(8 * 8);
    expect(swung.every((v) => v.x >= 8 && v.x < 10)).toBe(true);
    expect(wallIn(block(w, 100, 0, 100))).toBe(4);
    // Kept as it is.
    const again = flat(new FileChunkStore(dir));
    expect(again.objectAt(101, 1, 100)).toMatchObject({ offset: [8, 0, 0], state: 1 });
    // Taken down: the wall stays, nothing of the door.
    again.removeObject(again.objectAt(101, 1, 100)!);
    for (const [bx, by] of [[100, 0], [101, 0], [100, 1], [101, 1]]) {
      expect(blockVoxels(block(again, bx!, by!, 100)).map((v) => v.material)).toEqual([S, S, S, S]);
      expect(again.objectAt(bx!, by!, 100)).toBeUndefined();
    }
  });

  it('share a block with each other, each in its own part of it', () => {
    const dir = tempDir();
    const d = new DesignLibrary(null).put(door()) as ObjectDesign;
    const w = flat(new FileChunkStore(dir));
    // Two doors side by side, 1/2 m off the grid: x 100.5..101.5 m and 101.5..102.5 m; both take block 101.
    w.placeDesign(d, 100, 0, 100, 'n', [8, 0, 0]);
    w.placeDesign(d, 101, 0, 100, 'n', [8, 0, 0]);
    const a = w.objectAtPoint(100 * 16 + 12, 4, 100 * 16 + 6)!, b = w.objectAtPoint(102 * 16 + 4, 4, 100 * 16 + 6)!;
    expect([a.x, b.x]).toEqual([100, 101]);
    expect(w.objectsAt(101, 0, 100)).toEqual([a, b]);
    // In the block they share: each its own half.
    expect(w.objectAtPoint(101 * 16 + 4, 4, 100 * 16 + 6)).toBe(a);
    expect(w.objectAtPoint(101 * 16 + 12, 4, 100 * 16 + 6)).toBe(b);
    const panel = (bx: number) => blockVoxels(block(w, bx, 0, 100)).filter((v) => v.material === P).map((v) => v.x);
    expect(panel(101).length).toBe(2 * 32); // (each door's half: 4 x 8 voxels of 1/8 m)
    // Nothing a third can share: either door's box.
    expect(() => w.placeDesign(d, 100, 0, 100, 'n', [12, 0, 0])).toThrow(/already something there/);
    expect(() => w.placeDesign(d, 101, 0, 100, 'n')).toThrow(/already something there/);
    expect(() => w.placeObject('fence', 101, 0, 100, 'n')).toThrow(/already something there/);
    // One opens (swinging back into its own block, 100): the other's half of the block stays as it was.
    w.toggleObject(a);
    expect(panel(101).filter((x) => x >= 8).length).toBe(32);
    expect(panel(101).filter((x) => x < 8)).toEqual([]);
    expect(w.objectsAt(101, 0, 100).map((o) => [o.x, o.state]).sort()).toEqual([[100, 1], [101, 0]]);
    // Kept, both.
    const again = flat(new FileChunkStore(dir));
    expect(again.designObjects().length).toBe(2);
    expect(again.objectsAt(101, 1, 100).length).toBe(2);
    // One taken down: the other whole.
    again.removeObject(again.objectAtPoint(100 * 16 + 12, 4, 100 * 16 + 6)!);
    expect(again.objectsAt(101, 0, 100).map((o) => o.x)).toEqual([101]);
    expect(blockVoxels(block(again, 101, 0, 100)).filter((v) => v.material === P).every((v) => v.x >= 8)).toBe(true);
    expect(blockVoxels(block(again, 101, 0, 100)).length).toBe(32);
    expect(block(again, 100, 0, 100)).toBeNull();
  });

  it('split voxels that would cross a 1 m gridline, and stand on a floor off the grid', () => {
    const d = new DesignLibrary(null).put({ ...door(), id: 'cube', name: 'Cube', size: [1, 1, 1], states: [{ name: 'c', voxels: [{ x: 0, y: 0, z: 0, size: 16, material: P }] }] }) as ObjectDesign;
    const w = flat();
    // A 1/4 m step up on the ground: the cube, 1/4 m off in each axis.
    w.placeDesign(d, 100, 0, 100, 'n', [4, 4, 12]);
    let volume = 0;
    for (let by = 0; by <= 1; by++)
      for (let bz = 100; bz <= 101; bz++)
        for (let bx = 100; bx <= 101; bx++) for (const v of blockVoxels(block(w, bx, by, bz))) volume += v.size ** 3;
    expect(volume).toBe(16 ** 3);
    expect(blockVoxels(block(w, 100, 0, 100)).every((v) => v.size === 4)).toBe(true);
    // A blast reaches it where its box is (its far side at x = 101 m + 4 units), not where its blocks' grid would put it.
    w.explode(101 * 16 + 4 + 62, 12, 101 * 16, 64);
    expect(w.objectAt(100, 0, 100)).toBeUndefined();
  });
});

describe('designs off the grid, in play', () => {
  it('are placed 1/4 m off the grid; a click on the wall beside one is the wall, on it the design', async () => {
    const lib = new DesignLibrary(null);
    const d = lib.put(door()) as ObjectDesign;
    const world = flat();
    for (const x0 of [100 * 16, 101 * 16 + 8]) for (const y of [0, 8]) for (const z of [0, 8]) world.applyEdit({ op: 'place', x: x0, y, z: 100 * 16 + z, size: 8, material: S });
    const app = await buildApp({ catalog: singleWorld(world), designs: lib });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
      const msgs: ServerMessage[] = [];
      ws.on('message', (m, bin) => !bin && msgs.push(JSON.parse(String(m)) as ServerMessage));
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
      await until(() => msgs.some((m) => m.type === 'designs'));
      expect(await ask({ type: 'placeObject', item: d.item, x: 100, y: 0, z: 100, facing: 'n', offset: [8, 0, 0] })).toMatchObject({ ok: true });
      expect(world.objectAt(101, 0, 100)).toMatchObject({ design: 'door', offset: [8, 0, 0] });
      // Right-click: on the wall, nothing; on the door, it opens.
      expect(await ask({ type: 'use', x: 100 * 16 + 2, y: 4, z: 100 * 16 + 2 })).toMatchObject({ ok: false });
      expect(await ask({ type: 'use', x: 100 * 16 + 12, y: 4, z: 100 * 16 + 6 })).toMatchObject({ ok: true });
      expect(world.objectAt(100, 0, 100)!.state).toBe(1);
      // Left-click on the wall beside it: that bit of wall goes; the door stays.
      expect(await ask({ type: 'edit', edit: { op: 'remove', x: 100 * 16 + 2, y: 4, z: 100 * 16 + 2 } })).toMatchObject({ ok: true });
      expect(world.objectAt(100, 0, 100)).toBeDefined();
      expect(blockVoxels(block(world, 100, 0, 100)).filter((v) => v.material === S).length).toBe(3);
      // On the door (open: against its west side, x 8..10): it comes down, the wall left as it is.
      expect(await ask({ type: 'edit', edit: { op: 'remove', x: 100 * 16 + 9, y: 4, z: 100 * 16 + 4 } })).toMatchObject({ ok: true });
      expect(world.objectAt(100, 0, 100)).toBeUndefined();
      expect(blockVoxels(block(world, 100, 0, 100)).map((v) => v.material)).toEqual([S, S, S]);
      ws.close();
    } finally {
      await app.close();
    }
  });
});

describe('the crafting table design', () => {
  it('is one design at most (the newest), placed by the crafting table item, and recipes needing a table work beside it', async () => {
    const lib = new DesignLibrary(null);
    lib.put({ ...bench(), id: 'old-table', role: 'crafting-table' });
    lib.put({ ...bench(), id: 'new-table', role: 'crafting-table' });
    expect(lib.list().map((d) => [d.id, d.role ?? null])).toEqual([['old-table', null], ['new-table', 'crafting-table']]);
    expect(designOfItem(Item.CraftingTable)?.id).toBe('new-table');

    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const inventories = new MemoryInventoryStore();
    const world = flat();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, miningTimeScale: 0.01, designs: lib });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const bob = await accounts.signIn({ sub: 'g-bob', email: 'bob@x.com', name: 'Bob' });
      await inventories.save(bob.id, 'default@single', { items: new Map([[P, 10 * 4096], [Item.Stick, 2]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(bob.id, Date.now() + 1e6, SECRET)}` } });
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      const have = (id: number) => new Map(msgs.filter((m) => m.type === 'inventory').at(-1)?.items ?? []).get(id) ?? 0;
      await until(() => msgs.some((m) => m.type === 'inventory'));
      const craft = async (recipe: string) => {
        const n = msgs.length;
        ws.send(JSON.stringify({ type: 'craft', recipe }));
        await until(() => msgs.slice(n).some((m) => m.type === 'inventory' || m.type === 'error'));
        const m = msgs.slice(n).find((m) => m.type === 'inventory' || m.type === 'error')!;
        return m.type === 'error' ? m.message : null;
      };
      // The crafting table recipe makes the crafting table item.
      expect(await craft('crafting-table')).toBeNull();
      expect(have(Item.CraftingTable)).toBe(1);
      ws.send(JSON.stringify({ type: 'pose', x: 100 * 16 + 8, y: 24, z: 103 * 16 + 8, yaw: 0 }));
      expect(await craft('wooden-sword')).toBe('needs a crafting table placed nearby');
      // Placed: it's the design (no crafting table material in it: planks and stone).
      ws.send(JSON.stringify({ type: 'placeObject', id: 1, item: Item.CraftingTable, x: 100, y: 0, z: 100, facing: 'n' }));
      await until(() => msgs.some((m) => m.type === 'editResult' && m.id === 1));
      expect(msgs.find((m) => m.type === 'editResult' && m.id === 1)).toMatchObject({ ok: true });
      expect(world.objectAt(101, 0, 100)).toMatchObject({ kind: 'design', design: 'new-table' });
      await until(() => have(Item.CraftingTable) === 0);
      expect(await craft('wooden-sword')).toBeNull();
      // Taken down: a crafting table back.
      ws.send(JSON.stringify({ type: 'mine', x: 101 * 16, y: 8, z: 100 * 16 }));
      await new Promise((r) => setTimeout(r, 60));
      ws.send(JSON.stringify({ type: 'edit', id: 2, edit: { op: 'remove', x: 101 * 16, y: 8, z: 100 * 16 } }));
      await until(() => have(Item.CraftingTable) === 1);
      expect(world.objectAt(100, 0, 100)).toBeUndefined();
      ws.close();
    } finally {
      await app.close();
    }
  });
});

describe('designs in play', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('admins design them; players are told, make them, place them, use them and take them down', async () => {
    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const inventories = new MemoryInventoryStore();
    const world = flat();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['ann@x.com'], secureCookies: false }, accounts);
    app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, miningTimeScale: 0.01, designs: new DesignLibrary(null) });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
    const bob = await accounts.signIn({ sub: 'g-bob', email: 'bob@x.com', name: 'Bob' });
    const cookieOf = (id: string) => `${SESSION_COOKIE}=${sessionToken(id, Date.now() + 1e6, SECRET)}`;
    const api = (method: string, path: string, cookie?: string, body?: unknown) =>
      fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : null });

    // Bob plays (planks enough for the recipe).
    await inventories.save(bob.id, 'default@single', { items: new Map([[P, 10 * 4096]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: cookieOf(bob.id) } });
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
    };
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
    await until(() => !!last('inventory'));
    // Told the (empty) library and placed designs, before the inventory.
    expect(msgs.findIndex((m) => m.type === 'designs')).toBeLessThan(msgs.findIndex((m) => m.type === 'inventory'));
    expect(last('designs')!.designs).toEqual([]);
    expect(last('objects')!.objects).toEqual([]);

    // Anyone may look; only admins may change it.
    expect(await (await api('GET', '/api/designs')).json()).toEqual({ designs: [], canEdit: false });
    expect((await api('PUT', '/api/designs/bench', cookieOf(bob.id), bench())).status).toBe(403);
    expect((await api('PUT', '/api/designs/bench', undefined, bench())).status).toBe(403);
    expect((await api('PUT', '/api/designs/other', cookieOf(ann.id), bench())).status).toBe(400);
    const bad = await api('PUT', '/api/designs/bench', cookieOf(ann.id), { ...bench(), states: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/states/);
    const put = await api('PUT', '/api/designs/bench', cookieOf(ann.id), bench());
    expect(put.status).toBe(200);
    const item = ((await put.json()) as { design: ObjectDesign }).design.item;
    expect(await (await api('GET', '/api/designs', cookieOf(ann.id))).json()).toMatchObject({ canEdit: true, designs: [{ id: 'bench', item }] });
    // Bob's told.
    await until(() => last('designs')!.designs.length === 1);

    // Bob makes two (3 planks), places one, uses it, takes it down.
    ws.send(JSON.stringify({ type: 'craft', recipe: 'design:bench' }));
    await until(() => new Map(last('inventory')!.items).get(item) === 2);
    expect(new Map(last('inventory')!.items).get(P)).toBe(7 * 4096);
    let id = 0;
    const act = async (msg: object) => {
      const n = ++id;
      ws.send(JSON.stringify({ ...msg, id: n }));
      await until(() => msgs.some((m) => m.type === 'editResult' && m.id === n));
      return msgs.find((m) => m.type === 'editResult' && m.id === n);
    };
    expect(await act({ type: 'placeObject', item, x: 100, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: true });
    await until(() => last('objects')!.objects.length === 1);
    await until(() => new Map(last('inventory')!.items).get(item) === 1);
    // Right-click its other block: folded.
    expect(await act({ type: 'use', x: 101 * 16 + 4, y: 10, z: 100 * 16 + 4 })).toMatchObject({ ok: true });
    await until(() => last('objects')!.objects[0]!.state === 1);
    expect(world.objectAt(100, 0, 100)!.state).toBe(1);
    // Mine any voxel of it: down it comes, back into the inventory.
    ws.send(JSON.stringify({ type: 'mine', x: 100 * 16, y: 0, z: 100 * 16 }));
    await new Promise((r) => setTimeout(r, 60));
    expect(await act({ type: 'edit', edit: { op: 'remove', x: 100 * 16, y: 0, z: 100 * 16 } })).toMatchObject({ ok: true });
    await until(() => new Map(last('inventory')!.items).get(item) === 2);
    await until(() => last('objects')!.objects.length === 0);
    expect(block(world, 100, 0, 100)).toBeNull();

    // Deleted from the library: Bob's told; his benches can't be placed.
    expect((await api('DELETE', '/api/designs/bench', cookieOf(ann.id))).status).toBe(200);
    expect((await api('DELETE', '/api/designs/bench', cookieOf(ann.id))).status).toBe(404);
    await until(() => last('designs')!.designs.length === 0);
    expect(await act({ type: 'placeObject', item, x: 100, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: false });
    ws.close();
  });
});
