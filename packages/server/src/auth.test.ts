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

  /** The app with sign-in; Google's token endpoint answers with `token` (or fails). */
  async function setup(token: Record<string, unknown> | null = GOOD) {
    const exchanges: URLSearchParams[] = [];
    const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
      exchanges.push(init.body);
      return token ? new Response(JSON.stringify({ id_token: idToken(token) })) : new Response('no', { status: 400 });
    }) as unknown as typeof fetch;
    const auth = new Auth(CONFIG, new MemoryAccountStore(), fakeFetch);
    app = await buildApp({ world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4))), auth });
    return { exchanges };
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
    expect(me.json()).toEqual({ signedIn: true, name: 'Ann', email: 'ann@example.com', admin: false });
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
