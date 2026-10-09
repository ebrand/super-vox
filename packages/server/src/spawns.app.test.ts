import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, PROTOCOL_VERSION, UNITS_PER_METER, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A flat survival world ("default") with sign-in: Boss an admin (by email), Ann invited, Bob playing. */
async function setup() {
  const accounts = new MemoryAccountStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories: new MemoryInventoryStore() });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const cookieFor = async (sub: string, email: string, name: string) =>
    `${SESSION_COOKIE}=${sessionToken((await accounts.signIn({ sub, email, name }, email === 'boss@x.com' ? 'admin' : 'builder')).id, Date.now() + 1e6, SECRET)}`;
  const boss = await cookieFor('g-boss', 'boss@x.com', 'Boss');
  const call = (method: 'GET' | 'PUT' | 'DELETE', path: string, cookie: string, payload?: object) =>
    app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { url, world, accounts, boss, call, cookieFor };
}

/** A signed-in connection: its welcome, and dying (as the client reports a fall) to see where it comes back. */
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
  const respawns = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'respawn' }> => m.type === 'respawn');
  return {
    welcome: msgs.find((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome')!,
    async die() {
      const n = respawns().length;
      ws.send(JSON.stringify({ type: 'fell', speed: 50 }));
      await until(() => respawns().length > n);
      return respawns().at(-1)!;
    },
    async close() {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

describe('personal spawn points', () => {
  it('are set by admins only, for an email and a world that is', async () => {
    const { boss, call, cookieFor } = await setup();
    const ann = await cookieFor('g-ann', 'ann@x.com', 'Ann');
    expect((await call('PUT', '/api/spawns', ann, { email: 'ann@x.com', world: 'default', x: 1, z: 2 })).statusCode).toBe(403);
    expect((await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'nowhere', x: 1, z: 2 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/spawns', boss, { email: 'not an email', world: 'default', x: 1, z: 2 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: 'a', z: 2 })).statusCode).toBe(400);
    // (Email any case: kept lower-cased.)
    expect((await call('PUT', '/api/spawns', boss, { email: 'Dan@X.com', world: 'default', x: 120, z: 340 })).json()).toMatchObject({ spawn: { email: 'dan@x.com', world: 'default', x: 120, z: 340 } });
    expect(((await call('GET', '/api/players', boss)).json() as { spawns: unknown[] }).spawns).toMatchObject([{ email: 'dan@x.com', world: 'default', x: 120, z: 340 }]);
    expect((await call('DELETE', '/api/spawns/default/dan%40x.com', ann)).statusCode).toBe(403);
    expect((await call('DELETE', '/api/spawns/default/dan%40x.com', boss)).statusCode).toBe(204);
    expect((await call('DELETE', '/api/spawns/default/dan%40x.com', boss)).statusCode).toBe(404);
  });

  it("are where they first come in and come back to (no bed); moved, at once; taken away, the world's again", async () => {
    const { url, world, boss, call, cookieFor } = await setup();
    // Set for Ann before she's ever been (as for an invitation).
    await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: 120, z: 340 });
    const home = world.spawnAt(120 * UNITS_PER_METER, 340 * UNITS_PER_METER);
    expect(home).toMatchObject({ x: 120 * UNITS_PER_METER, z: 340 * UNITS_PER_METER });
    const ann = await player(url, await cookieFor('g-ann', 'ann@x.com', 'Ann'));
    expect(ann.welcome.spawn).toEqual(home);
    expect(await ann.die()).toMatchObject({ x: home.x, y: home.y, z: home.z });
    // Moved while she's here: her next death.
    await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: -5, z: 50 });
    // (Off the world's west edge on a flat world: kept inside it.)
    expect(await ann.die()).toMatchObject({ x: 0, z: 50 * UNITS_PER_METER });
    // Taken away: the world's spawn point.
    await call('DELETE', '/api/spawns/default/ann%40x.com', boss);
    expect(await ann.die()).toMatchObject({ x: world.spawn.x, z: world.spawn.z });
    await ann.close();
    // Bob, who has none: the world's, all along.
    const bob = await player(url, await cookieFor('g-bob', 'bob@x.com', 'Bob'));
    expect(bob.welcome.spawn).toEqual(world.spawn);
    expect(await bob.die()).toMatchObject({ x: world.spawn.x, z: world.spawn.z });
    await bob.close();
  });
});
