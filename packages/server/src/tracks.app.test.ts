import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Item, PROTOCOL_VERSION, RAIL_M, UNITS_PER_METER, defaultFlatGen, type GameMode, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single', M = UNITS_PER_METER;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function setup(mode: GameMode) {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const account = async (name: string, rails: number, role: 'builder' | 'visitor' = 'builder') => {
    const a = await accounts.signIn({ sub: name, email: `${name}@x.com`, name }, role);
    const inv = starterInventory();
    if (rails) inv.items.set(Item.Rail, rails);
    await inventories.save(a.id, KEY, inv);
    return `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}`;
  };
  return { url, world, account };
}

async function player(url: string, cookie: string) {
  const ws = new WebSocket(url, { headers: { cookie } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  let id = 0;
  const route = [{ x: 1000 * M, z: 1000 * M }, { x: 1100 * M, z: 1000 * M }];
  const track = async (lay: boolean) => {
    const asked = ++id;
    ws.send(JSON.stringify({ type: 'track', id: asked, points: route, lay }));
    await until(() => msgs.some((m) => m.type === 'trackPlan' && m.id === asked));
    return msgs.find((m): m is Extract<ServerMessage, { type: 'trackPlan' }> => m.type === 'trackPlan' && m.id === asked)!;
  };
  const tracks = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'tracks' }> => m.type === 'tracks').at(-1)?.tracks ?? [];
  const rails = () => (msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([id]) => id === Item.Rail)?.[1] ?? 0);
  return { ws, msgs, until, track, tracks, rails };
}

describe('track over the connection', () => {
  it("plans a route (what it'd take, its line), and lays it in creative: everyone told", async () => {
    const { url, account } = await setup('creative');
    const a = await player(url, await account('ann', 0)), b = await player(url, await account('bob', 0));
    expect(a.tracks()).toEqual([]);
    const plan = await a.track(false);
    expect(plan.plan).toMatchObject({ rails: 0 });
    expect(plan.plan!.length).toBeCloseTo(100, 0);
    expect(plan.plan!.line.length).toBeGreaterThan(10);
    expect(plan.plan!.profile.length).toBeGreaterThan(10);
    const laid = await a.track(true);
    expect(laid).toMatchObject({ laid: true });
    await b.until(() => b.tracks().length === 1);
    a.ws.close();
    b.ws.close();
  });

  it('in survival: rails, as many as it takes (refused without), used up; not for visitors', async () => {
    const { url, account } = await setup('survival');
    const need = Math.ceil(100 / RAIL_M);
    const poor = await player(url, await account('poor', need - 1));
    const no = await poor.track(true);
    expect(no.error).toMatch(new RegExp(`${need} rails needed`));
    expect(poor.tracks()).toEqual([]);
    const rich = await player(url, await account('rich', need + 3));
    expect(await rich.track(true)).toMatchObject({ laid: true });
    await rich.until(() => rich.rails() === 3);
    const visitor = await player(url, await account('vic', 999, 'visitor'));
    expect((await visitor.track(true)).error).toMatch(/visitor/);
    for (const p of [poor, rich, visitor]) p.ws.close();
  });
});
