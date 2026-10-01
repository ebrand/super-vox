import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { BLOCK_VOLUME, FLAT_WORLD_16KM, FlatGenerator, HOTBAR_SLOTS, Material, PROTOCOL_VERSION, defaultFlatGen, type GameMode, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
const B = BLOCK_VOLUME;
type Inv = Extract<ServerMessage, { type: 'inventory' }>;

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A flat world (grass over dirt over stone, 1/4 m voxels) in `mode`, with sign-in and inventories. */
async function setup(mode: GameMode) {
  const accounts = new MemoryAccountStore();
  const inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  const cookie = `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}`;
  return { url, cookie, inventories, ann };
}

/** A connection that says hello and collects what comes back. */
async function player(url: string, cookie?: string) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error('timed out');
  };
  let nextId = 1;
  const inventories = () => msgs.filter((m): m is Inv => m.type === 'inventory');
  return {
    ws,
    msgs,
    until,
    inventory: () => inventories().at(-1),
    async edit(edit: object) {
      const id = nextId++;
      const before = inventories().length;
      ws.send(JSON.stringify({ type: 'edit', id, edit }));
      await until(() => msgs.some((m) => m.type === 'editResult' && m.id === id));
      const result = msgs.find((m) => m.type === 'editResult' && m.id === id)!;
      // An accepted survival edit is followed by the new inventory.
      if (result.type === 'editResult' && result.ok && inventories()[0]?.mode === 'survival') await until(() => inventories().length > before);
      return result;
    },
  };
}

describe('inventories', () => {
  it('start a survival player with the kit, take what they place and give what they mine', async () => {
    const { url, cookie } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    expect(p.inventory()).toEqual({
      type: 'inventory',
      mode: 'survival',
      items: [[Material.Dirt, 16 * B], [Material.Stone, 16 * B], [Material.Wood, 16 * B]],
      hotbar: [Material.Dirt, Material.Stone, Material.Wood, ...Array(HOTBAR_SLOTS - 3).fill(null)],
    });
    // Mining a 1/4 m grass voxel gives that much dirt.
    expect(await p.edit({ op: 'remove', x: 1000, y: -1, z: 1000 })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Dirt)).toBe(16 * B + 64);
    // Placing a 1 m stone block uses one.
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Stone })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Stone)).toBe(15 * B);
    // Mining it back gives it back.
    expect(await p.edit({ op: 'remove', x: 1600, y: 0, z: 1600 })).toMatchObject({ ok: true });
    expect(new Map(p.inventory()!.items).get(Material.Stone)).toBe(16 * B);
    // No sand, no water in survival.
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Sand })).toEqual({
      type: 'editResult', id: 4, ok: false, error: 'not enough sand (have 0, need 1 blocks)',
    });
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Water })).toMatchObject({ ok: false, error: "water can't be placed in survival" });
    p.ws.close();
  });

  it('keep the hotbar and items across visits', async () => {
    const { url, cookie, inventories, ann } = await setup('survival');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Wood });
    const hotbar = [Material.Wood, null, null, null, null, null, null, null, Material.Dirt];
    p.ws.send(JSON.stringify({ type: 'setHotbar', hotbar }));
    await new Promise((r) => setTimeout(r, 50));
    p.ws.close();
    // Saved when the connection closes.
    for (let i = 0; i < 100 && !(await inventories.load(ann.id, 'default@single'))?.hotbar[8]; i++) await new Promise((r) => setTimeout(r, 10));
    const again = await player(url, cookie);
    await again.until(() => !!again.inventory());
    expect(again.inventory()!.hotbar).toEqual(hotbar);
    expect(new Map(again.inventory()!.items).get(Material.Wood)).toBe(15 * B);
    again.ws.close();
  });

  it('make everything unlimited in creative', async () => {
    const { url, cookie } = await setup('creative');
    const p = await player(url, cookie);
    await p.until(() => !!p.inventory());
    expect(p.inventory()).toMatchObject({ mode: 'creative', items: [] });
    expect(p.inventory()!.hotbar).toHaveLength(HOTBAR_SLOTS);
    expect(await p.edit({ op: 'place', x: 1600, y: 0, z: 1600, size: 16, material: Material.Sand })).toMatchObject({ ok: true });
    expect(await p.edit({ op: 'place', x: 1600, y: 256, z: 1600, size: 16, material: Material.Water })).toMatchObject({ ok: true });
    expect(p.msgs.filter((m) => m.type === 'inventory')).toHaveLength(1);
    p.ws.close();
  });

  it("don't exist for players who aren't signed in", async () => {
    const { url } = await setup('survival');
    const p = await player(url);
    await p.until(() => p.msgs.some((m) => m.type === 'welcome'));
    await new Promise((r) => setTimeout(r, 50));
    expect(p.inventory()).toBeUndefined();
    expect(await p.edit({ op: 'remove', x: 1000, y: -1, z: 1000 })).toMatchObject({ ok: false, error: 'sign in to build' });
    p.ws.close();
  });
});
