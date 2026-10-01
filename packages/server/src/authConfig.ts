import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthConfig } from './auth.js';

/**
 * Sign-in settings from the environment: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET
 * (all three, or sign-in is off), PUBLIC_URL and ADMIN_EMAILS (comma-separated). Null when off.
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv, production: boolean): AuthConfig | null {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, SESSION_SECRET: session } = env;
  if (!id || !secret || !session) return null;
  if (session.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    googleClientId: id,
    googleClientSecret: secret,
    sessionSecret: session,
    ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
    adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    secureCookies: production,
  };
}

/** Where the development client runs (vite; see packages/client/vite.config.ts). */
export const DEV_PUBLIC_URL = 'http://localhost:5173';

/**
 * Development: fills sign-in settings the environment lacks from the repository's auth/ folder
 * (never committed; see .gitignore): the Google client (google.json), the session secret
 * (session-secret.txt) and the admin emails (railway.json); and PUBLIC_URL, the dev client's
 * address (the callback Google knows locally; the dev proxy hides it). Not the database: local
 * accounts stay in memory unless DATABASE_URL is set. Returns the names filled in (never their values).
 */
export function loadDevSecrets(env: NodeJS.ProcessEnv, authDir: string): string[] {
  const filled: string[] = [];
  const set = (name: string, value: unknown) => {
    if (env[name] || typeof value !== 'string' || !value) return;
    env[name] = value;
    filled.push(name);
  };
  const read = (file: string) => {
    const path = join(authDir, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  const google = read('google.json');
  if (google) {
    const web = (JSON.parse(google) as { web?: { client_id?: string; client_secret?: string } }).web ?? {};
    set('GOOGLE_CLIENT_ID', web.client_id);
    set('GOOGLE_CLIENT_SECRET', web.client_secret);
  }
  set('SESSION_SECRET', read('session-secret.txt')?.trim());
  if (filled.includes('GOOGLE_CLIENT_ID')) set('PUBLIC_URL', DEV_PUBLIC_URL);
  const railway = read('railway.json');
  if (railway) {
    for (const v of Object.values(JSON.parse(railway) as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'ADMIN_EMAILS' in v) set('ADMIN_EMAILS', (v as { ADMIN_EMAILS: unknown }).ADMIN_EMAILS);
    }
  }
  return filled;
}
