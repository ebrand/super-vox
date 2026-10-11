import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FLAT_WORLD_16KM, FlatGenerator, defaultFlatGen } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { ADMIN_PAGES, buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
let app: FastifyInstance;
const dirs: string[] = [];
afterEach(async () => {
  await app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server (sign-in on, not a development one) serving a client of every page, each saying its name. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  dirs.push(dir);
  for (const page of ['index', 'worlds', 'account', 'settings', 'play', 'terraform', 'sites', 'claim', 'designer', 'meshes', 'animator', 'players', 'sync']) writeFileSync(join(dir, `${page}.html`), `<p>${page}</p>`);
  const accounts = new MemoryAccountStore();
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  app = await buildApp({ catalog: singleWorld(world), auth, clientDir: dir });
  const cookie = async (email: string) => {
    const a = await accounts.signIn({ sub: email, email, name: email }, 'builder');
    return `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}`;
  };
  return { boss: await cookie('boss@x.com'), ann: await cookie('ann@x.com') };
}

describe("admins' pages (objects, meshes, animations, players, terraforming, synchronizing)", () => {
  it('are served to admins only; anyone else is sent to the landing page, the other pages served to all', async () => {
    const { boss, ann } = await setup();
    const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
    for (const page of ADMIN_PAGES) {
      for (const who of [undefined, ann]) {
        const res = await get(page, who);
        expect(res.statusCode, `${page} for ${who ? 'a player' : 'no one signed in'}`).toBe(302);
        expect(res.headers.location).toBe('/?denied=1');
      }
      const res = await get(page, boss);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(page.slice(1, -5));
    }
    // Not got round by another way of writing the address.
    for (const url of ['/%64esigner.html', '/Designer.html', '//designer.html', '/./designer.html', '/x/../players.html', '/meshes.html?a=1', '/animator.html#x']) {
      const res = await get(url, ann);
      expect([302, 404], url).toContain(res.statusCode);
      if (res.statusCode === 200) throw new Error(`${url} was served`);
    }
    // The rest: for everyone.
    for (const page of ['/', '/worlds.html', '/account.html', '/settings.html', '/play.html', '/sites.html', '/claim.html']) expect((await get(page)).statusCode, page).toBe(200);
    // What the pages are told.
    expect((await get('/api/access')).json()).toEqual({ tools: false });
    expect((await get('/api/access', ann)).json()).toEqual({ tools: false });
    expect((await get('/api/access', boss)).json()).toEqual({ tools: true });
  });
});
