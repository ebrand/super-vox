import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, googleIdentity, sessionAccountId, sessionToken, sign, unsign, type AuthConfig } from './auth.js';
import { authConfigFromEnv, loadDevSecrets } from './authConfig.js';
import { World } from './world.js';

const SECRET = 's'.repeat(40);
const CONFIG: AuthConfig = { googleClientId: 'client-1', googleClientSecret: 'shh', sessionSecret: SECRET, adminEmails: ['boss@example.com'], secureCookies: false };

/** An unsigned JWT with these claims (Google's token endpoint gives it to us over TLS). */
function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}
const GOOD = { iss: 'https://accounts.google.com', aud: 'client-1', sub: 'g-123', email: 'ann@example.com', email_verified: true, name: 'Ann', exp: Date.now() / 1000 + 3600 };

describe('session tokens', () => {
  it('sign and verify, rejecting tampering, expiry and other secrets', () => {
    expect(unsign(sign('hello', SECRET), SECRET)).toBe('hello');
    expect(unsign(sign('hello', SECRET) + 'x', SECRET)).toBeNull();
    expect(unsign(sign('hello', SECRET), 'x'.repeat(40))).toBeNull();
    expect(unsign('no-dot', SECRET)).toBeNull();
    const t = sessionToken('acct-1', 2000, SECRET);
    expect(sessionAccountId(t, SECRET, 1000)).toBe('acct-1');
    expect(sessionAccountId(t, SECRET, 3000)).toBeNull();
    expect(sessionAccountId(undefined, SECRET)).toBeNull();
    const [value] = t.split('.');
    const forged = sign(Buffer.from(JSON.stringify({ a: 'acct-2', e: 2000 })).toString('base64url'), 'y'.repeat(40));
    expect(sessionAccountId(forged, SECRET, 1000)).toBeNull();
    expect(sessionAccountId(`${value}.${forged.split('.')[1]}`, SECRET, 1000)).toBeNull();
  });
});

describe('Google ID tokens', () => {
  it('give the identity when the claims check out', () => {
    expect(googleIdentity(idToken(GOOD), 'client-1')).toEqual({ sub: 'g-123', email: 'ann@example.com', name: 'Ann' });
    expect(googleIdentity(idToken({ ...GOOD, name: undefined }), 'client-1').name).toBe('ann');
  });

  it('are refused for another client, issuer, an expired or unverified one', () => {
    expect(() => googleIdentity(idToken({ ...GOOD, aud: 'other' }), 'client-1')).toThrow(/another client/);
    expect(() => googleIdentity(idToken({ ...GOOD, iss: 'evil.example' }), 'client-1')).toThrow(/not from Google/);
    expect(() => googleIdentity(idToken({ ...GOOD, exp: 1 }), 'client-1')).toThrow(/expired/);
    expect(() => googleIdentity(idToken({ ...GOOD, email_verified: false }), 'client-1')).toThrow(/not verified/);
    expect(() => googleIdentity('garbage', 'client-1')).toThrow();
  });
});

describe('signing in', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  /** The app with sign-in; Google's token endpoint answers with `token` (or fails). Ann's invited (`invite`). */
  async function setup(token: Record<string, unknown> | null = GOOD, invite = true) {
    const exchanges: URLSearchParams[] = [];
    let current = token;
    const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
      exchanges.push(init.body);
      return current ? new Response(JSON.stringify({ id_token: idToken(current) })) : new Response('no', { status: 400 });
    }) as unknown as typeof fetch;
    const accounts = new MemoryAccountStore();
    if (invite) await accounts.invite('Ann@Example.com', 'builder', null);
    const auth = new Auth(CONFIG, accounts, fakeFetch);
    app = await buildApp({ world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4))), auth });
    /** Google says it's someone else from now on. */
    const as = (claims: Record<string, unknown>) => (current = { ...GOOD, ...claims });
    return { exchanges, accounts, as };
  }

  const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
    ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));

  async function signIn(back = '/play.html?world=dev') {
    const start = await app.inject({ method: 'GET', url: `/api/auth/google?return=${encodeURIComponent(back)}`, headers: { host: 'game.test' } });
    expect(start.statusCode).toBe(302);
    const google = new URL(start.headers.location as string);
    const state = google.searchParams.get('state')!;
    const stateCookie = cookieOf(start.headers['set-cookie'], 'sv_oauth')!;
    const done = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${state}`, headers: { host: 'game.test', cookie: stateCookie } });
    return { google, state, stateCookie, done, session: cookieOf(done.headers['set-cookie'], SESSION_COOKIE) };
  }

  it('goes to Google, comes back, and signs in', async () => {
    const { exchanges } = await setup();
    const { google, done, session } = await signIn();
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('redirect_uri')).toBe('http://game.test/api/auth/google/callback');
    expect(google.searchParams.get('scope')).toBe('openid email profile');
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/play.html?world=dev');
    expect(exchanges[0]!.get('code')).toBe('abc');
    expect(exchanges[0]!.get('client_secret')).toBe('shh');
    expect(session).toBeDefined();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session! } });
    expect(me.json()).toMatchObject({ signedIn: true, name: 'Ann', email: 'ann@example.com', admin: false, builds: true });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json()).toEqual({ signedIn: false });
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: session! } });
    expect(String(out.headers['set-cookie'])).toMatch(/sv_session=;/);
  });

  it('refuses a callback without the matching state, and stays signed out when Google says no', async () => {
    await setup();
    const { stateCookie } = await signIn();
    const wrong = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=forged', headers: { cookie: stateCookie } });
    expect(wrong.statusCode).toBe(400);
    expect(cookieOf(wrong.headers['set-cookie'], SESSION_COOKIE)).toBeUndefined();
    const none = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=x' });
    expect(none.statusCode).toBe(400);
    await app.close();
    await setup({ ...GOOD, email_verified: false });
    const { done, session } = await signIn();
    expect(done.statusCode).toBe(403);
    expect(session).toBeUndefined();
  });

  it('only goes back to pages on this site', async () => {
    await setup();
    const { done } = await signIn('https://evil.example/');
    expect(done.headers.location).toBe('/');
    expect((await signIn('//evil.example/x')).done.headers.location).toBe('/');
  });

  it('lets only signed-in players edit, and tells the game who they are', async () => {
    await setup({ ...GOOD, email: 'boss@example.com' });
    const { session } = await signIn();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = address.replace(/^http/, 'ws') + '/ws';
    const play = async (cookie?: string) => {
      const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      };
      await until(() => msgs.some((m) => m.type === 'welcome'));
      ws.send(JSON.stringify({ type: 'edit', id: 7, edit: { op: 'remove', x: 1000, y: -1, z: 1000 } }));
      await until(() => msgs.some((m) => m.type === 'editResult'));
      ws.close();
      return { welcome: msgs.find((m) => m.type === 'welcome'), result: msgs.find((m) => m.type === 'editResult') };
    };
    const signedIn = await play(session);
    expect(signedIn.welcome).toMatchObject({ player: { name: 'Ann', admin: true }, canEdit: true });
    expect(signedIn.result).toEqual({ type: 'editResult', id: 7, ok: true });
    const guest = await play();
    expect(guest.welcome).toMatchObject({ player: null, canEdit: false });
    expect(guest.result).toEqual({ type: 'editResult', id: 7, ok: false, error: 'sign in to build' });
    const forged = await play(`${SESSION_COOKIE}=${sessionToken('someone', Date.now() + 1e6, 'z'.repeat(40))}`);
    expect(forged.welcome).toMatchObject({ player: null, canEdit: false });
  });
});

describe('sign-in settings', () => {
  it('come from the environment, all three or none', () => {
    expect(authConfigFromEnv({}, true)).toBeNull();
    expect(authConfigFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }, true)).toBeNull();
    expect(authConfigFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SESSION_SECRET: SECRET, ADMIN_EMAILS: ' Boss@Example.com, x@y.z ', PUBLIC_URL: 'https://v.test' }, true)).toEqual({
      googleClientId: 'a', googleClientSecret: 'b', sessionSecret: SECRET, publicUrl: 'https://v.test', adminEmails: ['boss@example.com', 'x@y.z'], secureCookies: true,
    });
    expect(() => authConfigFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SESSION_SECRET: 'short' }, false)).toThrow(/32/);
  });

  it('come from auth/ in development, without overriding the environment or taking the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv-auth-'));
    try {
      writeFileSync(join(dir, 'google.json'), JSON.stringify({ web: { client_id: 'cid', client_secret: 'csecret' } }));
      writeFileSync(join(dir, 'session-secret.txt'), `${SECRET}\n`);
      writeFileSync(join(dir, 'railway.json'), JSON.stringify({ _how: 'x', api: { ADMIN_EMAILS: 'a@b.c', DATABASE_URL: 'postgres://nope' } }));
      const env: NodeJS.ProcessEnv = { GOOGLE_CLIENT_ID: 'from-env' };
      expect(loadDevSecrets(env, dir).sort()).toEqual(['ADMIN_EMAILS', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']);
      expect(env).toEqual({ GOOGLE_CLIENT_ID: 'from-env', GOOGLE_CLIENT_SECRET: 'csecret', SESSION_SECRET: SECRET, ADMIN_EMAILS: 'a@b.c' });
      // With the client from auth/, the callback goes to the dev client's address.
      const fresh: NodeJS.ProcessEnv = {};
      expect(loadDevSecrets(fresh, dir)).toContain('PUBLIC_URL');
      expect(fresh.PUBLIC_URL).toBe('http://localhost:5173');
      expect(loadDevSecrets({}, join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('players: invitations, roles and bans', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup() {
    let current: Record<string, unknown> = GOOD;
    const fakeFetch = (async () => new Response(JSON.stringify({ id_token: idToken(current) }))) as unknown as typeof fetch;
    const accounts = new MemoryAccountStore();
    const auth = new Auth(CONFIG, accounts, fakeFetch);
    app = await buildApp({ world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4))), auth });
    const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
      ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));
    /** Signs in as whoever has these claims: where it ends up, and the session (if any). */
    const signIn = async (claims: Record<string, unknown>) => {
      current = { ...GOOD, ...claims };
      const start = await app.inject({ method: 'GET', url: '/api/auth/google?return=/', headers: { host: 'game.test' } });
      const state = new URL(start.headers.location as string).searchParams.get('state')!;
      const done = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=abc&state=${state}`, headers: { host: 'game.test', cookie: cookieOf(start.headers['set-cookie'], 'sv_oauth')! } });
      return { location: done.headers.location as string, session: cookieOf(done.headers['set-cookie'], SESSION_COOKIE) };
    };
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
      app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
    return { accounts, signIn, call };
  }

  it('let in only the invited (as their invitation says) and admins; those already here stay', async () => {
    const { accounts, signIn } = await setup();
    // Not invited: back to the page, told so; no account.
    const no = await signIn({ sub: 'g-1', email: 'cat@example.com', name: 'Cat' });
    expect(no.location).toBe('/?signin=uninvited');
    expect(no.session).toBeUndefined();
    expect(await accounts.list()).toEqual([]);
    // An admin's email: in, as an admin.
    const boss = await signIn({ sub: 'g-2', email: 'Boss@example.com', name: 'Boss' });
    expect(boss.session).toBeDefined();
    expect((await accounts.findBySub('g-2'))!.role).toBe('admin');
    // Invited as a visitor: in, as one; the invitation's used (not again, by another account).
    await accounts.invite('cat@example.com', 'visitor', null);
    expect((await signIn({ sub: 'g-1', email: 'cat@example.com', name: 'Cat' })).session).toBeDefined();
    expect((await accounts.findBySub('g-1'))!.role).toBe('visitor');
    expect((await accounts.invites())[0]).toMatchObject({ email: 'cat@example.com', usedBy: (await accounts.findBySub('g-1'))!.id });
    expect((await signIn({ sub: 'g-9', email: 'cat@example.com', name: 'Cat 2' })).location).toBe('/?signin=uninvited');
    // An account made before invitations (or by the store directly): in, as it was.
    await accounts.signIn({ sub: 'g-3', email: 'old@example.com', name: 'Old' });
    expect((await signIn({ sub: 'g-3', email: 'old@example.com', name: 'Old' })).session).toBeDefined();
  });

  it('are managed by admins only: invitations, roles and bans (which sign them out, and keep them out)', async () => {
    const { accounts, signIn, call } = await setup();
    await accounts.invite('ann@example.com', 'builder', null);
    const ann = (await signIn({})).session!;
    const boss = (await signIn({ sub: 'g-2', email: 'boss@example.com', name: 'Boss' })).session!;
    // Not for builders, or anyone not signed in.
    expect((await call('GET', '/api/players', ann)).statusCode).toBe(403);
    expect((await call('GET', '/api/players')).statusCode).toBe(403);
    expect((await call('POST', '/api/invites', ann, { email: 'x@example.com' })).statusCode).toBe(403);
    // Admins: the list, invitations made and taken back.
    const list = (await call('GET', '/api/players', boss)).json() as { players: { id: string; name: string; role: string; adminByEmail: boolean }[] };
    expect(list.players.map((p) => [p.name, p.role, p.adminByEmail]).sort()).toEqual([['Ann', 'builder', false], ['Boss', 'admin', true]]);
    expect((await call('POST', '/api/invites', boss, { email: 'not an email' })).statusCode).toBe(400);
    expect((await call('POST', '/api/invites', boss, { email: 'Dan@Example.com', role: 'visitor' })).json()).toMatchObject({ invite: { email: 'dan@example.com', role: 'visitor' } });
    expect((await call('DELETE', '/api/invites/dan%40example.com', boss)).statusCode).toBe(200);
    expect((await call('DELETE', '/api/invites/dan%40example.com', boss)).statusCode).toBe(404);
    const annId = list.players.find((p) => p.name === 'Ann')!.id, bossId = list.players.find((p) => p.name === 'Boss')!.id;
    // Not themselves.
    expect((await call('PATCH', `/api/players/${bossId}`, boss, { banned: true })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/players/${bossId}`, boss, { role: 'visitor' })).statusCode).toBe(400);
    // Ann a visitor: still signed in, but builds no more.
    expect((await call('PATCH', `/api/players/${annId}`, boss, { role: 'visitor' })).json()).toMatchObject({ player: { role: 'visitor' } });
    expect((await call('GET', '/api/auth/me', ann)).json()).toMatchObject({ signedIn: true, builds: false });
    // Banned: her session's no good, and she can't sign in again; unbanned, she can.
    expect((await call('PATCH', `/api/players/${annId}`, boss, { banned: true })).json()).toMatchObject({ player: { banned: true } });
    expect((await call('GET', '/api/auth/me', ann)).json()).toEqual({ signedIn: false });
    expect((await signIn({})).location).toBe('/?signin=banned');
    await call('PATCH', `/api/players/${annId}`, boss, { banned: false });
    expect((await signIn({})).session).toBeDefined();
  });

  it('take effect at once for those playing: a visitor can\'t build; a ban or a new role lets them go, saying why', async () => {
    const { accounts, signIn, call } = await setup();
    await accounts.invite('ann@example.com', 'visitor', null);
    const ann = (await signIn({})).session!;
    const boss = (await signIn({ sub: 'g-2', email: 'boss@example.com', name: 'Boss' })).session!;
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(address.replace(/^http/, 'ws') + '/ws', { headers: { cookie: ann } });
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 80)}`);
    };
    await until(() => msgs.some((m) => m.type === 'boats'));
    expect(msgs.find((m) => m.type === 'welcome')).toMatchObject({ player: { name: 'Ann', admin: false }, canEdit: false });
    ws.send(JSON.stringify({ type: 'edit', id: 1, edit: { op: 'remove', x: 1000, y: -1, z: 1000 } }));
    await until(() => msgs.some((m) => m.type === 'editResult'));
    expect(msgs.find((m) => m.type === 'editResult')).toMatchObject({ ok: false, error: /visitor/ });
    const annId = (await accounts.findBySub('g-123'))!.id;
    await call('PATCH', `/api/players/${annId}`, boss, { role: 'builder' });
    await until(() => msgs.some((m) => m.type === 'error'));
    expect(msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'access_changed' });
    expect(await closed).toBe(4003);
    // Back in as a builder: banned while playing.
    const ws2 = new WebSocket(address.replace(/^http/, 'ws') + '/ws', { headers: { cookie: ann } });
    const msgs2: ServerMessage[] = [];
    ws2.on('message', (d, bin) => !bin && msgs2.push(JSON.parse(String(d)) as ServerMessage));
    const closed2 = new Promise<number>((r) => ws2.once('close', (code) => r(code)));
    await new Promise((r) => ws2.once('open', r));
    ws2.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await until(() => msgs2.some((m) => m.type === 'boats'));
    expect(msgs2.find((m) => m.type === 'welcome')).toMatchObject({ canEdit: true });
    await call('PATCH', `/api/players/${annId}`, boss, { banned: true });
    expect(await closed2).toBe(4003);
    expect(msgs2.find((m) => m.type === 'error')).toMatchObject({ code: 'banned' });
  });
});
