import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, PROTOCOL_VERSION, UNITS_PER_METER, avatarText, defaultAvatar, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const LOOK = { skin: '#c68e6a', shirt: '#2255aa', trousers: '#333333', shoes: '#111111' };

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A flat world ("default") with sign-in: Boss an admin, Ann and Bob players. */
async function setup() {
  const accounts = new MemoryAccountStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories: new MemoryInventoryStore() });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const cookieFor = async (sub: string, email: string, name: string) =>
    `${SESSION_COOKIE}=${sessionToken((await accounts.signIn({ sub, email, name }, email === 'boss@x.com' ? 'admin' : 'builder')).id, Date.now() + 1e6, SECRET)}`;
  const call = (method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', path: string, cookie: string | null, payload?: object) =>
    app.inject({ method, url: path, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
  return { url, world, call, boss: await cookieFor('g-boss', 'boss@x.com', 'Boss'), ann: await cookieFor('g-ann', 'ann@x.com', 'Ann Smith'), bob: await cookieFor('g-bob', 'bob@x.com', 'Bob') };
}

/** A signed-in connection, collecting what it's sent. */
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
  return { ws, msgs, until, welcome: msgs.find((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome')! };
}

describe('your account', () => {
  it('is yours only, signed in', async () => {
    const { call, ann } = await setup();
    expect((await call('GET', '/api/account', null)).statusCode).toBe(401);
    expect((await call('PATCH', '/api/account', null, { displayName: 'Hacker' })).statusCode).toBe(401);
    expect((await call('GET', '/api/account', ann)).json()).toMatchObject({ email: 'ann@x.com', googleName: 'Ann Smith', displayName: null, name: 'Ann Smith', avatar: defaultAvatar('Ann Smith'), chosenAvatar: false, spawns: [] });
  });

  it('a name to go by: its own (any case: no one else, chosen or Google), as the rules say; cleared, the Google one again', async () => {
    const { call, ann, bob } = await setup();
    expect((await call('PATCH', '/api/account', ann, { displayName: '  Annie   B ' })).json()).toMatchObject({ displayName: 'Annie B', name: 'Annie B' });
    expect((await call('GET', '/api/auth/me', ann)).json()).toMatchObject({ name: 'Annie B' });
    for (const bad of ['A', 'x'.repeat(25), ' -lead', 'semi;colon', 42]) expect((await call('PATCH', '/api/account', bob, { displayName: bad })).statusCode, String(bad)).toBe(400);
    expect((await call('PATCH', '/api/account', bob, { displayName: 'annie b' })).statusCode).toBe(409);
    // (Someone's Google name, not chosen: taken too.)
    expect((await call('PATCH', '/api/account', bob, { displayName: 'BOSS' })).statusCode).toBe(409);
    // Ann keeping her own name, another case: fine.
    expect((await call('PATCH', '/api/account', ann, { displayName: 'ANNIE B' })).json()).toMatchObject({ name: 'ANNIE B' });
    expect((await call('PATCH', '/api/account', ann, { displayName: null })).json()).toMatchObject({ displayName: null, name: 'Ann Smith' });
    expect((await call('PATCH', '/api/account', bob, { displayName: 'Annie B' })).statusCode).toBe(200);
  });

  it('a look: a colour for each part, or back to the one from your name', async () => {
    const { call, ann } = await setup();
    expect((await call('PATCH', '/api/account', ann, { avatar: { ...LOOK, shoes: 'red' } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/account', ann, { avatar: { skin: '#ffffff' } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/account', ann, { avatar: { ...LOOK, shirt: '#2255AA' } })).json()).toMatchObject({ avatar: LOOK, chosenAvatar: true });
    expect((await call('PATCH', '/api/account', ann, { avatar: null })).json()).toMatchObject({ avatar: defaultAvatar('Ann Smith'), chosenAvatar: false });
  });

  it('spawn points: set and cleared where you like, unless an admin has locked one', async () => {
    const { call, ann, boss } = await setup();
    expect((await call('PUT', '/api/account/spawns', ann, { world: 'nowhere', x: 1, z: 2 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/account/spawns', ann, { world: 'default', x: 100, z: 200 })).json()).toMatchObject({ spawns: [{ world: 'default', x: 100, z: 200, locked: false }] });
    expect((await call('DELETE', '/api/account/spawns/default', ann)).json()).toMatchObject({ spawns: [] });
    expect((await call('DELETE', '/api/account/spawns/default', ann)).statusCode).toBe(404);
    // Locked by an admin: hers, but not hers to change.
    expect((await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: 5, z: 6, locked: 'yes' })).statusCode).toBe(400);
    await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: 5, z: 6, locked: true });
    expect((await call('GET', '/api/account', ann)).json()).toMatchObject({ spawns: [{ world: 'default', x: 5, z: 6, locked: true }] });
    expect((await call('PUT', '/api/account/spawns', ann, { world: 'default', x: 100, z: 200 })).statusCode).toBe(403);
    expect((await call('DELETE', '/api/account/spawns/default', ann)).statusCode).toBe(403);
    // Unlocked: hers again.
    await call('PUT', '/api/spawns', boss, { email: 'ann@x.com', world: 'default', x: 5, z: 6, locked: false });
    expect((await call('PUT', '/api/account/spawns', ann, { world: 'default', x: 7, z: 8 })).statusCode).toBe(200);
  });

  it('shows at once to anyone playing: your name and look over you, where you come back to', async () => {
    const { url, world, call, ann, bob } = await setup();
    const a = await player(url, ann), b = await player(url, bob);
    expect(a.welcome.player).toMatchObject({ name: 'Ann Smith', look: avatarText(defaultAvatar('Ann Smith')) });
    // (Ann somewhere, Bob by her: players are sent those near them.)
    a.ws.send(JSON.stringify({ type: 'pose', x: 1000, y: 200, z: 1000, yaw: 0 }));
    b.ws.send(JSON.stringify({ type: 'pose', x: 1100, y: 200, z: 1000, yaw: 0 }));
    const annSeen = () => b.msgs.flatMap((m) => (m.type === 'entities' ? m.entities.filter((e) => e.kind === 'player') : [])).at(-1);
    await b.until(() => !!annSeen());
    expect(annSeen()).toMatchObject({ name: 'Ann Smith', look: avatarText(defaultAvatar('Ann Smith')) });
    await call('PATCH', '/api/account', ann, { displayName: 'Annie', avatar: LOOK });
    await b.until(() => annSeen()?.name === 'Annie');
    expect(annSeen()!.look).toBe(avatarText(LOOK));
    // Her own spawn point, set while she plays: she comes back there.
    await call('PUT', '/api/account/spawns', ann, { world: 'default', x: 300, z: 400 });
    const n = a.msgs.filter((m) => m.type === 'respawn').length;
    a.ws.send(JSON.stringify({ type: 'fell', speed: 50 }));
    await a.until(() => a.msgs.filter((m) => m.type === 'respawn').length > n);
    expect(a.msgs.filter((m) => m.type === 'respawn').at(-1)).toMatchObject({ x: 300 * UNITS_PER_METER, z: 400 * UNITS_PER_METER, y: world.spawnAt(300 * UNITS_PER_METER, 400 * UNITS_PER_METER).y });
    a.ws.close();
    b.ws.close();
  });
});
