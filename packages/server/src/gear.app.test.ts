import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { DURABILITY, FLAT_WORLD_16KM, FlatGenerator, HOTBAR_SLOTS, Item, Material, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { DesignLibrary } from './designs.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single', M = 16, EYE = 1.6 * M, B = 4096;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A survival world (flat, ground at 0; the built-in designs), outlaws as given, and a player with `items` at (1000, 1000) m. */
async function setup(items: [number, number][], outlaws: unknown = null) {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  world.loadOutlaws = () => outlaws;
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, designs: new DesignLibrary(null, true), miningTimeScale: 0.01 });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
  await inventories.save(a.id, KEY, { items: new Map(items), hotbar: Array(HOTBAR_SLOTS).fill(null) });
  const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}` } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 8000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  ws.send(JSON.stringify({ type: 'pose', x: 1000 * M, y: EYE, z: 1000 * M, yaw: 0 }));
  const inv = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)!;
  const healths = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'health' }> => m.type === 'health').map((m) => m.health);
  return { ws, msgs, until, inv, healths, world };
}

const sword = { id: 1, name: 'o1', look: '', x: 1001.2 * M, y: 0, z: 1000 * M, health: 20, camp: null, archer: false };

describe('armor and wear, in play (survival)', () => {
  for (const suit of [false, true]) {
    it(`an outlaw's sword hit does ${suit ? '40% (an iron suit on, worn by it)' : 'its whole damage, with no armor on'}`, async () => {
      const iron = [Item.IronHelmet, Item.IronChestplate, Item.IronLeggings, Item.IronBoots];
      const t = await setup(suit ? iron.map((i) => [i, 1] as [number, number]) : [], { outlaws: [sword], camps: [], cells: [], next: 10 });
      if (suit) {
        for (const item of iron) t.ws.send(JSON.stringify({ type: 'putOn', item }));
        await t.until(() => t.inv().worn?.every((w) => w !== null) ?? false);
      }
      await t.until(() => t.healths().some((h) => h < 20));
      const first = 20 - t.healths().find((h) => h < 20)!;
      expect(first).toBeCloseTo(suit ? 4 * 0.4 : 4, 9);
      if (suit) await t.until(() => t.inv().wornWear!.every((w) => w >= 1));
      t.ws.close();
    }, 20_000);
  }

  it('a pickaxe wears with each block it digs; mended at an anvil (crafted and placed), not away from one', async () => {
    const t = await setup([[Item.StonePickaxe, 1], [Material.Cobblestone, B], [Item.IronIngot, 6], [Item.CraftingTable, 1]]);
    const ask = async (m: Record<string, unknown>) => {
      const n = t.msgs.length;
      t.ws.send(JSON.stringify(m));
      await t.until(() => t.msgs.slice(n).some((r) => r.type === 'editResult' || r.type === 'inventory' || r.type === 'error'));
    };
    // Dig the ground beside us with it: worn by one.
    const x = 1001 * M + 4, y = -4, z = 1000 * M + 4;
    t.ws.send(JSON.stringify({ type: 'mine', x, y, z, tool: Item.StonePickaxe }));
    await new Promise((r) => setTimeout(r, 120));
    t.ws.send(JSON.stringify({ type: 'edit', id: 7, edit: { op: 'remove', x, y, z } }));
    await t.until(() => (t.inv().wear ?? []).some(([i, w]) => i === Item.StonePickaxe && w === 1));
    // No anvil near: refused.
    const errors = () => t.msgs.filter((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error').map((m) => m.message);
    await ask({ type: 'repair', item: Item.StonePickaxe });
    expect(errors().at(-1)).toMatch(/at an anvil/);
    // A table, an anvil made at it and put down beside us: mended (a block of cobblestone used).
    t.ws.send(JSON.stringify({ type: 'placeObject', id: 8, item: Item.CraftingTable, x: 1003, y: 0, z: 1000, facing: 'n' }));
    await t.until(() => t.msgs.some((m) => m.type === 'editResult' && m.id === 8));
    t.ws.send(JSON.stringify({ type: 'craft', recipe: 'anvil' }));
    await t.until(() => (t.inv().items.find(([i]) => i === Item.Anvil)?.[1] ?? 0) === 1);
    t.ws.send(JSON.stringify({ type: 'placeObject', id: 9, item: Item.Anvil, x: 1002, y: 0, z: 1001, facing: 'n' }));
    await t.until(() => t.msgs.some((m) => m.type === 'editResult' && m.id === 9));
    expect(t.msgs.find((m) => m.type === 'editResult' && m.id === 9)).toMatchObject({ ok: true });
    await ask({ type: 'repair', item: Item.StonePickaxe });
    await t.until(() => !(t.inv().wear ?? []).some(([i]) => i === Item.StonePickaxe));
    expect(t.inv().items.find(([i]) => i === Material.Cobblestone)).toBeUndefined();
    expect(DURABILITY[Item.StonePickaxe]).toBe(130);
    t.ws.close();
  }, 20_000);

  it('iron armor is made at a smithing table only (crafted, and placed)', async () => {
    const t = await setup([[Item.IronIngot, 10], [Material.Planks, 4 * B], [Item.CraftingTable, 1]]);
    const errors = () => t.msgs.filter((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error').map((m) => m.message);
    t.ws.send(JSON.stringify({ type: 'placeObject', id: 8, item: Item.CraftingTable, x: 1003, y: 0, z: 1000, facing: 'n' }));
    await t.until(() => t.msgs.some((m) => m.type === 'editResult' && m.id === 8));
    t.ws.send(JSON.stringify({ type: 'craft', recipe: 'iron-boots' }));
    await t.until(() => errors().some((e) => /smithing table/.test(e)));
    t.ws.send(JSON.stringify({ type: 'craft', recipe: 'smithing-table' }));
    await t.until(() => (t.inv().items.find(([i]) => i === Item.SmithingTable)?.[1] ?? 0) === 1);
    t.ws.send(JSON.stringify({ type: 'placeObject', id: 9, item: Item.SmithingTable, x: 1002, y: 0, z: 1001, facing: 'n' }));
    await t.until(() => t.msgs.some((m) => m.type === 'editResult' && m.id === 9));
    t.ws.send(JSON.stringify({ type: 'craft', recipe: 'iron-boots' }));
    await t.until(() => (t.inv().items.find(([i]) => i === Item.IronBoots)?.[1] ?? 0) === 1);
    t.ws.close();
  }, 20_000);
});

