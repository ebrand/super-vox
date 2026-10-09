import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FIGURE_JOINTS, FLAT_WORLD_16KM, FlatGenerator, PROTOCOL_VERSION, defaultFlatGen, type FigureMesh, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MeshStore } from './meshStore.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
/** A figure (any): a little triangle on each joint, the joints a metre apart up. */
const tri = [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0];
const figure = (): FigureMesh => ({
  parts: Object.fromEntries(FIGURE_JOINTS.map((j) => [j, tri])) as FigureMesh['parts'],
  pivots: Object.fromEntries(FIGURE_JOINTS.map((j, i) => [j, [0, i * 0.1, 0]])) as FigureMesh['pivots'],
  hair: tri,
});

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function setup(store: MeshStore) {
  const accounts = new MemoryAccountStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world), auth, meshes: store });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const cookie = async (sub: string, email: string) => `${SESSION_COOKIE}=${sessionToken((await accounts.signIn({ sub, email, name: sub }, email === 'boss@x.com' ? 'admin' : 'builder')).id, Date.now() + 1e6, SECRET)}`;
  return { url, boss: await cookie('boss', 'boss@x.com'), ann: await cookie('ann', 'ann@x.com') };
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error('timed out');
  };
  await until(() => msgs.some((m) => m.type === 'welcome'));
  return { ws, msgs, until };
}

describe('the mesh library', () => {
  it("is everyone's to see, admins' to change (whole figures only), sent to everyone at once and on joining, and kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meshes-')), file = join(dir, 'meshes.json');
    const { url, boss, ann } = await setup(new MeshStore(file));
    const get = await app.inject({ method: 'GET', url: '/api/meshes', headers: { cookie: ann } });
    expect(get.json()).toEqual({ library: { figures: {} }, canEdit: false });
    expect((await app.inject({ method: 'GET', url: '/api/meshes', headers: { cookie: boss } })).json()).toMatchObject({ canEdit: true });
    // Nothing edited: nothing sent on joining.
    const a = await connect(url);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.msgs.some((m) => m.type === 'meshes')).toBe(false);
    const lib = { figures: { woman: figure() } };
    expect((await app.inject({ method: 'PUT', url: '/api/meshes', headers: { cookie: ann }, payload: lib })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/meshes', headers: { cookie: boss }, payload: { figures: { woman: { ...figure(), hair: [1] } } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/meshes', headers: { cookie: boss }, payload: lib })).statusCode).toBe(200);
    // Those here: at once. Those joining: on joining.
    await a.until(() => a.msgs.some((m) => m.type === 'meshes'));
    const b = await connect(url);
    await b.until(() => b.msgs.some((m) => m.type === 'meshes'));
    expect(b.msgs.find((m) => m.type === 'meshes')).toEqual({ type: 'meshes', library: lib });
    // Kept: in the file, and read again.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(lib);
    expect(new MeshStore(file).get()).toEqual(lib);
    // Back to as made: the file gone.
    await app.inject({ method: 'PUT', url: '/api/meshes', headers: { cookie: boss }, payload: { figures: {} } });
    expect(existsSync(file)).toBe(false);
    a.ws.close();
    b.ws.close();
  });
});
