import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Item, PROTOCOL_VERSION, VILLAGER_ENTITY, VILLAGER_HEALTH, defaultFlatGen, villagePlot, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single', M = 16, EYE = 1.6 * M;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A survival world (flat, ground at 0) with what's kept as given, and a player with an iron sword, at (1000, 1000) m. */
async function setup(kept: { villages?: unknown; outlaws?: unknown }) {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  world.loadVillages = () => kept.villages ?? null;
  world.loadOutlaws = () => kept.outlaws ?? null;
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
  const inv = starterInventory();
  inv.items.set(Item.IronSword, 1);
  await inventories.save(a.id, KEY, inv);
  const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}` } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 6000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  ws.send(JSON.stringify({ type: 'pose', x: 1000 * M, y: EYE, z: 1000 * M, yaw: 0 }));
  const entities = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'entities' }> => m.type === 'entities').at(-1)?.entities ?? [];
  let id = 100;
  const ask = async (m: Record<string, unknown>) => {
    const asked = ++id;
    ws.send(JSON.stringify({ ...m, id: asked }));
    await until(() => msgs.some((r) => r.type === 'editResult' && r.id === asked));
    return msgs.find((r): r is Extract<ServerMessage, { type: 'editResult' }> => r.type === 'editResult' && r.id === asked)!;
  };
  const health = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'health' }> => m.type === 'health').at(-1)?.health;
  return { ws, msgs, until, entities, ask, health };
}

const outlaw = (id: number, x: number, archer: boolean) => ({ id, name: `o${id}`, look: '', x: x * M, y: 0, z: 1000 * M, health: 20, camp: null, archer });

describe('outlaws and villagers in a fight, over the connection (survival)', () => {
  it('an outlaw near: a creature, after the player; killed with a sword, it drops its coins; one with a bow shoots', async () => {
    const t = await setup({ outlaws: { outlaws: [outlaw(1, 1004, false), outlaw(2, 1014, true)], camps: [], cells: [], next: 10 } });
    await t.until(() => t.entities().filter((e) => e.kind === 'outlaw').length === 2);
    const sword = t.entities().find((e) => e.kind === 'outlaw' && e.name === 'o1')!;
    expect(sword).toMatchObject({ held: Item.IronSword, max: 20 });
    expect(t.entities().find((e) => e.name === 'o2')).toMatchObject({ held: Item.Bow });
    // The bow's arrows come, and hurt.
    await t.until(() => t.msgs.some((m) => m.type === 'arrow'));
    // Hit with the sword till it's down (it comes to us).
    for (let i = 0; i < 12 && t.entities().some((e) => e.id === sword.id); i++) {
      t.ws.send(JSON.stringify({ type: 'attack', target: sword.id, weapon: Item.IronSword }));
      await new Promise((r) => setTimeout(r, 450));
    }
    await t.until(() => !t.entities().some((e) => e.id === sword.id));
    await t.until(() => t.msgs.some((m) => m.type === 'drops' && m.drops.some((d) => d.item === Item.CopperCoin)));
    await t.until(() => (t.health() ?? 20) < 20);
    t.ws.close();
  }, 20_000);

  it('a villager hit: hurt, and their village won\'t trade with whoever did it', async () => {
    const cottages = [{ ...villagePlot(1000, 1000, 0).cottage, floor: 0, stage: 3, work: 0 }];
    const fields = [{ ...villagePlot(1000, 1000, 0).field, tops: Array(30).fill(0), sown: Array(30).fill(Date.now()), tilled: true }];
    const t = await setup({
      villages: {
        villagers: [{ id: 1, name: 'v1', look: '', x: 1002 * M, y: 0, z: 1000 * M, yaw: 0, home: 100 }],
        villages: [{ id: 100, name: 'Ashby', x: 1000.5 * M, y: 0, z: 1000.5 * M, founded: 0, cottages, fields, wheat: 20, coins: 6 }],
        cells: [], next: 200,
      },
    });
    const id = VILLAGER_ENTITY + 1;
    await t.until(() => t.entities().some((e) => e.id === id));
    expect(t.entities().find((e) => e.id === id)).toMatchObject({ kind: 'villager', health: VILLAGER_HEALTH });
    t.ws.send(JSON.stringify({ type: 'attack', target: id, weapon: Item.IronSword }));
    await t.until(() => t.entities().find((e) => e.id === id)?.health === VILLAGER_HEALTH - 6);
    expect(await t.ask({ type: 'trade', post: 0, villager: id, item: Item.Wheat, lots: 1, act: 'buy' })).toMatchObject({ ok: false, error: expect.stringMatching(/Ashby won't trade with you/) });
    t.ws.close();
  });
});
