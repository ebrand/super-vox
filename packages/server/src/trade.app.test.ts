import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FlatGenerator, Item, Material, PROTOCOL_VERSION, defaultFlatGen, type GameMode, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single';
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function setup(mode: GameMode, items: [number, number][]) {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
  const inv = starterInventory();
  for (const [id, n] of items) inv.items.set(id, n);
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
  await until(() => msgs.some((m) => m.type === 'inventory') && msgs.some((m) => m.type === 'posts'));
  const posts = msgs.find((m): m is Extract<ServerMessage, { type: 'posts' }> => m.type === 'posts')!.posts;
  let id = 100;
  const ask = async (m: Record<string, unknown>) => {
    const asked = ++id;
    ws.send(JSON.stringify({ ...m, id: asked }));
    await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
    return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
  };
  const count = (item: number) => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([i]) => i === item)?.[1] ?? 0;
  const stand = async (x: number, z: number) => {
    ws.send(JSON.stringify({ type: 'pose', x, y: 200, z, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
  };
  return { ws, posts, ask, count, until, stand };
}

describe('trading over the connection', () => {
  it('sells raw goods for coins and buys finished ones with them (change given), at the trader; not from afar', async () => {
    const { ws, posts, ask, count, until, stand } = await setup('survival', [[Material.Coal, BLOCK_VOLUME], [Item.CopperCoin, 3]]);
    expect(posts.length).toBeGreaterThan(5);
    const post = posts[0]!, coal = post.buys.find((o) => o.item === Material.Coal)!, torch = post.sells.find((o) => o.item === Item.Torch)!;
    await stand(post.x + 5000 * 16, post.z);
    expect(await ask({ type: 'trade', post: post.id, item: Material.Coal, lots: 1, act: 'sell' })).toMatchObject({ ok: false, error: expect.stringMatching(/too far/) });
    await stand(post.x + 2 * 16, post.z);
    // A block of coal: eight pieces, all sold.
    expect(await ask({ type: 'trade', post: post.id, item: Material.Coal, lots: 99, act: 'sell' })).toMatchObject({ ok: true });
    const earned = 8 * coal.price;
    await until(() => count(Material.Coal) === 0 && count(Item.CopperCoin) + 10 * count(Item.GoldCoin) === 3 + earned);
    expect(await ask({ type: 'trade', post: post.id, item: Item.IronIngot, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't sell/) });
    expect(await ask({ type: 'trade', post: post.id, item: Item.Torch, lots: 2, act: 'buy' })).toMatchObject({ ok: true });
    await until(() => count(Item.Torch) >= 2 * torch.lot && count(Item.CopperCoin) + 10 * count(Item.GoldCoin) === 3 + earned - 2 * torch.price);
    expect(await ask({ type: 'trade', post: post.id, item: Item.Engine, lots: 9, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/not enough coins|doesn't sell/) });
    ws.close();
  });

  it('is for survival', async () => {
    const { ws, posts, ask, stand } = await setup('creative', []);
    await stand(posts[0]!.x, posts[0]!.z);
    expect(await ask({ type: 'trade', post: posts[0]!.id, item: Item.Torch, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/survival/) });
    ws.close();
  });
});
