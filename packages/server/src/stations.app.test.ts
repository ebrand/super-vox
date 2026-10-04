import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  BLOCK_VOLUME,
  FLAT_WORLD_16KM,
  FlatGenerator,
  HOTBAR_SLOTS,
  Item,
  Material,
  PROTOCOL_VERSION,
  defaultFlatGen,
  setDesigns,
  type ObjectDesign,
  type ServerMessage,
} from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { FileChunkStore } from './chunkStore.js';
import { DesignLibrary } from './designs.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const B = BLOCK_VOLUME, PIECE = B / 8;
const S = Material.Stone;
/** A 1 m station (a stone cube) standing in for `role`. */
const station = (role: 'furnace' | 'stove'): Omit<ObjectDesign, 'item'> => ({ id: role, name: role === 'furnace' ? 'Furnace' : 'Stove', size: [1, 1, 1], recipe: null, role, states: [{ name: 'lit', voxels: [{ x: 0, y: 0, z: 0, size: 16, material: S }] }] });

let app: FastifyInstance;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  setDesigns([]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const accounts = new MemoryAccountStore();
  const inventories = new MemoryInventoryStore();
  const dir = mkdtempSync(join(tmpdir(), 'stations-'));
  dirs.push(dir);
  const store = new FileChunkStore(dir);
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), { store });
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  const designs = new DesignLibrary(null);
  designs.put(station('furnace'));
  designs.put(station('stove'));
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, miningTimeScale: 0.01, designs });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  await inventories.save(ann.id, 'default@single', {
    items: new Map([[Item.Furnace, 1], [Item.Stove, 1], [Material.RawIron, 2 * B], [Material.Coal, B], [Item.Pork, 3], [Item.Stick, 4]]),
    hotbar: Array(HOTBAR_SLOTS).fill(null),
  });
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
  // Standing beside block (100, 0, 100).
  ws.send(JSON.stringify({ type: 'pose', x: 102 * 16, y: 26, z: 100 * 16 + 8, yaw: 0 }));
  let id = 1;
  const placed = async (item: number, x: number) => {
    ws.send(JSON.stringify({ type: 'placeObject', id, item, x, y: 0, z: 100, facing: 'n' }));
    const mine = id++;
    await until(() => msgs.some((m) => m.type === 'editResult' && m.id === mine));
    return msgs.find((m) => m.type === 'editResult' && m.id === mine)!;
  };
  /** Sends a station message and waits for the answer: the station's state, or the refusal. */
  const ask = async (msg: object) => {
    const n = msgs.length;
    ws.send(JSON.stringify(msg));
    await until(() => msgs.slice(n).some((m) => m.type === 'station' || (m.type === 'error' && m.code === 'station')));
    return msgs.slice(n).find((m) => m.type === 'station' || m.type === 'error')!;
  };
  const have = (item: number) => new Map(msgs.filter((m) => m.type === 'inventory').at(-1)?.items ?? []).get(item) ?? 0;
  return { ws, msgs, until, placed, ask, have, world, store, dir };
}

describe('furnaces and stoves in play', () => {
  it('take fuel and raw iron from the inventory, smelt with no one near, and give the ingots', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { placed, ask, have, until } = await setup();
    expect(await placed(Item.Furnace, 100)).toMatchObject({ ok: true });
    const at = { x: 100, y: 0, z: 100 };
    expect(await ask({ type: 'stationOpen', ...at })).toMatchObject({ type: 'station', kind: 'furnace', name: 'Furnace', state: { fuel: null, input: null, output: null } });
    expect(await ask({ type: 'stationPut', ...at, slot: 'fuel', item: Material.Coal, amount: PIECE })).toMatchObject({ state: { fuel: { item: Material.Coal, amount: PIECE } } });
    expect(await ask({ type: 'stationPut', ...at, slot: 'input', item: Material.RawIron, amount: B })).toMatchObject({ state: { input: { item: Material.RawIron, amount: B } } });
    await until(() => have(Material.RawIron) === B);
    expect(have(Material.Coal)).toBe(B - PIECE);
    // Refused: not burnable, not smeltable, more than they have, nothing to take.
    expect(await ask({ type: 'stationPut', ...at, slot: 'fuel', item: Item.Pork, amount: 1 })).toMatchObject({ type: 'error', message: expect.stringMatching(/doesn't burn/) });
    expect(await ask({ type: 'stationPut', ...at, slot: 'input', item: Item.Pork, amount: 1 })).toMatchObject({ type: 'error', message: expect.stringMatching(/smelts raw iron/) });
    expect(await ask({ type: 'stationPut', ...at, slot: 'input', item: Material.RawIron, amount: 5 * B })).toMatchObject({ type: 'error', message: expect.stringMatching(/haven't that much/) });
    expect(await ask({ type: 'stationTake', ...at, slot: 'output' })).toMatchObject({ type: 'error', message: 'nothing there' });
    // 80 s later (a piece of coal: eight ingots), however it's been since.
    vi.setSystemTime(1_000_000 + 80_000);
    const later = await ask({ type: 'stationOpen', ...at });
    expect(later).toMatchObject({ state: { output: { item: Item.IronIngot, amount: 8 }, input: null, fuel: null } });
    await ask({ type: 'stationTake', ...at, slot: 'output' });
    await until(() => have(Item.IronIngot) === 8);
  }, 20_000);

  it('cook on a stove; are only within reach; give back what is in them when taken down; are kept with the world', async () => {
    const { placed, ask, have, until, ws, world, store } = await setup();
    expect(await placed(Item.Stove, 101)).toMatchObject({ ok: true });
    const at = { x: 101, y: 0, z: 100 };
    await ask({ type: 'stationOpen', ...at });
    await ask({ type: 'stationPut', ...at, slot: 'input', item: Item.Pork, amount: 3 });
    await ask({ type: 'stationPut', ...at, slot: 'fuel', item: Item.Stick, amount: 1 });
    // Kept with the world: another World on the same store finds it.
    const again = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), { store });
    expect(again.station(again.objectAt(101, 0, 100)!, Date.now())!.state).toMatchObject({ input: { item: Item.Pork, amount: 3 } });
    // Too far.
    ws.send(JSON.stringify({ type: 'pose', x: 200 * 16, y: 26, z: 200 * 16, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await ask({ type: 'stationOpen', ...at })).toMatchObject({ type: 'error', message: 'too far from the Stove' });
    // Taken down: the stove, and the pork (and fuel left) back.
    ws.send(JSON.stringify({ type: 'pose', x: 102 * 16, y: 26, z: 100 * 16 + 8, yaw: 0 }));
    ws.send(JSON.stringify({ type: 'mine', x: 101 * 16 + 4, y: 4, z: 100 * 16 + 4 }));
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({ type: 'edit', id: 99, edit: { op: 'remove', x: 101 * 16 + 4, y: 4, z: 100 * 16 + 4 } }));
    await until(() => have(Item.Stove) === 1 && have(Item.Pork) === 3);
    expect(world.objectAt(101, 0, 100)).toBeUndefined();
    expect(have(Item.Stick) + have(Item.CookedPork)).toBeGreaterThan(0);
  }, 20_000);
});
