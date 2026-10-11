import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, setDesigns, type ServerMessage } from '@super-vox/shared';
import { AnimationStore } from './animationStore.js';
import { buildApp } from './app.js';
import { DesignLibrary } from './designs.js';
import { MeshStore } from './meshStore.js';
import { createWorld } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';

const SECRET = 's'.repeat(40);
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setDesigns([]);
});

/** A design of one voxel of `material` (as the library keeps it). */
const design = (id: string, name: string, material: number, role?: string) => ({ id, name, size: [1, 1, 1], states: [{ name: 'a', voxels: [{ x: 0, y: 0, z: 0, size: 16, material }] }], recipe: null, ...(role ? { role } : {}) });

/** A server on its own data folder (worlds "dev" and "town"; `chunk`: what town's one saved chunk file holds), sending to `targets`. */
async function server(environment: string, chunk: string, designs: object[], targets: { name: string; url: string }[] = [], dev = true) {
  const root = mkdtempSync(join(tmpdir(), `sync-${environment}-`));
  dirs.push(root);
  createWorld(root, 'dev', { generator: 'flat', resolution: 4 });
  createWorld(root, 'town', { generator: 'flat', resolution: 4 });
  mkdirSync(join(root, 'town', 'chunks'), { recursive: true });
  writeFileSync(join(root, 'town', 'chunks', `${environment}.chunk`), chunk);
  writeFileSync(join(root, 'town', 'picture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(environment)]));
  const lib = new DesignLibrary(join(root, 'designs.json'));
  for (const d of designs) lib.put(d);
  const app = await buildApp({
    catalog: new FileWorldCatalog(root, 'dev', { dev }),
    designs: lib,
    animations: new AnimationStore(join(root, 'animations.json')),
    meshes: new MeshStore(join(root, 'meshes.json')),
    environment,
    sync: { secret: SECRET, targets },
  });
  apps.push(app);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, root, url, lib };
}

describe('synchronizing environments', () => {
  it("sends picked objects, the meshes, the animations and a world; the target backs up what it had and sends its players out of the world", async () => {
    const prod = await server('production', 'prod town', [design('hut', 'Hut', 26, 'cottage'), design('own', 'Their own', 27, 'cottage')], [], false);
    const staging = await server('staging', 'staging town', [design('hut', 'Hut (better)', 27, 'cottage'), design('shed', 'Shed', 12), design('left', 'Left here', 12)], [{ name: 'production', url: prod.url }]);
    // Someone in town on production.
    const ws = new WebSocket(prod.url.replace(/^http/, 'ws') + '/ws');
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, world: 'town' }));
    for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(msgs.some((m) => m.type === 'welcome')).toBe(true);
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));

    // What's different.
    expect((await staging.app.inject({ method: 'GET', url: '/api/sync/targets' })).json()).toEqual({ environment: 'staging', targets: [{ name: 'production', url: prod.url }], canSend: true });
    const compare = (await staging.app.inject({ method: 'GET', url: '/api/sync/compare?target=production' })).json();
    expect(compare.designs).toEqual([
      { id: 'hut', name: 'Hut (better)', role: 'cottage', status: 'differs', sharing: ['Their own'] },
      { id: 'shed', name: 'Shed', role: null, status: 'new', sharing: [] },
      { id: 'left', name: 'Left here', role: null, status: 'new', sharing: [] },
    ]);
    expect(compare.theirsOnly).toEqual([{ id: 'own', name: 'Their own', role: 'cottage' }]);
    expect(compare.meshes).toBe('same');
    expect(compare.worlds).toEqual([
      expect.objectContaining({ name: 'dev', status: 'replaces' }),
      expect.objectContaining({ name: 'town', status: 'replaces', editedChunks: 1, theirEditedChunks: 1 }),
    ]);

    // Synced: the hut and the shed (not "left"), the meshes and animations, and town.
    const run = await staging.app.inject({ method: 'POST', url: '/api/sync/run', payload: { target: 'production', designs: ['hut', 'shed'], meshes: true, animations: true, worlds: ['town'] } });
    expect(run.statusCode).toBe(200);
    const result = run.json();
    expect(result.library).toMatchObject({ designs: { hut: 'replaced', shed: 'added' }, meshes: 'replaced', animations: 'replaced' });
    expect(result.worlds).toEqual([{ name: 'town', ok: true, replaced: true, files: 3, bytes: expect.any(Number) }]);
    // The player in town was sent out, told why.
    expect(await closed).toBe(1012);
    expect(msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'world_changed', message: expect.stringMatching(/town.*updated/) });

    // Production now: the hut as staging has it, the shed, its own still there; "left" not.
    const designs = (await prod.app.inject({ method: 'GET', url: '/api/designs' })).json().designs as { id: string; name: string }[];
    expect(designs.map((d) => [d.id, d.name])).toEqual([['hut', 'Hut (better)'], ['own', 'Their own'], ['shed', 'Shed']]);
    expect(JSON.parse(readFileSync(join(prod.root, 'designs.json'), 'utf8')).designs.map((d: { id: string }) => d.id)).toEqual(['hut', 'own', 'shed']);
    // Its town: staging's, the old one in the backup with its designs as they were.
    expect(readdirSync(join(prod.root, 'town', 'chunks'))).toEqual(['staging.chunk']);
    expect(readFileSync(join(prod.root, 'town', 'picture.png')).subarray(4).toString()).toBe('staging');
    const [backup] = readdirSync(join(prod.root, '.backups'));
    expect(backup).toBe(`${result.id}-from-staging`);
    const kept = join(prod.root, '.backups', backup!);
    expect(readFileSync(join(kept, 'worlds', 'town', 'chunks', 'production.chunk'), 'utf8')).toBe('prod town');
    expect((JSON.parse(readFileSync(join(kept, 'designs.json'), 'utf8')) as { id: string; name: string }[]).map((d) => [d.id, d.name])).toEqual([['hut', 'Hut'], ['own', 'Their own']]);
    expect(existsSync(join(kept, 'meshes.json')) && existsSync(join(kept, 'animations.json'))).toBe(true);
    // Nothing left half-way.
    expect(readdirSync(prod.root).filter((e) => e.startsWith('.incoming'))).toEqual([]);
    // Town opens again, as it is now: the world listed, and a player can join it.
    const listed = (await prod.app.inject({ method: 'GET', url: '/api/worlds' })).json().worlds as { name: string }[];
    expect(listed.map((w) => w.name)).toEqual(['dev', 'town']);
    const again = new WebSocket(prod.url.replace(/^http/, 'ws') + '/ws');
    const back: ServerMessage[] = [];
    again.on('message', (d, bin) => !bin && back.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => again.once('open', r));
    again.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, world: 'town' }));
    for (let i = 0; i < 300 && !back.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(back.some((m) => m.type === 'welcome')).toBe(true);
    again.close();
  }, 30_000);

  it('takes nothing in without the secret, or a world that comes broken; sends only for admins', async () => {
    const prod = await server('production', 'prod town', [], [], false);
    const bad = await prod.app.inject({ method: 'POST', url: '/api/sync/receive/library', headers: { authorization: 'Bearer wrong', 'x-sync-id': '20261011T120000Z', 'x-sync-from': 'x' }, payload: { designs: [] } });
    expect(bad.statusCode).toBe(401);
    const none = await prod.app.inject({ method: 'POST', url: '/api/sync/receive/world/town', headers: { 'content-type': 'application/x-supervox-world', 'x-sync-id': '20261011T120000Z' }, payload: Buffer.from('x') });
    expect(none.statusCode).toBe(401);
    // A broken pack: town as it was, nothing left behind.
    const broken = await prod.app.inject({ method: 'POST', url: '/api/sync/receive/world/town', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/x-supervox-world', 'x-sync-id': '20261011T120000Z', 'x-sync-from': 'staging' }, payload: Buffer.from('not a pack') });
    expect(broken.statusCode).toBe(400);
    expect(readdirSync(join(prod.root, 'town', 'chunks'))).toEqual(['production.chunk']);
    expect(readdirSync(prod.root).filter((e) => e.startsWith('.incoming'))).toEqual([]);
    // Production isn't a development server: no one signed in is an admin there.
    expect((await prod.app.inject({ method: 'GET', url: '/api/sync/targets' })).statusCode).toBe(403);
    expect((await prod.app.inject({ method: 'POST', url: '/api/sync/run', payload: { target: 'x' } })).statusCode).toBe(403);
  });
});
