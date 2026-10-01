import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Account, AccountStore, GoogleIdentity } from './accounts.js';

/** Signing in with Google (OAuth 2 authorization code flow, OpenID Connect). */
export interface AuthConfig {
  googleClientId: string;
  googleClientSecret: string;
  /** Signs session cookies (keep secret; changing it signs everyone out). */
  sessionSecret: string;
  /** This site's address as Google redirects back to it (e.g. https://voxel.ericbrandcode.com); else from the request. */
  publicUrl?: string;
  /** Accounts with these emails are admins. */
  adminEmails: string[];
  /** Secure cookies (HTTPS only): on in production. */
  secureCookies: boolean;
}

export const SESSION_COOKIE = 'sv_session';
const STATE_COOKIE = 'sv_oauth';
const SESSION_DAYS = 30;
const CALLBACK_PATH = '/api/auth/google/callback';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

/** What a page or connection knows about who is signed in. */
export interface SignedIn {
  account: Account;
  admin: boolean;
}

/** `value.signature`, the signature an HMAC-SHA256 of the value. */
export function sign(value: string, secret: string): string {
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}

/** The value of a token made by sign(), or null if it was tampered with. */
export function unsign(token: string, secret: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const value = token.slice(0, dot);
  const expected = Buffer.from(sign(value, secret).slice(dot + 1));
  const given = Buffer.from(token.slice(dot + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

/** A session token for an account, valid until `expires` (epoch ms). */
export function sessionToken(accountId: string, expires: number, secret: string): string {
  return sign(Buffer.from(JSON.stringify({ a: accountId, e: expires })).toString('base64url'), secret);
}

/** The account id in a valid, unexpired session token; null otherwise. */
export function sessionAccountId(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token) return null;
  const value = unsign(token, secret);
  if (!value) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(value, 'base64url').toString()) as { a?: unknown; e?: unknown };
    return typeof a === 'string' && typeof e === 'number' && e > now ? a : null;
  } catch {
    return null;
  }
}

/**
 * The identity in a Google ID token. The token comes straight from Google's token endpoint over
 * TLS, so (per OpenID Connect) its signature needn't be checked; its claims are.
 */
export function googleIdentity(idToken: string, clientId: string, now = Date.now()): GoogleIdentity {
  const part = idToken.split('.')[1];
  if (!part) throw new Error('malformed ID token');
  const c = JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') throw new Error('ID token not from Google');
  if (c.aud !== clientId) throw new Error('ID token for another client');
  if (typeof c.exp !== 'number' || c.exp * 1000 < now) throw new Error('ID token expired');
  if (typeof c.sub !== 'string' || typeof c.email !== 'string') throw new Error('ID token without an account');
  if (c.email_verified !== true) throw new Error('Google email not verified');
  return { sub: c.sub, email: c.email, name: typeof c.name === 'string' && c.name ? c.name : c.email.split('@')[0]! };
}

/** Only same-site paths as places to return to after signing in. */
function safeReturn(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export class Auth {
  constructor(
    readonly config: AuthConfig,
    readonly accounts: AccountStore,
    /** For tests: fetch for the token exchange. */
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Who a request (or WebSocket upgrade) is signed in as, from its session cookie. */
  async signedIn(cookies: Record<string, string | undefined>): Promise<SignedIn | null> {
    const id = sessionAccountId(cookies[SESSION_COOKIE], this.config.sessionSecret);
    const account = id ? await this.accounts.get(id) : null;
    return account ? { account, admin: this.config.adminEmails.includes(account.email.toLowerCase()) } : null;
  }

  private redirectUri(req: FastifyRequest): string {
    if (this.config.publicUrl) return this.config.publicUrl.replace(/\/$/, '') + CALLBACK_PATH;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
    return `${proto}://${host}${CALLBACK_PATH}`;
  }

  register(app: FastifyInstance): void {
    const cookie = (maxAgeS: number) => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: this.config.secureCookies, maxAge: maxAgeS });

    // Start: off to Google, remembering (in a signed cookie) a nonce and where to come back to.
    app.get('/api/auth/google', async (req, reply) => {
      const state = randomBytes(16).toString('base64url');
      const back = safeReturn((req.query as Record<string, unknown>).return);
      reply.setCookie(STATE_COOKIE, sign(JSON.stringify({ state, back }), this.config.sessionSecret), cookie(600));
      const url = new URL(GOOGLE_AUTH);
      url.search = new URLSearchParams({
        client_id: this.config.googleClientId,
        redirect_uri: this.redirectUri(req),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      }).toString();
      return reply.redirect(url.toString());
    });

    // Back from Google: check the nonce, trade the code for the ID token, sign in.
    app.get(CALLBACK_PATH, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const saved = unsign(req.cookies[STATE_COOKIE] ?? '', this.config.sessionSecret);
      reply.clearCookie(STATE_COOKIE, { path: '/' });
      let back = '/';
      try {
        const { state, back: b } = JSON.parse(saved ?? 'null') as { state: string; back: string };
        back = safeReturn(b);
        if (!q.state || q.state !== state) throw new Error('state mismatch');
      } catch {
        return reply.code(400).send({ error: 'sign-in expired or came from elsewhere; try again' });
      }
      if (q.error || !q.code) return reply.redirect(`${back}${back.includes('?') ? '&' : '?'}signin=cancelled`);
      const res = await this.fetchFn(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.code,
          client_id: this.config.googleClientId,
          client_secret: this.config.googleClientSecret,
          redirect_uri: this.redirectUri(req),
          grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) {
        req.log.warn({ status: res.status }, 'Google token exchange failed');
        return reply.code(502).send({ error: 'Google sign-in failed; try again' });
      }
      const { id_token } = (await res.json()) as { id_token?: string };
      let identity: GoogleIdentity;
      try {
        identity = googleIdentity(id_token ?? '', this.config.googleClientId);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'Google ID token rejected');
        return reply.code(403).send({ error: (err as Error).message });
      }
      const account = await this.accounts.signIn(identity);
      reply.setCookie(SESSION_COOKIE, sessionToken(account.id, Date.now() + SESSION_DAYS * 86_400_000, this.config.sessionSecret), cookie(SESSION_DAYS * 86_400));
      req.log.info({ account: account.id }, 'signed in');
      return reply.redirect(back);
    });

    app.get('/api/auth/me', async (req) => {
      const who = await this.signedIn(req.cookies);
      return { signedIn: !!who, ...(who ? { name: who.account.name, email: who.account.email, admin: who.admin } : {}) };
    });

    app.post('/api/auth/logout', async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { signedIn: false };
    });
  }
}
