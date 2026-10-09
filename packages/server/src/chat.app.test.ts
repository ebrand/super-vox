import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Item, PROTOCOL_VERSION, RATE_COUNT, UNITS_PER_METER, defaultFlatGen, type ChatLine, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { ChatStore } from './chatStore.js';
import { MemoryInventoryStore, starterInventory } from './inventories.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

const SECRET = 'k'.repeat(40);
/** What the single world's players are filed under (see inventoryKeyOf). */
const KEY = 'default@single';
const M = UNITS_PER_METER;

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

/** A flat survival world with sign-in: Boss an admin; Ann and Bob with radios; Cat and Dan without. */
async function setup() {
  const accounts = new MemoryAccountStore(), inventories = new MemoryInventoryStore();
  const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)));
  const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
  app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, chat: new ChatStore(null) });
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
  const account = async (name: string, radio: boolean) => {
    const a = await accounts.signIn({ sub: name, email: `${name.toLowerCase()}@x.com`, name }, name === 'Boss' ? 'admin' : 'builder');
    const inv = starterInventory();
    if (radio) inv.items.set(Item.Radio, 1);
    await inventories.save(a.id, KEY, inv);
    return { id: a.id, cookie: `${SESSION_COOKIE}=${sessionToken(a.id, Date.now() + 1e6, SECRET)}` };
  };
  return { url, account };
}

/** A connection (signed in, or not: `cookie` null), standing at (x, z) m, collecting its chat. */
async function player(url: string, cookie: string | null, x: number, z: number) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  const until = async (f: () => boolean, ms = 3000) => {
    for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 120)}`);
  };
  await until(() => msgs.some((m) => m.type === (cookie ? 'inventory' : 'welcome')));
  ws.send(JSON.stringify({ type: 'pose', x: x * M, y: 10 * M, z: z * M, yaw: 0 }));
  await new Promise((r) => setTimeout(r, 30));
  const lines = (): ChatLine[] => msgs.flatMap((m) => (m.type === 'chat' ? m.lines : []));
  return {
    ws,
    msgs,
    until,
    lines,
    texts: (kind?: ChatLine['kind']) => lines().filter((l) => !kind || l.kind === kind).map((l) => l.text),
    say: (text: string) => ws.send(JSON.stringify({ type: 'chat', text })),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('chat by radio', () => {
  it('with a radio: everyone with one hears it, near or far; without: only those near (radio or not)', async () => {
    const { url, account } = await setup();
    const [annA, bobA, catA, danA] = [await account('Ann', true), await account('Bob', true), await account('Cat', false), await account('Dan', false)];
    const ann = await player(url, annA.cookie, 1000, 1000), bob = await player(url, bobA.cookie, 5000, 5000);
    // Cat comes: radios hear it (Ann, Bob); not Cat herself.
    const cat = await player(url, catA.cookie, 1010, 1000), dan = await player(url, danA.cookie, 9000, 9000);
    await ann.until(() => ann.texts('join').includes('Cat joined'));
    await bob.until(() => bob.texts('join').includes('Dan joined'));
    expect(cat.texts('join')).not.toContain('Cat joined');
    // Ann (radio): Bob far off hears (by radio); Cat beside her hears (aloud, no radio); Dan far, no radio: not.
    ann.say('hello  everyone');
    await bob.until(() => bob.texts('say').includes('hello everyone'));
    await cat.until(() => cat.texts('say').includes('hello everyone'));
    expect(bob.lines().find((l) => l.text === 'hello everyone')).toMatchObject({ from: 'Ann', radio: true });
    expect(ann.texts('say')).toContain('hello everyone');
    // Cat (no radio): Ann, near, hears; Bob, far (radio or not), doesn't.
    cat.say('can anyone hear me?');
    await ann.until(() => ann.texts('say').includes('can anyone hear me?'));
    expect(ann.lines().find((l) => l.text === 'can anyone hear me?')).toMatchObject({ from: 'Cat', radio: false });
    // Dan (no radio, no one near): told so.
    dan.say('hello?');
    await dan.until(() => dan.texts('info').some((t) => /no one's near enough/.test(t)));
    await settle();
    expect(bob.texts('say')).not.toContain('can anyone hear me?');
    expect(bob.texts('say')).not.toContain('hello?');
    expect(ann.texts('say')).not.toContain('hello?');
    // Leaving: radios hear it.
    dan.ws.close();
    await ann.until(() => ann.texts('leave').includes('Dan left'));
    for (const p of [ann, bob, cat]) p.ws.close();
  });

  it('/msg: by radio, both of them; /help; history for those joining with a radio', async () => {
    const { url, account } = await setup();
    const [annA, bobA, catA] = [await account('Ann', true), await account('Bob', true), await account('Cat', false)];
    const ann = await player(url, annA.cookie, 1000, 1000), bob = await player(url, bobA.cookie, 5000, 5000), cat = await player(url, catA.cookie, 1010, 1000);
    ann.say('/msg bob meet at the tower');
    await bob.until(() => bob.texts('private').includes('meet at the tower'));
    expect(bob.lines().find((l) => l.kind === 'private')).toMatchObject({ from: 'Ann', to: 'Bob' });
    expect(ann.texts('private')).toContain('meet at the tower');
    ann.say('/msg Cat psst');
    await ann.until(() => ann.texts('info').some((t) => /Cat has no radio/.test(t)));
    cat.say('/msg Ann hi');
    await cat.until(() => cat.texts('info').some((t) => /need a radio/.test(t)));
    await settle();
    expect(cat.texts('private')).toEqual([]);
    cat.say('/help');
    await cat.until(() => cat.texts('info').some((t) => /radio/.test(t) && /msg/.test(t)));
    // What's said by radio, kept: Bob back again hears it (not the private one, nor Cat's aloud).
    ann.say('the bridge is done');
    await bob.until(() => bob.texts('say').includes('the bridge is done'));
    bob.ws.close();
    const again = await player(url, bobA.cookie, 5000, 5000);
    await again.until(() => again.msgs.some((m) => m.type === 'chat' && m.history === true));
    const history = (again.msgs.find((m) => m.type === 'chat' && m.history) as Extract<ServerMessage, { type: 'chat' }>).lines;
    expect(history.map((l) => l.text)).toEqual(['the bridge is done']);
    // Cat joining again (no radio): no history.
    cat.ws.close();
    const catAgain = await player(url, catA.cookie, 1010, 1000);
    await settle();
    expect(catAgain.msgs.some((m) => m.type === 'chat' && m.history)).toBe(false);
    for (const p of [ann, again, catAgain]) p.ws.close();
  });

  it('not for those not signed in; a few lines at a time; muted by an admin: not at all, at once', async () => {
    const { url, account } = await setup();
    const [boss, annA] = [await account('Boss', true), await account('Ann', true)];
    const guest = await player(url, null, 1000, 1000), ann = await player(url, annA.cookie, 1000, 1000);
    guest.say('hi');
    await guest.until(() => guest.texts('info').some((t) => /sign in/.test(t)));
    for (let i = 0; i <= RATE_COUNT; i++) ann.say(`line ${i}`);
    await ann.until(() => ann.texts('info').some((t) => /slow down/.test(t)));
    expect(ann.texts('say').length).toBe(RATE_COUNT);
    const res = await app.inject({ method: 'PATCH', url: `/api/players/${annA.id}`, headers: { cookie: boss.cookie }, payload: { muted: true } });
    expect(res.json()).toMatchObject({ player: { muted: true } });
    await ann.until(() => ann.texts('info').some((t) => /muted you/.test(t)));
    await new Promise((r) => setTimeout(r, 5100)); // (past the rate limit)
    ann.say('can I still talk?');
    await ann.until(() => ann.texts('info').some((t) => /you've been muted/.test(t)));
    expect(ann.texts('say')).not.toContain('can I still talk?');
    for (const p of [guest, ann]) p.ws.close();
  }, 15_000);
});
