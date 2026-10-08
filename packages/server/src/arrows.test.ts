import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ARROW, FLAT_WORLD_16KM, FlatGenerator, HOTBAR_SLOTS, Item, Material, PROTOCOL_VERSION, blockIndex, blockVoxels, decodeChunk, defaultFlatGen, playerBox, type Block, type ServerMessage } from '@super-vox/shared';
import { MemoryAccountStore } from './accounts.js';
import { ArrowFlights } from './arrowFlights.js';
import { buildApp } from './app.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { MemoryInventoryStore } from './inventories.js';
import { MobManager } from './mobManager.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

/** Flat ground: its top at y = 0. */
const flat = () => new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), {});
function block(w: World, bx: number, by: number, bz: number): Block {
  const n = 16, mod = (v: number) => ((v % n) + n) % n;
  return decodeChunk(w.getEncodedChunk({ cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) })!).blocks[blockIndex(mod(bx), mod(by), mod(bz))] ?? null;
}

describe('arrows in the world', () => {
  it('chip a 1/4 m piece out of what they hit (a bigger voxel broken down first), but not water, objects or explosives', () => {
    const w = flat();
    w.applyEdit({ op: 'place', x: 1600, y: 16, z: 1600, size: 16, material: Material.Stone });
    expect(w.chip(1600 + 5, 16 + 13, 1600 + 1, ARROW.chip)).not.toBeNull();
    const vs = blockVoxels(block(w, 100, 1, 100));
    expect(vs.length).toBe(63);
    expect(vs.every((v) => v.size === 4)).toBe(true);
    expect(vs.some((v) => v.x === 4 && v.y === 12 && v.z === 0)).toBe(false);
    // A small voxel: gone whole.
    w.applyEdit({ op: 'place', x: 1700, y: 16, z: 1700, size: 2, material: Material.Planks });
    w.chip(1701, 17, 1701, ARROW.chip);
    expect(block(w, 106, 1, 106)).toBeNull();
    // Water, explosives, objects, air: nothing.
    w.pourWater(110, 1, 110, 16);
    expect(w.chip(110 * 16 + 8, 24, 110 * 16 + 8, ARROW.chip)).toBeNull();
    w.applyEdit({ op: 'place', x: 120 * 16, y: 16, z: 120 * 16, size: 16, material: Material.TNT });
    expect(w.chip(120 * 16 + 8, 24, 120 * 16 + 8, ARROW.chip)).toBeNull();
    w.placeObject('fence', 130, 1, 130, 'n');
    expect(w.chip(130 * 16 + 8, 20, 130 * 16 + 8, ARROW.chip)).toBeNull();
    expect(w.chip(140 * 16, 40, 140 * 16, ARROW.chip)).toBeNull();
  });

  it('fly until they hit a target (never their shooter), the ground or water, or fly their time', () => {
    const w = flat();
    const flights = new ArrowFlights(w);
    const eye = [1600, 26, 1600] as const;
    const target = { id: 1_000_001, kind: 'mob' as const, box: { min: [1592, 0, 1600 - 112] as [number, number, number], max: [1608, 24, 1600 - 96] as [number, number, number] } };
    const shooter = { id: 5, kind: 'player' as const, box: playerBox([eye[0], eye[1], eye[2]]) };
    // North at full draw: through the shooter (not hit), into the mob 6 m on.
    flights.shoot(5, eye[0], eye[1], eye[2], [0, 0, -1], 1, 0);
    let stopped = flights.step(50, [shooter, target]);
    expect(stopped.length).toBe(0);
    stopped = flights.step(300, [shooter, target]);
    expect(stopped).toMatchObject([{ hit: { what: 'thing', id: 1_000_001, kind: 'mob' } }]);
    // Down at the ground: the world, its cell there.
    flights.shoot(5, eye[0], eye[1], eye[2], [0, -1, 0.2], 1, 1000);
    stopped = flights.step(1500, [shooter]);
    expect(stopped).toMatchObject([{ hit: { what: 'world' } }]);
    expect((stopped[0]!.hit as { cell: number[] }).cell[1]).toBe(-1);
    // Into water: stopped by it (as water).
    w.pourWater(100, 0, 105, 16);
    flights.shoot(5, 1608, 40, 105 * 16 + 8, [0, -1, 0], 1, 2000);
    stopped = flights.step(2500, []);
    expect(stopped).toMatchObject([{ hit: { what: 'world', water: true } }]);
    // Straight up: still climbing when its time's up.
    flights.shoot(5, eye[0], eye[1], eye[2], [0, 1, 0], 1, 3000);
    stopped = flights.step(3000 + ARROW.lifeMs + 10, []);
    expect(stopped).toMatchObject([{ hit: null }]);
    expect(flights.count).toBe(0);
  });
});

describe('arrows in play', () => {
  it('kill pigs for pork, for whoever shot them (survival)', async () => {
    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const inventories = new MemoryInventoryStore();
    const world = flat();
    let manager: MobManager | null = null;
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories, mobs: (w) => (manager = new MobManager(w, () => 0.999)) });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
      await inventories.save(ann.id, 'default@single', { items: new Map([[Item.Bow, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
      const until = async (f: () => boolean, ms = 3000) => {
        for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(ann.id, Date.now() + 1e6, SECRET)}` } });
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      await until(() => msgs.some((m) => m.type === 'inventory'));
      const eye = { x: 1600, y: 26, z: 1600 };
      ws.send(JSON.stringify({ type: 'pose', ...eye, yaw: 0 }));
      await until(() => manager !== null);
      const pig = manager!.add('pig', eye.x, 0, eye.z - 5 * 16, Date.now());
      const pork = () => new Map(msgs.filter((m): m is Extract<ServerMessage, { type: 'inventory' }> => m.type === 'inventory').at(-1)?.items ?? []).get(Item.Pork) ?? 0;
      // Two arrows (7 each: a pig has 10), each at where it is now.
      for (let n = 0; n < 2 && manager!.get(pig.id); n++) {
        const at = manager!.get(pig.id)!;
        const d = [at.x - eye.x, at.y + 8 - eye.y, at.z - eye.z];
        ws.send(JSON.stringify({ type: 'shoot', ...eye, dx: d[0], dy: d[1], dz: d[2], charge: 1 }));
        await until(() => msgs.filter((m) => m.type === 'arrowHit').length === n + 1);
        expect(msgs.filter((m): m is Extract<ServerMessage, { type: 'arrowHit' }> => m.type === 'arrowHit').at(-1)!.what).toBe('mob');
        await new Promise((r) => setTimeout(r, ARROW.cooldownMs + 50));
      }
      expect(manager!.get(pig.id)).toBeUndefined();
      await until(() => pork() > 0);
      expect(pork()).toBeGreaterThanOrEqual(1);
      expect(pork()).toBeLessThanOrEqual(3);
      ws.close();
    } finally {
      await app.close();
    }
  });

  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('are shot by those with a bow; hurt players in survival (not their shooter) and chip the world; everyone sees them', async () => {
    const SECRET = 'k'.repeat(40);
    const accounts = new MemoryAccountStore();
    const inventories = new MemoryInventoryStore();
    const world = flat();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: SECRET, adminEmails: [], secureCookies: false }, accounts);
    const app = await buildApp({ catalog: singleWorld(world, undefined, 'default', 24, 'survival'), auth, inventories });
    close = () => app.close();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const ann = await accounts.signIn({ sub: 'g-ann', email: 'ann@x.com', name: 'Ann' });
    const bob = await accounts.signIn({ sub: 'g-bob', email: 'bob@x.com', name: 'Bob' });
    await inventories.save(ann.id, 'default@single', { items: new Map([[Item.Bow, 1]]), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    await inventories.save(bob.id, 'default@single', { items: new Map(), hotbar: Array(HOTBAR_SLOTS).fill(null) });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
    };
    const join = async (id: string) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: `${SESSION_COOKIE}=${sessionToken(id, Date.now() + 1e6, SECRET)}` } });
      const msgs: ServerMessage[] = [];
      ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
      await until(() => msgs.some((m) => m.type === 'inventory'));
      return { ws, msgs };
    };
    const a = await join(ann.id), b = await join(bob.id);
    // Standing 6 m apart on the ground, facing each other.
    const annEye = { x: 1600, y: 26, z: 1600 }, bobEye = { x: 1600, y: 26, z: 1600 - 96 };
    a.ws.send(JSON.stringify({ type: 'pose', ...annEye, yaw: 0 }));
    b.ws.send(JSON.stringify({ type: 'pose', ...bobEye, yaw: Math.PI }));
    await new Promise((r) => setTimeout(r, 100));
    // Bob has no bow: nothing.
    b.ws.send(JSON.stringify({ type: 'shoot', ...bobEye, dx: 0, dy: 0, dz: 1, charge: 1 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(a.msgs.some((m) => m.type === 'arrow')).toBe(false);
    // Ann shoots Bob: both see it; it stops in him; he's hurt.
    const before = b.msgs.filter((m) => m.type === 'health').at(-1);
    a.ws.send(JSON.stringify({ type: 'shoot', ...annEye, dx: 0, dy: 0, dz: -1, charge: 1 }));
    await until(() => b.msgs.some((m) => m.type === 'arrowHit'));
    expect(a.msgs.find((m) => m.type === 'arrow')).toMatchObject({ arrow: { by: expect.any(Number), x: 1600 } });
    expect(b.msgs.find((m) => m.type === 'arrowHit')).toMatchObject({ what: 'player' });
    await until(() => b.msgs.filter((m) => m.type === 'health').at(-1) !== before);
    const health = b.msgs.filter((m): m is Extract<ServerMessage, { type: 'health' }> => m.type === 'health').at(-1)!;
    expect(health.health).toBe(health.max - ARROW.damage);
    // Not again at once (the bow's drawn again first).
    const shots = a.msgs.filter((m) => m.type === 'arrow').length;
    a.ws.send(JSON.stringify({ type: 'shoot', ...annEye, dx: 0, dy: -1, dz: 0.3, charge: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(a.msgs.filter((m) => m.type === 'arrow').length).toBe(shots);
    // At the ground, after a moment: it sticks, and chips a piece out.
    await new Promise((r) => setTimeout(r, ARROW.cooldownMs));
    a.ws.send(JSON.stringify({ type: 'shoot', ...annEye, dx: 0, dy: -1, dz: 0.3, charge: 1 }));
    await until(() => a.msgs.filter((m) => m.type === 'arrowHit').length === 2);
    const hit = a.msgs.filter((m): m is Extract<ServerMessage, { type: 'arrowHit' }> => m.type === 'arrowHit').at(-1)!;
    expect(hit.what).toBe('world');
    const bx = Math.floor(hit.x / 16), bz = Math.floor((hit.z - 0.01) / 16);
    expect(blockVoxels(block(world, bx, -1, bz)).length).toBeLessThan(64);
    // Too far from where she is: refused.
    a.ws.send(JSON.stringify({ type: 'shoot', x: annEye.x + 200, y: annEye.y, z: annEye.z, dx: 0, dy: 0, dz: -1, charge: 1 }));
    await new Promise((r) => setTimeout(r, ARROW.cooldownMs + 100));
    expect(a.msgs.filter((m) => m.type === 'arrow').length).toBe(shots + 1);
    a.ws.close();
    b.ws.close();
  });
});
