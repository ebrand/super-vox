import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  BLOCK_VOLUME,
  FLAT_WORLD_16KM,
  FlatGenerator,
  HOTBAR_SLOTS,
  Item,
  Material,
  PROTOCOL_VERSION,
  defaultFlatGen,
  recipeById,
  setDesigns,
  type GameMode,
  type ObjectDesign,
  type ServerMessage,
} from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { DesignLibrary } from './designs.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const P = Material.Planks;
/** What the single world's players are filed under (see inventoryKeyOf). */
const KEY = 'default@single';

/** A 2 x 1 x 1 m bed (as drawn: facing north): a 1/2 m mattress on the ground. */
function bed(): Omit<ObjectDesign, 'item'> {
  return {
    id: 'bed',
    name: 'Bed',
    size: [2, 1, 1],
    recipe: null,
    role: 'bed',
    states: [{ name: 'made', voxels: [0, 8, 16, 24].flatMap((x) => [0, 8].map((z) => ({ x, y: 0, z, size: 8, material: P }))) }],
  };
}

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
  setDesigns([]);
});

/** A flat world (ground at y = 0) in `mode` with sign-in, inventories and a bed design. */
async function setup(mode: GameMode) {
  const accounts = new MemoryAccountStore();
  const inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  const designs = new DesignLibrary(null);
  designs.put(bed());
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories, miningTimeScale: 0.01, designs });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  const cookie = `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}`;
  return { url, cookie, inventories, ann, world };
}

/** A signed-in connection that says hello, collects what comes back, and waits for its inventory. */
async function player(url: string, cookie: string) {
  const ws = new WebSocket(url, { headers: { cookie } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 3000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  let nextId = 1;
  const act = async (msg: object) => {
    const id = nextId++;
    ws.send(JSON.stringify({ ...msg, id }));
    await until(() => msgs.some((m) => m.type === 'editResult' && m.id === id));
    return msgs.find((m) => m.type === 'editResult' && m.id === id)!;
  };
  const respawns = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'respawn' }> => m.type === 'respawn');
  return {
    ws,
    msgs,
    until,
    act,
    healths: () => msgs.filter((m): m is Extract<ServerMessage, { type: 'health' }> => m.type === 'health'),
    respawns,
    /** Falls to their death (as the client reports it), and waits to be sent back. */
    async die() {
      const n = respawns().length;
      ws.send(JSON.stringify({ type: 'fell', speed: 50 }));
      await until(() => respawns().length > n);
      return respawns().at(-1)!;
    },
    async close() {
      ws.close();
      await new Promise((r) => setTimeout(r, 100)); // (saved as it closes)
    },
  };
}

describe('saving the player', () => {
  it("keeps health, food and breath between visits, so reloading the page doesn't heal", async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    // First visit: whole; a 10 m fall hurts (7), and that's kept when they leave.
    const a = await player(url, cookie);
    await a.until(() => a.healths().length > 0);
    expect(a.healths()[0]).toMatchObject({ health: 20, food: 20, air: 10 });
    a.ws.send(JSON.stringify({ type: 'fell', speed: 20 }));
    await a.until(() => a.healths().some((h) => h.health === 13));
    await a.close();
    expect((await inventories.loadState(ann.id, KEY))?.vitals).toMatchObject({ health: 13, food: 20 });
    // Back: still hurt.
    const b = await player(url, cookie);
    await b.until(() => b.healths().length > 0);
    expect(b.healths()[0]).toMatchObject({ health: 13, food: 20 });
    await b.close();
    // Hungry and out of breath, kept: as they were (3 s of breath of 15: 2 bubbles of 10).
    await inventories.saveState(ann.id, KEY, { vitals: { health: 5, food: 7, air: 3, exhaustion: 1 }, bed: null });
    const c = await player(url, cookie);
    await c.until(() => c.healths().length > 0);
    expect(c.healths()[0]).toMatchObject({ health: 5, food: 7 });
    expect(c.healths()[0]!.air).toBeLessThanOrEqual(3); // (breath coming back by the time it's sent)
    await c.close();
    // Nonsense kept (dead, or too much): left whole.
    await inventories.saveState(ann.id, KEY, { vitals: { health: 0, food: 99, air: -1, exhaustion: Number.NaN }, bed: null });
    const d = await player(url, cookie);
    await d.until(() => d.healths().length > 0);
    expect(d.healths()[0]).toMatchObject({ health: 20, food: 20, air: 10 });
    await d.close();
  }, 15_000);

  it('keeps them whole after dying', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    await inventories.saveState(ann.id, KEY, { vitals: { health: 5, food: 7, air: 15, exhaustion: 0 }, bed: null });
    const a = await player(url, cookie);
    await a.die();
    // Saved as they came back (before they leave).
    expect((await inventories.loadState(ann.id, KEY))?.vitals).toMatchObject({ health: 20, food: 20 });
    await a.close();
  });

  it('leaves vitals alone in creative', async () => {
    const { url, cookie, inventories, ann } = await setup('creative');
    const a = await player(url, cookie);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.healths()).toEqual([]);
    await a.close();
    expect((await inventories.loadState(ann.id, KEY))?.vitals ?? null).toBeNull();
  });
});

describe('beds', () => {
  it('are made by their recipe once a design is the bed', async () => {
    await setup('survival');
    expect(recipeById('bed')).toMatchObject({ inputs: [[P, 3], [Material.Leaves, 3]], output: [Item.Bed, 1], table: true });
  });

  it('right-clicked, are where their owner comes back to after dying: kept between visits; built over or taken down, the spawn point', async () => {
    const { url, cookie, inventories, ann, world } = await setup('survival');
    await inventories.save(ann.id, KEY, { items: new Map([[Item.Bed, 1], [Material.Stone, 10 * BLOCK_VOLUME]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const a = await player(url, cookie);
    // No bed yet: the spawn point.
    const first = await a.die();
    expect(first).toMatchObject({ x: world.spawn.x, y: world.spawn.y, z: world.spawn.z });
    expect(first.bed).toBeUndefined();
    // Placed (blocks 100 and 101 along x, at the ground), then right-clicked: theirs.
    expect(await a.act({ type: 'placeObject', item: Item.Bed, x: 100, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: true });
    expect(world.objectAt(101, 0, 100)).toMatchObject({ kind: 'design', design: 'bed' });
    expect(await a.act({ type: 'use', x: 101 * 16 + 4, y: 4, z: 100 * 16 + 4 })).toEqual({ type: 'editResult', id: 2, ok: true, note: "this is your bed now: you'll come back here after dying" });
    expect(await a.act({ type: 'use', x: 100 * 16 + 4, y: 4, z: 100 * 16 + 4 })).toMatchObject({ ok: true, note: 'this is already your bed' });
    expect((await inventories.loadState(ann.id, KEY))?.bed).toEqual({ x: 100, y: 0, z: 100 });
    // Died: on top of it, in the middle (feet).
    expect(await a.die()).toMatchObject({ x: 101 * 16, y: 16, z: 100 * 16 + 8, bed: 'here' });
    await a.close();
    // Another visit: still theirs.
    const b = await player(url, cookie);
    expect(await b.die()).toMatchObject({ x: 101 * 16, y: 16, bed: 'here' });
    // A block on it: they stand on that (sent half a metre lower: the client stands them half a metre up).
    expect(await b.act({ type: 'edit', edit: { op: 'place', x: 100 * 16, y: 16, z: 100 * 16, size: 16, material: Material.Stone } })).toMatchObject({ ok: true });
    expect(await b.die()).toMatchObject({ x: 101 * 16, y: 32 - 8, bed: 'here' });
    // Three: no room; the spawn point (the bed kept, should it be dug out).
    for (const y of [32, 48]) expect(await b.act({ type: 'edit', edit: { op: 'place', x: 100 * 16, y, z: 100 * 16, size: 16, material: Material.Stone } })).toMatchObject({ ok: true });
    expect(await b.die()).toMatchObject({ x: world.spawn.x, y: world.spawn.y, z: world.spawn.z, bed: 'blocked' });
    expect((await inventories.loadState(ann.id, KEY))?.bed).toEqual({ x: 100, y: 0, z: 100 });
    // Taken down: gone (said once, then forgotten).
    b.ws.send(JSON.stringify({ type: 'mine', x: 101 * 16, y: 4, z: 100 * 16 }));
    await new Promise((r) => setTimeout(r, 60));
    expect(await b.act({ type: 'edit', edit: { op: 'remove', x: 101 * 16, y: 4, z: 100 * 16 } })).toMatchObject({ ok: true });
    expect(world.objectAt(100, 0, 100)).toBeUndefined();
    expect(await b.die()).toMatchObject({ x: world.spawn.x, bed: 'gone' });
    expect((await b.die()).bed).toBeUndefined();
    expect((await inventories.loadState(ann.id, KEY))?.bed).toBeNull();
    await b.close();
  }, 15_000);

  it("aren't anything to right-click on another kind of object", async () => {
    const { url, cookie } = await setup('creative');
    const a = await player(url, cookie);
    expect(await a.act({ type: 'placeObject', item: Item.Fence, x: 100, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: true });
    expect(await a.act({ type: 'use', x: 100 * 16 + 8, y: 8, z: 100 * 16 + 8 })).toMatchObject({ ok: false, error: 'nothing to open there' });
    await a.close();
  });
});
