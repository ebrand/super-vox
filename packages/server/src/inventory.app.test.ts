import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FUSE_MS, FlatGenerator, HOTBAR_SLOTS, Item, Material, PROTOCOL_VERSION, defaultFlatGen, type GameMode, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { MobManager } from './mobManager.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const B = BLOCK_VOLUME;
type Inv = Extract<ServerMessage, { type: 'inventory' }>;

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A flat world (grass over dirt over stone, 1/4 m voxels) in `mode`, with sign-in and inventories. */
async function setup(mode: GameMode, mobs?: (w: World) => MobManager, miningTimeScale = 0.01) {
  const accounts = new MemoryAccountStore();
  const inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories, miningTimeScale, ...(mobs ? { mobs } : {}) });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  const cookie = `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}`;
  return { url, cookie, inventories, ann, world };
}

/** A connection that says hello and collects what comes back. */
async function player(url: string, cookie?: string) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 3000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  let nextId = 1;
  const inventories = () => msgs.filter((m): m is Inv => m.type === 'inventory');
  return {
    ws,
    msgs,
    until,
    inventory: () => inventories().at(-1),
    async edit(edit: object) {
      const id = nextId++;
      const before = inventories().length;
      ws.send(JSON.stringify({ type: 'edit', id, edit }));
      await until(() => msgs.some((m) => m.type === 'editResult' && m.id === id));
      const result = msgs.find((m) => m.type === 'editResult' && m.id === id)!;
      // An accepted survival edit is followed by the new inventory.
      if (result.type === 'editResult' && result.ok && inventories()[0]?.mode === 'survival') await until(() => inventories().length > before);
      return result;
    },
    /** Survival: starts mining an edit's spot, waits `ms` (as the player holds the button), then makes it. */
    async mine(e: { op: string; x: number; y: number; z: number; size?: number }, ms = 60) {
      ws.send(JSON.stringify({ type: 'mine', x: e.x, y: e.y, z: e.z }));
      await new Promise((r) => setTimeout(r, ms));
      return this.edit(e);
    },
  };
}

describe('mining', () => {
  it('makes survival players mine for as long as the material takes; creative ones not at all', async () => {
    // Ten times as slow as normal: a 1/4 m grass voxel (0.19 s) takes about 1.9 s.
    const { url, cookie } = await setup('survival', undefined, 10);
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    const grass = { op: 'remove', x: 1000, y: -1, z: 1000 };
    // Without mining, too soon, or mining somewhere else: refused.
    expect(await p.edit(grass)).toMatchObject({ ok: false, error: 'keep mining: it takes longer' });
    expect(await p.mine(grass, 100)).toMatchObject({ ok: false, error: 'keep mining: it takes longer' });
    p.ws.send(JSON.stringify({ type: 'mine', x: 1004, y: -1, z: 1000 }));
    await new Promise((r) => setTimeout(r, 1700));
    expect(await p.edit(grass)).toMatchObject({ ok: false });
    // Mined long enough: out it comes.
    expect(await p.mine(grass, 1700)).toMatchObject({ ok: true });
    // A dig box needs mining too (everything in it).
    expect(await p.edit({ op: 'removeBox', x: 2000, y: -16, z: 2000, size: 16 })).toMatchObject({ ok: false, error: 'keep mining: it takes longer' });
    p.ws.close();
    // Creative: at once.
    await app.close();
    const c = await setup('creative', undefined, 10);
    const q = await player(c.url, c.cookie);
    await q.until(() => !!q.inventory());
    expect(await q.edit(grass)).toMatchObject({ ok: true });
    expect(await q.edit({ op: 'removeBox', x: 2000, y: -16, z: 2000, size: 16 })).toMatchObject({ ok: true });
    q.ws.close();
  }, 20_000);

  it('times mining by what is there', () => {
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    // A 1/4 m voxel of grass at the top: 0.75 s a block, a quarter of the edge.
    expect(world.miningTime({ op: 'remove', x: 1000, y: -1, z: 1000 })).toBeCloseTo(0.75 / 4, 9);
    // Air: nothing to mine.
    expect(world.miningTime({ op: 'remove', x: 1000, y: 40, z: 1000 })).toBe(0);
    // A 1 m box of ground: between all dirt and all stone; deeper (all stone) takes a stone block's time.
    const top = world.miningTime({ op: 'removeBox', x: 2000, y: -16, z: 2000, size: 16 });
    expect(top).toBeGreaterThan(0.7);
    expect(top).toBeLessThan(3);
    expect(world.miningTime({ op: 'removeBox', x: 2000, y: -160, z: 2000, size: 16 })).toBeCloseTo(3, 6);
  });
});

describe('big boxes (creative)', () => {
  it('digs and fills boxes up to 16 m in creative, across chunks; not in survival', async () => {
    const { url, cookie } = await setup('creative');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    const chunksBefore = p.msgs.length;
    // A 4 m dig box crossing a chunk border (x 3200 + 192 .. + 256: chunks 12 and 13).
    expect(await p.edit({ op: 'removeBox', x: 3200 + 192, y: -64, z: 3200, size: 64 })).toMatchObject({ ok: true });
    // A 4 m fill across the same border, of planks.
    expect(await p.edit({ op: 'fillBox', x: 3200 + 192, y: 0, z: 3200, size: 64, material: Material.Planks })).toMatchObject({ ok: true });
    expect(p.msgs.length).toBeGreaterThan(chunksBefore);
    // Not fences, not off the grid, not water.
    expect(await p.edit({ op: 'fillBox', x: 3200, y: 0, z: 3200, size: 32, material: Material.FenceWood })).toMatchObject({ ok: false });
    expect(await p.edit({ op: 'fillBox', x: 3208, y: 0, z: 3200, size: 32, material: Material.Stone })).toMatchObject({ ok: false, error: 'a fill box lies on the 1 m grid' });
    expect(await p.edit({ op: 'fillBox', x: 3200, y: 0, z: 3200, size: 32, material: Material.Water })).toMatchObject({ ok: false });
    p.ws.close();
    await app.close();
    // Survival: no.
    const s = await setup('survival');
    const q = await player(s.url, s.cookie);
    await q.until(() => !!q.inventory());
    expect(await q.mine({ op: 'removeBox', x: 3200, y: -64, z: 3200, size: 64 })).toMatchObject({ ok: false, error: 'boxes over 1 m are for creative worlds' });
    expect(await q.edit({ op: 'fillBox', x: 3200, y: 0, z: 3200, size: 32, material: Material.Dirt })).toMatchObject({ ok: false, error: 'boxes over 1 m are for creative worlds' });
    q.ws.close();
  });
});

describe('survival needs', () => {
  type Health = Extract<ServerMessage, { type: 'health' }>;
  const healths = (msgs: ServerMessage[]) => msgs.filter((m): m is Health => m.type === 'health');

  it('a hard landing hurts (a point a metre past 3 m), a long enough fall kills; not in creative', async () => {
    const { url, cookie } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => healths(p.msgs).length > 0);
    expect(healths(p.msgs).at(-1)).toMatchObject({ health: 20, max: 20, food: 20, air: 10 });
    p.ws.send(JSON.stringify({ type: 'pose', x: 9000 * 16, y: 26, z: 9000 * 16, yaw: 0 }));
    p.ws.send(JSON.stringify({ type: 'fell', speed: Math.sqrt(2 * 20 * 3) })); // 3 m: nothing
    p.ws.send(JSON.stringify({ type: 'fell', speed: Math.sqrt(2 * 20 * 10) })); // 10 m: 7
    await p.until(() => healths(p.msgs).at(-1)!.health < 20);
    expect(healths(p.msgs).at(-1)!.health).toBe(13);
    p.ws.send(JSON.stringify({ type: 'fell', speed: 50 }));
    await p.until(() => p.msgs.some((m) => m.type === 'respawn'));
    expect(p.msgs.find((m) => m.type === 'respawn')).toMatchObject({ cause: 'fell' });
    await p.until(() => healths(p.msgs).at(-1)!.health === 20);
    p.ws.close();

    await app.close();
    const c = await setup('creative');
    const q = await player(c.url, c.cookie);
    await q.until(() => !!q.inventory());
    q.ws.send(JSON.stringify({ type: 'fell', speed: 50 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(healths(q.msgs)).toEqual([]);
    expect(q.msgs.some((m) => m.type === 'respawn')).toBe(false);
    q.ws.close();
  });

  it('breath runs out with your head under water, and comes back above it', async () => {
    const { url, cookie, world } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => healths(p.msgs).length > 0);
    const x = 9100 * 16, z = 9100 * 16;
    // A well 2 m deep (stone walls, so the water stays), full.
    for (const y of [0, 16]) {
      for (const [dx, dz] of [[-16, 0], [16, 0], [0, -16], [0, 16]]) world.applyEdit({ op: 'place', x: x + dx!, y, z: z + dz!, size: 16, material: Material.Stone });
      world.applyEdit({ op: 'place', x, y, z, size: 16, material: Material.Water });
    }
    p.ws.send(JSON.stringify({ type: 'pose', x: x + 8, y: 26, z: z + 8, yaw: 0 })); // eye 1.62 m up: in the water
    await p.until(() => healths(p.msgs).at(-1)!.air <= 8, 4000);
    p.ws.send(JSON.stringify({ type: 'pose', x: x + 8 + 32, y: 26, z: z + 8, yaw: 0 })); // out of it
    await p.until(() => healths(p.msgs).at(-1)!.air === 10, 3000);
    expect(healths(p.msgs).every((h) => h.health === 20)).toBe(true);
    p.ws.close();
  }, 10_000);

  it('pigs give pork; going places makes you hungry; eating pork fills you up (not past full)', async () => {
    let manager: MobManager | null = null;
    const { url, cookie, inventories, ann } = await setup('survival', (w) => (manager = new MobManager(w, () => 0.999)));
    await inventories.save(ann.id, 'default@single', { items: new Map([[Item.StoneSword, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory() && healths(p.msgs).length > 0);
    const errors = () => p.msgs.filter((m) => m.type === 'error' && m.code === 'eat').map((m) => (m as { message: string }).message);
    const at = { x: 8000 * 16, z: 8000 * 16 };
    p.ws.send(JSON.stringify({ type: 'pose', x: at.x, y: 26, z: at.z, yaw: 0 }));
    p.ws.send(JSON.stringify({ type: 'eat', item: Item.Pork }));
    await p.until(() => errors().length === 1);
    expect(errors()[0]).toBe('no pork left');
    // A pig: two stone-sword hits.
    await p.until(() => manager !== null);
    const pig = manager!.add('pig', at.x, 0, at.z - 2 * 16, Date.now());
    p.ws.send(JSON.stringify({ type: 'attack', target: pig.id, weapon: Item.StoneSword }));
    await new Promise((r) => setTimeout(r, 450));
    p.ws.send(JSON.stringify({ type: 'attack', target: pig.id, weapon: Item.StoneSword }));
    await p.until(() => (p.inventory()!.items.find(([id]) => id === Item.Pork)?.[1] ?? 0) > 0);
    const pork = p.inventory()!.items.find(([id]) => id === Item.Pork)![1];
    expect(pork).toBeGreaterThanOrEqual(1);
    expect(pork).toBeLessThanOrEqual(3);
    // Full: not hungry.
    p.ws.send(JSON.stringify({ type: 'eat', item: Item.Pork }));
    await p.until(() => errors().length === 2);
    expect(errors()[1]).toBe("you're not hungry");
    // Sprinting 25 m a tenth of a second for a second and a half: hungry.
    for (let i = 1; i <= 15; i++) {
      p.ws.send(JSON.stringify({ type: 'pose', x: at.x + i * 25 * 16, y: 26, z: at.z, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 100));
    }
    await p.until(() => healths(p.msgs).at(-1)!.food <= 12);
    const hungry = healths(p.msgs).at(-1)!.food;
    p.ws.send(JSON.stringify({ type: 'eat', item: Item.Pork }));
    await p.until(() => healths(p.msgs).at(-1)!.food > hungry);
    // Four back (or three: a point may have gone meanwhile, to the last sprint or just living).
    expect(healths(p.msgs).at(-1)!.food).toBeGreaterThanOrEqual(hungry + 3);
    expect(healths(p.msgs).at(-1)!.food).toBeLessThanOrEqual(hungry + 4);
    await p.until(() => (p.inventory()!.items.find(([id]) => id === Item.Pork)?.[1] ?? 0) === pork - 1);
    p.ws.close();
  }, 15_000);
});

describe('TNT', () => {
  it('lights with a click, blows after its fuse (everyone told), and hurts a survival player nearby', async () => {
    const { url, cookie, world } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    const tnt = { x: 4000 * 16, y: 0, z: 4000 * 16, size: 16 };
    world.applyEdit({ op: 'place', ...tnt, material: Material.TNT });
    // Standing 3 m off (the pose is the eye, units).
    p.ws.send(JSON.stringify({ type: 'pose', x: tnt.x + 8 + 48, y: 26, z: tnt.z + 8, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    // What arrives from now on, in order (text by type; chunks as 'chunk').
    const order: string[] = [];
    p.ws.on('message', (d, bin) => order.push(bin ? 'chunk' : (JSON.parse(String(d)) as ServerMessage).type));
    expect(await act(p, { type: 'ignite', x: tnt.x + 4, y: 4, z: tnt.z + 4 })).toMatchObject({ ok: true });
    expect(p.msgs.find((m) => m.type === 'fuse')).toMatchObject({ type: 'fuse', ...tnt, ms: FUSE_MS });
    expect(await act(p, { type: 'ignite', x: tnt.x + 4, y: 4, z: tnt.z + 4 })).toMatchObject({ ok: false, error: "it's already lit" });
    expect(await act(p, { type: 'ignite', x: tnt.x + 40, y: 4, z: tnt.z + 4 })).toMatchObject({ ok: false, error: 'nothing to light there' });
    await p.until(() => p.msgs.some((m) => m.type === 'explosion'), FUSE_MS + 2000);
    expect(p.msgs.find((m) => m.type === 'explosion')).toEqual({ type: 'explosion', x: tnt.x + 8, y: 8, z: tnt.z + 8, radius: 128, seed: expect.any(Number), open: expect.any(Array) });
    // The explosion before the crater's chunks (clients make its dust from the world as it was).
    await p.until(() => order.lastIndexOf('chunk') > order.indexOf('explosion'), 8000);
    expect(order.indexOf('explosion')).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, order.indexOf('explosion')).filter((t) => t === 'chunk').length).toBe(0);
    // Hurt (players are told their health on joining too: the blast's is the one below 20).
    await p.until(() => p.msgs.some((m) => m.type === 'health' && m.health < 20), 8000);
    expect(world.explosiveAt(tnt.x + 4, 4, tnt.z + 4)).toBeNull();
    p.ws.close();
  }, 25_000);
});

/** Sends a message with an id and waits for its editResult. */
async function act(p: Awaited<ReturnType<typeof player>>, msg: object) {
  const id = 9000 + Math.floor(Math.random() * 1000);
  p.ws.send(JSON.stringify({ ...msg, id }));
  await p.until(() => p.msgs.some((m) => m.type === 'editResult' && m.id === id));
  return p.msgs.find((m) => m.type === 'editResult' && m.id === id)!;
}

describe('inventories', () => {
  it('start a survival player with the kit, take what they place and give what they mine', async () => {
    const { url, cookie } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    expect(p.inventory()).toEqual({
      type: 'inventory',
      mode: 'survival',
      items: [[Material.Dirt, 16 * B], [Material.Stone, 16 * B], [Material.Wood, 16 * B]],
      hotbar: [Material.Dirt, Material.Stone, Material.Wood, ...Array(HOTBAR_SLOTS - 3).fill(null)],
    });
    // Mining a 1/4 m grass voxel gives that much dirt.
    expect(await p.mine({ op: 'remove', x: 1000, y: -1, z: 1000 })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Dirt)).toBe(16 * B + 64);
    // Placing a 1 m stone block uses one.
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Stone })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Stone)).toBe(15 * B);
    // Mining it back gives cobblestone, as mining stone does.
    expect(await p.mine({ op: 'remove', x: 1600, y: 0, z: 1600 })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Stone)).toBe(15 * B);
    expect(new Map(p.inventory()!.items).get(Material.Cobblestone)).toBe(B);
    // No sand, no water in survival.
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Sand })).toEqual({
      type: 'editResult', id: 4, ok: false, error: 'not enough sand (have 0, need 1 blocks)',
    });
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Water })).toMatchObject({ ok: false, error: "water can't be placed in survival" });
    p.ws.close();
  });

  it('keep the hotbar and items across visits', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Wood });
    const hotbar = [Material.Wood, null, null, null, null, null, null, null, Material.Dirt];
    p.ws.send(JSON.stringify({ type: 'setHotbar', hotbar }));
    await new Promise((r) => setTimeout(r, 50));
    p.ws.close();
    // Saved when the connection closes.
    for (let i = 0; i < 100 && !(await inventories.load(ann.id, 'default@single'))?.hotbar[8]; i++) await new Promise((r) => setTimeout(r, 10));
    const again = await player(url, cookie);
    await again.until(() => !!again.inventory());
    expect(again.inventory()!.hotbar).toEqual(hotbar);
    expect(new Map(again.inventory()!.items).get(Material.Wood)).toBe(15 * B);
    again.ws.close();
  });

  it('make everything unlimited in creative', async () => {
    const { url, cookie } = await setup('creative');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    expect(p.inventory()).toMatchObject({ mode: 'creative', items: [] });
    expect(p.inventory()!.hotbar).toHaveLength(HOTBAR_SLOTS);
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Sand })).toMatchObject({ ok: true });
    expect(await p.edit({ op: 'place', x: 1600, y: 256, z: 1600, size: 16, material: Material.Water })).toMatchObject({ ok: true });
    expect(p.msgs.filter((m) => m.type === 'inventory')).toHaveLength(1);
    p.ws.close();
  });

  it('craft, with recipes that need a crafting table only near one', async () => {
    const { url, cookie } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    const craft = async (recipe: string) => {
      const n = p.msgs.length;
      p.ws.send(JSON.stringify({ type: 'craft', recipe }));
      await p.until(() => p.msgs.slice(n).some((m) => m.type === 'inventory' || (m.type === 'error' && m.code === 'craft')));
      const reply = p.msgs.slice(n).find((m) => m.type === 'inventory' || m.type === 'error')!;
      return reply.type === 'error' ? reply.message : null;
    };
    const have = (id: number) => new Map(p.inventory()!.items).get(id) ?? 0;
    expect(await craft('planks')).toBeNull();
    expect(await craft('planks')).toBeNull();
    expect(have(Material.Planks)).toBe(8 * B);
    expect(have(Material.Wood)).toBe(14 * B);
    expect(await craft('sticks')).toBeNull();
    expect(await craft('crafting-table')).toBeNull();
    expect(have(Material.CraftingTable)).toBe(B);
    // Standing over open ground: no table near.
    p.ws.send(JSON.stringify({ type: 'pose', x: 1608, y: 40, z: 1608, yaw: 0 }));
    expect(await craft('wooden-sword')).toBe('needs a crafting table nearby');
    // Put the table down right there.
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.CraftingTable })).toMatchObject({ ok: true });
    expect(have(Material.CraftingTable)).toBe(0);
    expect(await craft('wooden-sword')).toBeNull();
    expect(have(Item.WoodenSword)).toBe(1);
    // Walk 10 m away (with planks enough): out of reach again.
    expect(await craft('planks')).toBeNull();
    p.ws.send(JSON.stringify({ type: 'pose', x: 1608 + 160, y: 40, z: 1608, yaw: 0 }));
    expect(await craft('wooden-sword')).toBe('needs a crafting table nearby');
    p.ws.close();
  });

  it('place, open and take down fences, gates and doors with items from the inventory', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    await inventories.save(ann.id, 'default@single', { items: new Map([[Item.Fence, 2], [Item.Gate, 1], [Item.WoodenSword, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    let id = 100;
    const act = async (msg: object) => {
      const n = ++id;
      p.ws.send(JSON.stringify({ ...msg, id: n }));
      await p.until(() => p.msgs.some((m) => m.type === 'editResult' && m.id === n));
      await new Promise((r) => setTimeout(r, 30)); // the inventory follows
      return p.msgs.find((m) => m.type === 'editResult' && m.id === n);
    };
    const have = (item: number) => new Map(p.inventory()!.items).get(item) ?? 0;
    expect(await act({ type: 'placeObject', item: Item.Fence, x: 100, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: true });
    expect(await act({ type: 'placeObject', item: Item.Gate, x: 101, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: true });
    expect(have(Item.Fence)).toBe(1);
    expect(have(Item.Gate)).toBe(0);
    expect(await act({ type: 'placeObject', item: Item.Gate, x: 103, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: false, error: 'no gate left' });
    expect(await act({ type: 'placeObject', item: Item.WoodenSword, x: 103, y: 0, z: 100, facing: 'n' })).toMatchObject({ ok: false, error: "a wooden sword isn't placed like that" });
    // Right-click any voxel of the gate (units): opens it; a fence doesn't open.
    expect(await act({ type: 'use', x: 101 * 16 + 8, y: 5, z: 100 * 16 + 8 })).toMatchObject({ ok: true });
    expect(await act({ type: 'use', x: 100 * 16 + 8, y: 5, z: 100 * 16 + 8 })).toMatchObject({ ok: false, error: 'nothing to open there' });
    // Left-click any part of the fence: down it comes, back into the inventory.
    expect(await p.mine({ op: 'remove', x: 100 * 16 + 7, y: 2, z: 100 * 16 + 7 })).toMatchObject({ ok: true });
    expect(have(Item.Fence)).toBe(2);
    p.ws.close();
    const guest = await player(url);
    await guest.until(() => guest.msgs.some((m) => m.type === 'welcome'));
    guest.ws.send(JSON.stringify({ type: 'use', id: 9, x: 101 * 16 + 8, y: 5, z: 100 * 16 + 8 }));
    await guest.until(() => guest.msgs.some((m) => m.type === 'editResult'));
    expect(guest.msgs.find((m) => m.type === 'editResult')).toMatchObject({ ok: false, error: 'sign in to build' });
    guest.ws.close();
  });

  it('carry water in buckets, a cubic metre each, and pour it out', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    await inventories.save(ann.id, 'default@single', { items: new Map([[Item.Bucket, 1], [Material.Water, B]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    let id = 200;
    const act = async (msg: object) => {
      const n = ++id;
      p.ws.send(JSON.stringify({ ...msg, id: n }));
      await p.until(() => p.msgs.some((m) => m.type === 'editResult' && m.id === n));
      await new Promise((r) => setTimeout(r, 30));
      return p.msgs.find((m) => m.type === 'editResult' && m.id === n);
    };
    const water = () => new Map(p.inventory()!.items).get(Material.Water) ?? 0;
    // Full: no more fits.
    expect(await act({ type: 'bucket', x: 50, y: 0, z: 50, fill: true })).toMatchObject({ ok: false, error: 'your buckets are full' });
    // Pour it on the ground (block y = 0 is the air above it): all of it goes.
    expect(await act({ type: 'bucket', x: 50, y: 0, z: 50, fill: false })).toMatchObject({ ok: true });
    expect(water()).toBe(0);
    expect(await act({ type: 'bucket', x: 60, y: 0, z: 60, fill: false })).toMatchObject({ ok: false, error: expect.stringMatching(/^your buckets are empty/) });
    // Scoop it back up straight away: still all there.
    expect(await act({ type: 'bucket', x: 50, y: 0, z: 50, fill: true })).toMatchObject({ ok: true });
    expect(water()).toBe(B);
    expect(await act({ type: 'bucket', x: 70, y: 0, z: 70, fill: true })).toMatchObject({ ok: false }); // no water there
    p.ws.close();
  });

  it('need a bucket for water, and cut leaves with a sword (only leaves)', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    await inventories.save(ann.id, 'default@single', { items: new Map([[Material.Leaves, 4 * B], [Item.WoodenSword, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    let id = 300;
    const act = async (msg: object) => {
      const n = ++id;
      p.ws.send(JSON.stringify({ ...msg, id: n }));
      await p.until(() => p.msgs.some((m) => m.type === 'editResult' && m.id === n));
      return p.msgs.find((m) => m.type === 'editResult' && m.id === n);
    };
    expect(await act({ type: 'bucket', x: 5, y: 0, z: 5, fill: true })).toMatchObject({ ok: false, error: expect.stringMatching(/^you need a bucket/) });
    // Leaves on the ground, then the sword through them.
    expect(await p.edit({ op: 'place', x: 80 * 16, y: 0, z: 80 * 16, size: 16, material: Material.Leaves })).toMatchObject({ ok: true });
    expect(await act({ type: 'cut', sword: Item.WoodenSword, x: 80, y: 0, z: 80 })).toMatchObject({ ok: true });
    expect(await act({ type: 'cut', sword: Item.WoodenSword, x: 80, y: 0, z: 80 })).toMatchObject({ ok: false, error: 'no leaves there' });
    expect(await act({ type: 'cut', sword: Item.WoodenSword, x: 80, y: -1, z: 80 })).toMatchObject({ ok: false, error: 'no leaves there' }); // the ground stays
    expect(await act({ type: 'cut', sword: Item.StoneSword, x: 80, y: 0, z: 80 })).toMatchObject({ ok: false, error: 'you have no stone sword' });
    p.ws.close();
  });

  it('fight: players see mobs, hit them, get hurt, and come back at the spawn when they die', async () => {
    let manager: MobManager | null = null;
    // Mobs only where the test puts them (none appear by themselves: nobody's within reach of a spawn).
    const { url, cookie } = await setup('survival', (w) => (manager = new MobManager(w, () => 0.999)));
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    const eye = 1.62 * 16;
    const at = { x: 8000 * 16, z: 8000 * 16 };
    p.ws.send(JSON.stringify({ type: 'pose', x: at.x, y: eye, z: at.z, yaw: 0 }));
    await p.until(() => manager !== null);
    // A pig right in front: in the view, then hit (a bare hand: 1).
    const pig = manager!.add('pig', at.x, 0, at.z - 2 * 16, Date.now());
    const seen = () => p.msgs.filter((m): m is Extract<ServerMessage, { type: 'entities' }> => m.type === 'entities').at(-1)?.entities ?? [];
    await p.until(() => seen().some((e) => e.id === pig.id));
    expect(seen().find((e) => e.id === pig.id)).toMatchObject({ kind: 'pig', health: 10, max: 10 });
    p.ws.send(JSON.stringify({ type: 'attack', target: pig.id, weapon: null }));
    await p.until(() => (seen().find((e) => e.id === pig.id)?.health ?? 10) < 10);
    expect(seen().find((e) => e.id === pig.id)!.health).toBe(9);
    // Too far: no hit.
    const far = manager!.add('pig', at.x + 30 * 16, 0, at.z, Date.now());
    await new Promise((r) => setTimeout(r, 450)); // past the swing cooldown
    p.ws.send(JSON.stringify({ type: 'attack', target: far.id, weapon: null }));
    await new Promise((r) => setTimeout(r, 250));
    expect(manager!.get(far.id)!.health).toBe(10);
    // A zombie at your side, and health it can take: hurt, then dead and back at the spawn, whole.
    const healths = () => p.msgs.filter((m): m is Extract<ServerMessage, { type: 'health' }> => m.type === 'health').map((m) => m.health);
    expect(healths()[0]).toBe(20);
    const z = manager!.add('zombie', at.x + 16, 0, at.z, Date.now());
    z.nextAttack = 0;
    await p.until(() => healths().some((h) => h < 20), 4000);
    expect(healths().find((h) => h < 20)).toBe(17);
    // Seven hits kill (20 / 3): once a second each; the respawn comes before the full health.
    await p.until(() => p.msgs.some((m) => m.type === 'respawn'), 12_000);
    expect(healths().at(-1)).toBe(20);
    p.ws.close();
  }, 30_000);

  it("don't exist for players who aren't signed in", async () => {
    const { url } = await setup('survival');
    const p = await player(url);
    await p.until(() => p.msgs.some((m) => m.type === 'welcome'));
    await new Promise((r) => setTimeout(r, 50));
    expect(p.inventory()).toBeUndefined();
    expect(await p.edit({ op: 'remove', x: 1000, y: -1, z: 1000 })).toMatchObject({ ok: false, error: 'sign in to build' });
    p.ws.close();
  });
});
