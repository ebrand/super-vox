import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, WORLD_SHAPES, defaultPlateTerrain, defaultVoxelize, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { generatorFor, worldConfigOf } from './worldFile.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40), M = 16;
let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function setup(mode: 'creative' | 'survival') {
  const plates = { ...defaultPlateTerrain(21, WORLD_SHAPES['round-16x8']), lakes: 80 };
  const spec = { generator: 'plates' as const, plates, voxelize: defaultVoxelize(), shape: 'round-16x8' as const };
  const config = worldConfigOf(spec);
  const world = new World(config, generatorFor(spec, config).generator);
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, mode), auth, inventories });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const a = await accounts.signIn({ sub: 'ann', email: 'ann@x.com', name: 'ann' }, 'builder');
  await inventories.save(a.id, mode === 'creative' ? 'default@single/creative' : 'default@single', starterInventory());
  const ws = new WebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}` } });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 20_000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  await until(() => msgs.some((m) => m.type === 'aqueducts'));
  ws.send(JSON.stringify({ type: 'pose', x: 6375 * M, y: 130 * M, z: 5468 * M, yaw: 0 }));
  let id = 0;
  const ask = async (m: Record<string, unknown>) => {
    const asked = ++id;
    ws.send(JSON.stringify({ ...m, id: asked }));
    await until(() => msgs.some((r) => r.type === 'aqueductPlan' && r.id === asked));
    return msgs.find((r): r is Extract<ServerMessage, { type: 'aqueductPlan' }> => r.type === 'aqueductPlan' && r.id === asked)!;
  };
  const aqueducts = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'aqueducts' }> => m.type === 'aqueducts').at(-1)!.aqueducts;
  return { ws, ask, aqueducts, until };
}

// (North from the lake's shore: east, its water.)
const segment = { aqueduct: null, from: { bx: 6374, bz: 5488 }, to: { bx: 6374, bz: 5448 }, fall: 1 / 50 };

describe('aqueducts over the connection', () => {
  it('are planned (their cells, the ground, what they take), built (everyone told) and finished, in creative', async () => {
    const t = await setup('creative');
    expect(t.aqueducts()).toEqual([]);
    const plan = await t.ask({ type: 'aqueduct', ...segment, build: false });
    expect(plan.error).toBeUndefined();
    expect(plan.plan!.cells).toHaveLength(41);
    expect(plan.plan!.cost.length).toBeGreaterThan(0);
    const built = await t.ask({ type: 'aqueduct', ...segment, build: true });
    expect(built.built).toBe(1);
    await t.until(() => t.aqueducts().length === 1);
    expect(t.aqueducts()[0]).toMatchObject({ id: 1, runs: 41, finished: false });
    const done = await t.ask({ type: 'aqueductFinish', aqueduct: 1 });
    expect(done.built).toBe(1);
    await t.until(() => t.aqueducts()[0]!.finished);
    t.ws.close();
  }, 120_000);

  it('in survival, take the stone they are built of (refused without it)', async () => {
    const t = await setup('survival');
    const r = await t.ask({ type: 'aqueduct', ...segment, build: true });
    expect(r.error).toMatch(/it takes .* of cobblestone/);
    expect(r.plan).toBeDefined();
    t.ws.close();
  }, 120_000);
});
