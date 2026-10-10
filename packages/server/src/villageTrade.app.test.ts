import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FlatGenerator, Item, Material, PROTOCOL_VERSION, VILLAGER_ENTITY, defaultFlatGen, villagePlot, type ServerMessage } from '@super-vox/shared';
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

describe('trading with villagers over the connection (survival)', () => {
  it('buys from and sells to their village, out of its stock and coins; near them only', async () => {
    const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    // A village (as kept) at (1000, 1000) m: two villagers, wheat in store, a little coin.
    const cottages = [{ ...villagePlot(1000, 1000, 0).cottage, floor: 0, stage: 3, work: 0 }];
    const fields = [{ ...villagePlot(1000, 1000, 0).field, tops: Array(30).fill(0), sown: Array(30).fill(Date.now()), tilled: true }];
    const raw = {
      villagers: [1, 2].map((id) => ({ id, name: `v${id}`, look: '', x: (1000 + id) * M, y: 0, z: 1000 * M, yaw: 0, home: 100 })),
      villages: [{ id: 100, name: 'Ashby', x: 1000.5 * M, y: 0, z: 1000.5 * M, founded: 0, cottages, fields, wheat: 20, coins: 6, stock: { wood: 0, planks: 0, cobble: 0 } }],
      cells: [], next: 200,
    };
    world.loadVillages = () => raw;
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
    const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
    const inv = starterInventory();
    inv.items.set(Item.CopperCoin, 10);
    inv.items.set(Material.Wood, 10 * BLOCK_VOLUME);
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
    await until(() => msgs.some((m) => m.type === 'inventory'));
    let id = 100;
    const ask = async (m: Record<string, unknown>) => {
      const asked = ++id;
      ws.send(JSON.stringify({ ...m, id: asked }));
      await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
      return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
    };
    const count = (item: number) => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([i]) => i === item)?.[1] ?? 0;
    const village = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'villages' }> => m.type === 'villages').at(-1)?.villages.find((v) => v.id === 100);
    const stand = async (x: number, z: number) => {
      ws.send(JSON.stringify({ type: 'pose', x, y: 32, z, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 50));
    };
    const villager = VILLAGER_ENTITY + 1;
    await stand(1200 * M, 1000 * M);
    expect(await ask({ type: 'trade', post: 0, villager, item: Item.Wheat, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/too far from v1/) });
    await stand(1002 * M, 1000 * M);
    expect(await ask({ type: 'trade', post: 0, villager: VILLAGER_ENTITY + 77, item: Item.Wheat, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/no village/) });
    // Wheat over the 12 they keep: 8, two lots of four (two copper a lot, as they've little).
    expect(await ask({ type: 'trade', post: 0, villager, item: Item.Wheat, lots: 5, act: 'buy' })).toMatchObject({ ok: true });
    await until(() => count(Item.Wheat) === 8 && count(Item.CopperCoin) === 6);
    await until(() => village()?.wheat === 12 && village()?.coins === 10);
    expect(await ask({ type: 'trade', post: 0, villager, item: Item.Bread, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/no bread to spare/) });
    // Wood: they're short (two copper a block), and have 10 coins: five blocks of the ten.
    expect(await ask({ type: 'trade', post: 0, villager, item: Material.Wood, lots: 99, act: 'sell' })).toMatchObject({ ok: true });
    // (Paid ten copper's worth: a gold coin.)
    await until(() => count(Material.Wood) === 5 * BLOCK_VOLUME && count(Item.CopperCoin) + 10 * count(Item.GoldCoin) === 16);
    // (Five blocks in its stock, and a little it's gathered meanwhile.)
    await until(() => village()?.coins === 0 && Math.floor(village()?.stock?.wood ?? 0) === 5);
    expect(await ask({ type: 'trade', post: 0, villager, item: Material.Wood, lots: 1, act: 'sell' })).toMatchObject({ ok: false, error: expect.stringMatching(/can't take more/) });
    expect(await ask({ type: 'trade', post: 0, villager, item: Item.Torch, lots: 1, act: 'sell' })).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't buy/) });
    ws.close();
  });
});
