import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Item, Material, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
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

describe('saplings over the connection (survival)', () => {
  it('are planted from the inventory (used up) on grass, everyone told; refused without one, or off grass', async () => {
    const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
    const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
    const inv = starterInventory();
    inv.items.set(Item.OakSapling, 1);
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
    const saplings = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'saplings' }> => m.type === 'saplings').at(-1)?.saplings;
    await until(() => msgs.some((m) => m.type === 'inventory') && saplings() !== undefined);
    expect(saplings()).toEqual([]);
    let id = 100;
    const ask = async (m: Record<string, unknown>) => {
      const asked = ++id;
      ws.send(JSON.stringify({ ...m, id: asked }));
      await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
      return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
    };
    const count = (item: number) => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([i]) => i === item)?.[1] ?? 0;
    const x = 1000 * M + 8, y = -8, z = 1000 * M + 8;
    ws.send(JSON.stringify({ type: 'pose', x: x + 2 * M, y: 2 * M, z, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await ask({ type: 'plant', x, y: y - 3 * M, z, item: Item.OakSapling })).toMatchObject({ ok: false, error: expect.stringMatching(/grass or dirt/) });
    expect(await ask({ type: 'plant', x, y, z, item: Item.OakSapling })).toMatchObject({ ok: true });
    await until(() => count(Item.OakSapling) === 0 && saplings()!.length === 1);
    expect(saplings()![0]!.slice(0, 4)).toEqual([1000, 0, 1000, Item.OakSapling]);
    expect(await ask({ type: 'plant', x: x + M, y, z, item: Item.OakSapling })).toMatchObject({ ok: false, error: expect.stringMatching(/no sapling/) });
    // A block put in it: gone, everyone told.
    const put = await ask({ type: 'edit', edit: { op: 'place', x: x - 8, y: 0, z: z - 8, size: M, material: Material.Stone } });
    expect(put.ok ? '' : put.error).toBe('');
    await until(() => saplings()!.length === 0);
    ws.close();
  });
});
