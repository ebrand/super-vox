import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FlatGenerator, Item, Material, PROTOCOL_VERSION, UNITS_PER_METER, defaultFlatGen, type GameMode, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single', M = UNITS_PER_METER, EAST = -Math.PI / 2;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A world with 200 m of track east from (1000, 1000) m, and a player at its middle, with what they're given. */
async function setup(mode: GameMode, items: [number, number][]) {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const laid = world.layTrack({ from: { x: 1000 * M, z: 1000 * M }, heading: null, to: { x: 1200 * M, z: 1000 * M }, curve: false, speed: 60 });
  if (typeof laid === 'string') throw new Error(laid);
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
  const until = async (f: () => boolean, ms = 4000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  ws.send(JSON.stringify({ type: 'pose', x: 1100 * M, y: 2 * M, z: 1002 * M, yaw: 0 }));
  let id = 100;
  const ask = async (m: Record<string, unknown>) => {
    const asked = ++id;
    ws.send(JSON.stringify({ ...m, id: asked }));
    await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
    return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
  };
  const trains = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'trains' }> => m.type === 'trains').at(-1)?.trains ?? [];
  const count = (item: number) => msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items.find(([i]) => i === item)?.[1] ?? 0;
  return { ws, until, ask, trains, count };
}

describe('trains over the connection', () => {
  it('puts an engine on the track, gets in and drives it: everyone told where it is as it goes; out, it stops', async () => {
    const { ws, until, ask, trains } = await setup('creative', []);
    expect(trains()).toEqual([]);
    expect(await ask({ type: 'carPlace', item: Item.Engine, x: 1100 * M, y: 0, z: 1000 * M, heading: EAST })).toMatchObject({ ok: true });
    await until(() => trains().length === 1);
    const car = trains()[0]!.cars[0]!.id;
    expect(await ask({ type: 'carUse', car, act: 'fuel' })).toMatchObject({ ok: false, error: expect.stringMatching(/creative/) });
    expect(await ask({ type: 'carUse', car, act: 'board' })).toMatchObject({ ok: true });
    ws.send(JSON.stringify({ type: 'drive', throttle: 1, brake: false }));
    await until(() => (trains()[0]?.v ?? 0) > 2);
    const s0 = trains()[0]!.cars[0]!.pos.s;
    await until(() => trains()[0]!.cars[0]!.pos.s > s0 + 2 * M);
    ws.send(JSON.stringify({ type: 'drive', throttle: 0, brake: false, leave: true }));
    await until(() => trains()[0]!.driver === null);
    await until(() => trains()[0]!.v === 0, 8000);
    // Taken off again.
    expect(await ask({ type: 'carTake', car })).toMatchObject({ ok: true });
    await until(() => trains().length === 0);
    ws.close();
  });

  it('in survival: a car item used up putting it on, given back taking it off; coal put in an engine, by the lump', async () => {
    const { ws, until, ask, trains, count } = await setup('survival', [[Item.Engine, 1], [Material.Coal, BLOCK_VOLUME]]);
    expect(await ask({ type: 'carPlace', item: Item.FlatbedCar, x: 1100 * M, y: 0, z: 1000 * M, heading: EAST })).toMatchObject({ ok: false, error: expect.stringMatching(/no flatbed car/) });
    expect(await ask({ type: 'carPlace', item: Item.Engine, x: 1100 * M, y: 0, z: 1000 * M, heading: EAST })).toMatchObject({ ok: true });
    await until(() => count(Item.Engine) === 0 && trains().length === 1);
    const car = trains()[0]!.cars[0]!.id;
    expect(await ask({ type: 'carUse', car, act: 'fuel' })).toMatchObject({ ok: true, note: '8 lumps of coal in' });
    await until(() => count(Material.Coal) === 0);
    await until(() => (trains()[0]!.cars[0]!.fuel ?? 0) > 0);
    expect(await ask({ type: 'carTake', car })).toMatchObject({ ok: true });
    await until(() => count(Item.Engine) === 1);
    ws.close();
  });
});
