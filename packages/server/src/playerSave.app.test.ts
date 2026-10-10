import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Material, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, type Inventory, type Place, type PlayerState } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), KEY = 'default@single';
type Inv = Extract<ServerMessage, { type: 'inventory' }>;

/** Inventories kept in memory, each save taking a while (as a database's does). */
class SlowStore extends MemoryInventoryStore {
  constructor(private readonly ms: number) {
    super();
  }
  private wait = () => new Promise((r) => setTimeout(r, this.ms));
  override async save(a: string, w: string, inv: Inventory) {
    await this.wait();
    return super.save(a, w, inv);
  }
  override async savePlace(a: string, w: string, place: Place) {
    await this.wait();
    return super.savePlace(a, w, place);
  }
  override async saveState(a: string, w: string, state: PlayerState) {
    await this.wait();
    return super.saveState(a, w, state);
  }
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(saveMs: number) {
  const accounts = new MemoryAccountStore(), inventories = new SlowStore(saveMs);
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
  const cookie = `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}`;
  return { url, cookie, inventories, ann };
}

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
  return { ws, msgs, until, inventory: () => msgs.filter((m): m is Inv => m.type === 'inventory').at(-1)! };
}

const HOTBAR = [Material.Wood, null, null, null, null, null, null, null, null, Material.Dirt];

describe('a survival player kept on leaving', () => {
  it('comes back as they left, even straight away (before their last save has finished)', async () => {
    const { url, cookie } = await setup(150);
    const p = await player(url, cookie);
    p.ws.send(JSON.stringify({ type: 'setHotbar', hotbar: HOTBAR }));
    p.ws.send(JSON.stringify({ type: 'pose', x: 1234, y: 40, z: 5678, yaw: 1 }));
    await new Promise((r) => setTimeout(r, 30));
    p.ws.close();
    await new Promise((r) => p.ws.once('close', r));
    const again = await player(url, cookie);
    expect(again.inventory().hotbar).toEqual(HOTBAR);
    await again.until(() => again.msgs.some((m) => m.type === 'returnTo'));
    expect(again.msgs.find((m) => m.type === 'returnTo')).toMatchObject({ x: 1234, y: 40, z: 5678 });
    again.ws.close();
  });

  it('in two windows: the first kept and let go (told why), the second loaded as the first left it', async () => {
    const { url, cookie, inventories, ann } = await setup(150);
    const first = await player(url, cookie);
    first.ws.send(JSON.stringify({ type: 'setHotbar', hotbar: HOTBAR }));
    await new Promise((r) => setTimeout(r, 30));
    const closed = new Promise<number>((r) => first.ws.once('close', (code) => r(code)));
    const second = await player(url, cookie);
    expect(second.inventory().hotbar).toEqual(HOTBAR);
    expect(await closed).toBe(4004);
    expect(first.msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'replaced' });
    // The second's changes are what's kept (the first's not saved over them).
    const later = [...HOTBAR].reverse();
    second.ws.send(JSON.stringify({ type: 'setHotbar', hotbar: later }));
    await new Promise((r) => setTimeout(r, 30));
    second.ws.close();
    await new Promise((r) => second.ws.once('close', r));
    await app!.close();
    app = null;
    expect((await inventories.load(ann.id, KEY))?.hotbar).toEqual(later);
  });

  it('is kept when the server shuts down (a deploy) with them still in', async () => {
    const { url, cookie, inventories, ann } = await setup(150);
    const p = await player(url, cookie);
    p.ws.send(JSON.stringify({ type: 'setHotbar', hotbar: HOTBAR }));
    p.ws.send(JSON.stringify({ type: 'pose', x: 1234, y: 40, z: 5678, yaw: 1 }));
    await new Promise((r) => setTimeout(r, 30));
    await app!.close();
    app = null;
    expect((await inventories.load(ann.id, KEY))?.hotbar).toEqual(HOTBAR);
    expect(await inventories.loadPlace(ann.id, KEY)).toMatchObject({ x: 1234, y: 40, z: 5678 });
    expect((await inventories.loadState(ann.id, KEY))?.vitals).not.toBeNull();
  });
});
