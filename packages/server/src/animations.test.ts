import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, PROTOCOL_VERSION, defaultAnimations, defaultFlatGen, parseAnimationLibrary, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { AnimationStore } from './animationStore.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

describe('the animation library', () => {
  let app: FastifyInstance | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await app?.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('checks what it reads: anything missing is the default; anything wrong, why', () => {
    expect(parseAnimationLibrary({})).toEqual(defaultAnimations());
    const fast = parseAnimationLibrary({ settings: { digSeconds: 0.2 } });
    expect(typeof fast !== 'string' && fast.settings.digSeconds).toBe(0.2);
    expect(parseAnimationLibrary({ clips: { dance: {} } })).toMatch(/no clip called dance/);
    expect(parseAnimationLibrary({ clips: { walk: { driver: 'stride', smooth: true, joints: { tail: [{ at: 0, turn: [0, 0, 0] }] } } } })).toMatch(/no joint tail/);
    expect(parseAnimationLibrary({ clips: { walk: { driver: 'stride', smooth: true, joints: { legL: [{ at: 2, turn: [0, 0, 0] }] } } } })).toMatch(/at \(0\.\.1\)/);
    expect(parseAnimationLibrary({ settings: { runFrom: 6, runTo: 5 } })).toMatch(/runFrom < runTo/);
    expect(parseAnimationLibrary({ grips: { bow: { hand: 'middle', at: [0, 0, 0], turn: [0, 0, 0], scale: 1 } } })).toMatch(/hand/);
    // Keys come out in order.
    const lib = parseAnimationLibrary({ clips: { dig: { driver: 'swing', smooth: false, joints: { elbowR: [{ at: 1, turn: [1, 0, 0] }, { at: 0, turn: [0, 0, 0] }] } } } });
    expect(typeof lib !== 'string' && lib.clips.dig.joints.elbowR!.map((k) => k.at)).toEqual([0, 1]);
  });

  it('is kept in its file (none: the defaults), and reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anim-'));
    dirs.push(dir);
    const file = join(dir, 'animations.json');
    const a = new AnimationStore(file);
    expect([a.custom, a.get()]).toEqual([false, defaultAnimations()]);
    expect(a.put({ settings: { walkStride: 2 } })).toMatchObject({ settings: { walkStride: 2 } });
    const b = new AnimationStore(file);
    expect([b.custom, b.get().settings.walkStride]).toEqual([true, 2]);
    b.reset();
    expect(existsSync(file)).toBe(false);
    expect(new AnimationStore(file).custom).toBe(false);
  });

  it('admins change it; everyone connected is told at once (and anyone joining after, as it is)', async () => {
    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['ann@x.com'], secureCookies: false }, accounts);
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), {});
    app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'creative'), auth, animations: new AnimationStore(null) });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
    const bob = await accounts.signIn({ sub: 'g-bob', email: 'bob@x.com', name: 'Bob' });
    const cookieOf = (id: string) => `${SESSION_COOKIE}=${sessionToken(id, Date.now() + 1e6, SECRET)}`;
    const api = (method: string, path: string, cookie?: string, body?: unknown) =>
      fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : null });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!f()) throw new Error('timed out');
    };
    const join = async (cookie: string) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie } });
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      await until(() => msgs.some((m) => m.type === 'objects'));
      return { ws, msgs };
    };
    // The defaults: not sent (every client has them).
    const bobs = await join(cookieOf(bob.id));
    expect(bobs.msgs.some((m) => m.type === 'animations')).toBe(false);
    expect(await (await api('GET', '/api/animations')).json()).toMatchObject({ custom: false, canEdit: false });
    // Only admins change it.
    expect((await api('PUT', '/api/animations', cookieOf(bob.id), { settings: { digSeconds: 0.2 } })).status).toBe(403);
    expect((await api('PUT', '/api/animations', cookieOf(ann.id), { settings: { digSeconds: -1 } })).status).toBe(400);
    expect((await api('PUT', '/api/animations', cookieOf(ann.id), { settings: { digSeconds: 0.2 } })).status).toBe(200);
    await until(() => bobs.msgs.some((m) => m.type === 'animations'));
    expect(bobs.msgs.find((m) => m.type === 'animations')).toMatchObject({ library: { settings: { digSeconds: 0.2 } } });
    // Someone joining now gets it as it is.
    const later = await join(cookieOf(ann.id));
    expect(later.msgs.find((m) => m.type === 'animations')).toMatchObject({ library: { settings: { digSeconds: 0.2 } } });
    // Reset: back to the defaults, everyone told.
    expect((await api('DELETE', '/api/animations', cookieOf(ann.id))).status).toBe(200);
    await until(() => bobs.msgs.filter((m) => m.type === 'animations').length === 2);
    expect(await (await api('GET', '/api/animations')).json()).toMatchObject({ custom: false, library: { settings: { digSeconds: 0.32 } } });
    bobs.ws.close();
    later.ws.close();
  });
});
