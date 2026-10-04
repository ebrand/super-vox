import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FlatGenerator, HOTBAR_SLOTS, Item, Material, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const B = BLOCK_VOLUME;

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/**
 * A survival flat world (ground at y = 0), mining a tenth as long as usual (stone by hand: 0.9 s a
 * block; with a wooden pickaxe 0.15 s), and a player with a wooden pickaxe; a row of stone, coal
 * ore and iron ore blocks on the ground (x 100..105, z 100).
 */
async function setup() {
  const accounts = new MemoryAccountStore();
  const inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, miningTimeScale: 0.1 });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  await inventories.save(ann.id, 'default@single', { items: new Map([[Item.WoodenPickaxe, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
  const row = [Material.Stone, Material.Stone, Material.Stone, Material.CoalOre, Material.IronOre, Material.Stone];
  row.forEach((material, i) => world.applyEdit({ op: 'place', x: (100 + i) * 16, y: 0, z: 1600, size: 16, material }));
  const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}` } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
  };
  await until(() => msgs.some((m) => m.type === 'inventory'));
  let nextId = 1;
  /** Mines block x (of the row) for `ms` with `tool` said to be in hand; the edit's result, and what they have after. */
  const mine = async (bx: number, ms: number, tool?: number) => {
    const at = { x: bx * 16, y: 0, z: 1600 };
    ws.send(JSON.stringify({ type: 'mine', ...at, ...(tool !== undefined ? { tool } : {}) }));
    await new Promise((r) => setTimeout(r, ms));
    const id = nextId++;
    ws.send(JSON.stringify({ type: 'edit', id, edit: { op: 'remove', ...at } }));
    await until(() => msgs.some((m) => m.type === 'editResult' && m.id === id));
    await new Promise((r) => setTimeout(r, 50)); // (a new inventory, if anything was given)
    return msgs.find((m) => m.type === 'editResult' && m.id === id)!;
  };
  const have = (id: number) => new Map(msgs.filter((m) => m.type === 'inventory').at(-1)?.items ?? []).get(id) ?? 0;
  return { ws, mine, have };
}

describe('tools', () => {
  it('mine faster and give what stone and ore hold; a hand, or a tool not had, is slow and gets nothing', async () => {
    const { ws, mine, have } = await setup();
    // By hand: 0.2 s isn't long enough for stone (0.9 s); 1 s is, and gives nothing.
    expect(await mine(100, 200)).toMatchObject({ ok: false, error: 'keep mining: it takes longer' });
    expect(await mine(100, 1000)).toMatchObject({ ok: true });
    expect(have(Material.Cobblestone)).toBe(0);
    // A stone pickaxe they don't have: as a hand.
    expect(await mine(101, 200, Item.StonePickaxe)).toMatchObject({ ok: false });
    // The wooden pickaxe: quick (0.15 s), and cobblestone.
    expect(await mine(102, 200, Item.WoodenPickaxe)).toMatchObject({ ok: true });
    expect(have(Material.Cobblestone)).toBe(B);
    // Coal ore: coal.
    expect(await mine(103, 200, Item.WoodenPickaxe)).toMatchObject({ ok: true });
    expect(have(Material.Coal)).toBe(B);
    // Iron ore wants a stone pickaxe: with a wooden one, as slow as a hand (1.05 s) and nothing.
    expect(await mine(104, 300, Item.WoodenPickaxe)).toMatchObject({ ok: false, error: 'keep mining: it takes longer' });
    expect(await mine(104, 1100, Item.WoodenPickaxe)).toMatchObject({ ok: true });
    expect(have(Material.RawIron)).toBe(0);
    // A pickaxe isn't used up (they don't wear out yet).
    expect(have(Item.WoodenPickaxe)).toBe(1);
    ws.close();
  }, 15_000);
});
