import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, UNITS_PER_METER } from '@super-vox/shared';
import { buildApp } from './app.js';
import { createWorld } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';
import type { World } from './world.js';

const M = UNITS_PER_METER;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Garbage collected (the suite runs with --expose-gc: see vitest.config.ts), a few times over. */
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    (globalThis as { gc?: () => void }).gc!();
    await sleep(100);
  }
};

describe('worlds let go of', () => {
  it('once closed idle, or terraformed away, with what was kept for them (it held each, and its terrain, for good)', async () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function');
    const root = mkdtempSync(join(tmpdir(), 'super-vox-letgo-'));
    roots.push(root);
    createWorld(root, 'home', { generator: 'flat', resolution: 4 });
    const catalog = new FileWorldCatalog(root, 'home', { dev: true });
    const a = await buildApp({ catalog, idleWorldMs: 400 });
    const url = (await a.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'isle', plates: { seed: 9 }, shape: 'round-16x8' } })).statusCode).toBe(201);
    /** Someone in isle a while (its mobs, villages, outlaws and trains ticking for it), then gone; the world they were in. */
    const visit = async (also?: () => Promise<void>): Promise<WeakRef<World>> => {
      const ws = new WebSocket(url);
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, world: 'isle' }));
      for (let i = 0; i < 200 && !catalog.openWorlds().some((o) => o.name === 'isle'); i++) await sleep(20);
      const ref = (() => new WeakRef(catalog.openWorlds().find((o) => o.name === 'isle')!.world))();
      ws.send(JSON.stringify({ type: 'pose', x: 7015 * M, y: 40 * M, z: 3000 * M, yaw: 0 }));
      await sleep(1500);
      await also?.();
      ws.close();
      return ref;
    };
    const idle = await visit();
    for (let i = 0; i < 100 && catalog.openWorlds().some((o) => o.name === 'isle'); i++) await sleep(50);
    expect(catalog.openWorlds().some((o) => o.name === 'isle')).toBe(false);
    await sleep(1000);
    await collect();
    expect(idle.deref()).toBeUndefined();
    // Reshaped while someone's in it: the world it was, let go of (the one it's now, open).
    const reshaped = await visit(async () => {
      const r = await a.inject({ method: 'POST', url: '/api/worlds/isle/strokes', payload: { base: 0, strokes: [{ kind: 'raise', x: 7015, z: 3000, radius: 40, amount: 25, softness: 0.5 }] } });
      expect(r.statusCode).toBe(200);
    });
    await sleep(1000);
    await collect();
    expect(reshaped.deref()).toBeUndefined();
    await a.close();
  }, 60_000);
});
