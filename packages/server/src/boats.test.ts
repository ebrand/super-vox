import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BOAT, EditError, FLAT_WORLD_16KM, FlatGenerator, HOTBAR_SLOTS, Item, Material, PROTOCOL_VERSION, defaultFlatGen, setDesigns, type ObjectDesign, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { buildApp } from './app.js';
import { FileChunkStore } from './chunkStore.js';
import { DesignLibrary } from './designs.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const P = Material.Planks;
/** A 1 x 1 x 2 m boat (a plank floor and sides), standing in for the boat. */
const boatDesign = (): Omit<ObjectDesign, 'item'> => ({
  id: 'rowboat',
  name: 'Rowboat',
  size: [1, 1, 2],
  recipe: null,
  role: 'boat',
  states: [{ name: 's', voxels: [0, 8].flatMap((x) => [0, 8, 16, 24].map((z) => ({ x, y: 0, z, size: 8, material: P }))) }],
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  setDesigns([]);
});

/** Flat ground at y = 0, with a pool of (poured) water on it: blocks x, z 100..109, its top at y = 16. */
function withPool(store?: FileChunkStore): World {
  const w = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), store ? { store } : {});
  for (let x = 100; x < 110; x++) for (let z = 100; z < 110; z++) w.pourWater(x, 0, z, 16);
  return w;
}
const MID = 105 * 16;

describe('boats in the world', () => {
  it('go in the water (only), take one at a time, move with whoever is in them, and are kept as left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boats-'));
    dirs.push(dir);
    const d = new DesignLibrary(null).put(boatDesign()) as ObjectDesign;
    const w = withPool(new FileChunkStore(dir));
    let told = 0;
    w.onBoatsChanged = () => told++;
    expect(() => w.launchBoat(d, 50 * 16, 0, 50 * 16, 0)).toThrow(/in the water/);
    const b = w.launchBoat(d, MID, 12, MID, 0.5);
    // Floating: its bottom BOAT.draft under the top.
    expect(b).toMatchObject({ design: 'rowboat', x: MID, y: 16 - BOAT.draft, z: MID, yaw: 0.5 });
    expect(told).toBe(1);
    w.boardBoat(b.id, 7);
    expect(() => w.boardBoat(b.id, 8)).toThrow(/someone's in/);
    expect(() => w.takeBoat(b.id, 8)).toThrow(EditError);
    // Only its rider moves it, and not far at once.
    expect(w.moveBoat(b.id, 8, MID + 16, 13, MID, 0)).toBe(false);
    expect(w.moveBoat(b.id, 7, MID + 16 * 20, 13, MID, 0)).toBe(false);
    expect(w.moveBoat(b.id, 7, MID + 16, 13, MID + 8, 1)).toBe(true);
    expect(w.boatById(b.id)).toMatchObject({ x: MID + 16, z: MID + 8, yaw: 1, rider: 7 });
    // Left: where it was, nobody in it; kept so (nobody's in it when it's opened again).
    expect(w.moveBoat(b.id, 7, MID + 20, 13, MID + 8, 1, true)).toBe(true);
    expect(w.boatById(b.id)!.rider).toBeUndefined();
    w.boardBoat(b.id, 9);
    const again = withPool(new FileChunkStore(dir));
    expect(again.boatList()).toEqual([{ id: b.id, design: 'rowboat', x: MID + 20, y: 13, z: MID + 8, yaw: 1 }]);
    // A rider gone (disconnected): out of it.
    w.riderGone(9);
    expect(w.boatById(b.id)!.rider).toBeUndefined();
    // Taken: gone; the next one's a new one.
    w.takeBoat(b.id, 1);
    expect(w.boatList()).toEqual([]);
    expect(w.launchBoat(d, MID, 13, MID, 0).id).toBe(b.id + 1);
  });
});

describe('boats in play', () => {
  it('are put in, got into, steered (others see it go), got out of and taken', async () => {
    const lib = new DesignLibrary(null);
    lib.put(boatDesign());
    const world = withPool();
    const app = await buildApp({ catalog: singleWorld(world), designs: lib });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const join = async () => {
        const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
        const msgs: ServerMessage[] = [];
        ws.on('message', (m, bin) => !bin && msgs.push(JSON.parse(String(m)) as ServerMessage));
        await new Promise((r) => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
        return { ws, msgs };
      };
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      const ann = await join(), bob = await join();
      await until(() => ann.msgs.some((m) => m.type === 'boats') && bob.msgs.some((m) => m.type === 'boats'));
      let id = 0;
      const ask = async (msg: object) => {
        const n = ++id;
        ann.ws.send(JSON.stringify({ ...msg, id: n }));
        await until(() => ann.msgs.some((m) => m.type === 'editResult' && m.id === n));
        return ann.msgs.find((m) => m.type === 'editResult' && m.id === n) as Extract<ServerMessage, { type: 'editResult' }>;
      };
      const lastBoats = (msgs: ServerMessage[]) => msgs.filter((m): m is Extract<ServerMessage, { type: 'boats' }> => m.type === 'boats').at(-1)!.boats;
      // Not placed like an object.
      expect(await ask({ type: 'placeObject', item: Item.Boat, x: 105, y: 1, z: 105, facing: 'n' })).toMatchObject({ ok: false, error: /goes in the water/ });
      expect(await ask({ type: 'boatLaunch', x: 50 * 16, y: 0, z: 50 * 16, yaw: 0 })).toMatchObject({ ok: false, error: /in the water/ });
      expect(await ask({ type: 'boatLaunch', x: MID, y: 13, z: MID, yaw: 0 })).toMatchObject({ ok: true });
      await until(() => lastBoats(bob.msgs).length === 1);
      const boat = lastBoats(bob.msgs)[0]!;
      expect(await ask({ type: 'boatBoard', boat: boat.id })).toMatchObject({ ok: true });
      await until(() => lastBoats(bob.msgs)[0]?.rider !== undefined);
      // Steered: Bob sees it move (Ann isn't told her own moves).
      ann.ws.send(JSON.stringify({ type: 'boatMove', boat: boat.id, x: MID + 16, y: 13, z: MID, yaw: 0.3 }));
      await until(() => bob.msgs.some((m) => m.type === 'boatMoved'));
      expect(bob.msgs.find((m) => m.type === 'boatMoved')).toMatchObject({ id: boat.id, x: MID + 16, yaw: 0.3 });
      expect(ann.msgs.some((m) => m.type === 'boatMoved')).toBe(false);
      // Bob can't take it from under her, or steer it.
      bob.ws.send(JSON.stringify({ type: 'boatTake', id: 1, boat: boat.id }));
      await until(() => bob.msgs.some((m) => m.type === 'editResult'));
      expect(bob.msgs.find((m) => m.type === 'editResult')).toMatchObject({ ok: false });
      // Out: nobody in it, where she left it.
      ann.ws.send(JSON.stringify({ type: 'boatMove', boat: boat.id, x: MID + 20, y: 13, z: MID, yaw: 0.3, leave: true }));
      await until(() => lastBoats(bob.msgs)[0]?.rider === undefined && lastBoats(bob.msgs)[0]?.x === MID + 20);
      // Taken.
      expect(await ask({ type: 'boatTake', boat: boat.id })).toMatchObject({ ok: true });
      await until(() => lastBoats(bob.msgs).length === 0);
      ann.ws.close();
      bob.ws.close();
    } finally {
      await app.close();
    }
  });
});

describe('boats in survival', () => {
  it('are made at a table, leave the inventory when put in, and come back when taken', async () => {
    const lib = new DesignLibrary(null);
    lib.put(boatDesign());
    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const inventories = new MemoryInventoryStore();
    const world = withPool();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, designs: lib });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const bob = await accounts.signIn({ sub: 'g-bob', email: 'bob@x.com', name: 'Bob' });
      await inventories.save(bob.id, 'default@single', { items: new Map([[P, 5 * 4096]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(bob.id, Date.now() + 1e6, SECRET)}` } });
      const msgs: ServerMessage[] = [];
      ws.on('message', (m, bin) => !bin && msgs.push(JSON.parse(String(m)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      const have = (id: number) => new Map(msgs.filter((m) => m.type === 'inventory').at(-1)?.items ?? []).get(id) ?? 0;
      await until(() => msgs.some((m) => m.type === 'inventory'));
      let id = 0;
      const ask = async (msg: object) => {
        const n = ++id;
        ws.send(JSON.stringify({ ...msg, id: n }));
        await until(() => msgs.some((m) => m.type === 'editResult' && m.id === n));
        return msgs.find((m) => m.type === 'editResult' && m.id === n) as Extract<ServerMessage, { type: 'editResult' }>;
      };
      ws.send(JSON.stringify({ type: 'pose', x: MID, y: 16 + 26, z: MID + 48, yaw: 0 }));
      // None yet: can't put one in.
      expect(await ask({ type: 'boatLaunch', x: MID, y: 15, z: MID, yaw: 0 })).toMatchObject({ ok: false });
      // Made from 5 planks (at a crafting table: not here).
      ws.send(JSON.stringify({ type: 'craft', recipe: 'boat' }));
      await until(() => msgs.some((m) => m.type === 'error'));
      expect(msgs.find((m) => m.type === 'error')).toMatchObject({ message: /crafting table/ });
      // Given one: put in (gone from the inventory), and taken back.
      await inventories.save(bob.id, 'default@single', { items: new Map([[Item.Boat, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
      ws.close();
      const ws2 = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(bob.id, Date.now() + 1e6, SECRET)}` } });
      msgs.length = 0;
      ws2.on('message', (m, bin) => !bin && msgs.push(JSON.parse(String(m)) as ServerMessage));
      await new Promise((r) => ws2.once('open', r));
      ws2.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      await until(() => have(Item.Boat) === 1);
      ws2.send(JSON.stringify({ type: 'pose', x: MID, y: 16 + 26, z: MID + 48, yaw: 0 }));
      const ask2 = async (msg: object) => {
        const n = ++id;
        ws2.send(JSON.stringify({ ...msg, id: n }));
        await until(() => msgs.some((m) => m.type === 'editResult' && m.id === n));
        return msgs.find((m) => m.type === 'editResult' && m.id === n) as Extract<ServerMessage, { type: 'editResult' }>;
      };
      expect(await ask2({ type: 'boatLaunch', x: MID, y: 15, z: MID, yaw: 0 })).toMatchObject({ ok: true });
      await until(() => have(Item.Boat) === 0);
      const boat = world.boatList()[0]!;
      // Too far to take from out at sea.
      ws2.send(JSON.stringify({ type: 'pose', x: MID + 30 * 16, y: 42, z: MID, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(await ask2({ type: 'boatTake', boat: boat.id })).toMatchObject({ ok: false, error: /too far/ });
      ws2.send(JSON.stringify({ type: 'pose', x: MID, y: 42, z: MID + 48, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(await ask2({ type: 'boatTake', boat: boat.id })).toMatchObject({ ok: true });
      await until(() => have(Item.Boat) === 1);
      expect(world.boatList()).toEqual([]);
      ws2.close();
    } finally {
      await app.close();
    }
  });
});
