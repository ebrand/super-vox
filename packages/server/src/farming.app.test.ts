import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, CROP_STAGE_MS, FLAT_WORLD_16KM, FlatGenerator, Item, Material, PROTOCOL_VERSION, RIPE, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single', M = 16;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe('farming over the connection (survival)', () => {
  it('tills with a shovel only, sows with wheat (used up), harvests ripe wheat (two back); not from afar; everyone told', async () => {
    const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
    const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
    const inv = starterInventory();
    inv.items.set(Item.WoodenShovel, 1);
    inv.items.set(Item.Wheat, 1);
    inv.items.set(Material.Stone, BLOCK_VOLUME);
    await inventories.save(a.id, KEY, inv);
    const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}` } });
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
    };
    await until(() => msgs.some((m) => m.type === 'inventory') && msgs.some((m) => m.type === 'crops'));
    let id = 100;
    const ask = async (m: Record<string, unknown>) => {
      const asked = ++id;
      ws.send(JSON.stringify({ ...m, id: asked }));
      await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
      return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
    };
    const count = (item: number) => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([i]) => i === item)?.[1] ?? 0;
    const crops = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'crops' }> => m.type === 'crops').at(-1)!.crops;
    const stand = async (x: number, z: number) => {
      ws.send(JSON.stringify({ type: 'pose', x, y: 2 * M, z, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 50));
    };
    // (The ground's top block, under y 0.)
    const x = 1000 * M + 8, y = -8, z = 1000 * M + 8;
    await stand(x + 100 * M, z);
    expect(await ask({ type: 'till', x, y, z, tool: Item.WoodenShovel })).toMatchObject({ ok: false, error: expect.stringMatching(/too far/) });
    await stand(x + 2 * M, z);
    expect(await ask({ type: 'till', x, y, z, tool: Item.IronShovel })).toMatchObject({ ok: false, error: expect.stringMatching(/shovel/) });
    expect(await ask({ type: 'sow', x, y, z })).toMatchObject({ ok: false, error: expect.stringMatching(/farmland/) });
    expect(await ask({ type: 'till', x, y, z, tool: Item.WoodenShovel })).toMatchObject({ ok: true });
    expect(world.materialAtUnit(x, y, z)).toBe(Material.Farmland);
    expect(await ask({ type: 'sow', x, y, z })).toMatchObject({ ok: true });
    await until(() => count(Item.Wheat) === 0 && crops().length === 1);
    // Another block tilled: no wheat left to sow.
    expect(await ask({ type: 'till', x: x + M, y, z, tool: Item.WoodenShovel })).toMatchObject({ ok: true });
    expect(await ask({ type: 'sow', x: x + M, y, z })).toMatchObject({ ok: false, error: expect.stringMatching(/no wheat/) });
    expect(await ask({ type: 'harvest', x, y, z })).toMatchObject({ ok: false, error: expect.stringMatching(/not ripe yet/) });
    // (One sown long ago, beside it: ripe.)
    expect(world.sow(x + M, y, z, Date.now() - CROP_STAGE_MS * RIPE)).toBe(true);
    expect(await ask({ type: 'harvest', x: x + M, y, z })).toMatchObject({ ok: true, note: 'two bundles of wheat' });
    await until(() => count(Item.Wheat) === 2 && crops().length === 1);
    // A block put on the sown one (not harvested): everyone's told it's gone.
    const sawCrops = msgs.filter((m) => m.type === 'crops').length;
    const put = await ask({ type: 'edit', edit: { op: 'place', x: x - 8, y: 0, z: z - 8, size: M, material: Material.Stone } });
    expect(put.ok ? '' : put.error).toBe('');
    await until(() => msgs.filter((m) => m.type === 'crops').length > sawCrops && crops().length === 0);
    ws.close();
  });
});
