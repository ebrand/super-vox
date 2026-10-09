import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  BinaryTag,
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  TerrainGenerator,
  defaultNoiseTerrain,
  PROTOCOL_VERSION,
  decodeChunk,
  decodeClimate,
  decodeTile,
  defaultFlatGen,
  emptyChunk,
  encodeChunk,
  defaultPlateTerrain,
  voxelAt,
  weatherSeed,
  type ServerMessage,
  type TerrainStroke,
} from '@super-vox/shared';
import { buildApp } from './app.js';
import { MemoryAccountStore } from './accounts.js';
import { Auth, SESSION_COOKIE, sessionToken } from './auth.js';
import { World } from './world.js';
import { createWorld, generatorFor, readWorld, worldConfigOf } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';

let app: FastifyInstance;
let wsUrl: string;

beforeEach(async () => {
  app = await buildApp({ world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4))) });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = address.replace(/^http/, 'ws') + '/ws';
});

afterEach(async () => {
  await app.close();
});

function connect(opts: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

type Frame = { text: ServerMessage } | { binary: Uint8Array };

/** Told after every welcome (the design library, designs placed, boats, what's dropped, and laid track), and not what these tests look at: passed over. */
const AFTER_WELCOME = new Set(['designs', 'objects', 'boats', 'drops', 'tracks']);

function nextFrame(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const on = (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = data as Buffer;
      const f: Frame = isBinary ? { binary: new Uint8Array(buf) } : { text: JSON.parse(buf.toString()) as ServerMessage };
      if ('text' in f && AFTER_WELCOME.has(f.text.type)) return;
      ws.off('message', on);
      resolve(f);
    };
    ws.on('message', on);
    ws.once('error', reject);
  });
}

async function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  const f = await nextFrame(ws);
  if (!('text' in f)) throw new Error('expected a text frame');
  return f.text;
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!done()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function greeted(opts: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  const ws = await connect(opts);
  // (Welcome, then the designs, where they're placed, the boats, laid track, and what's dropped: the last thing sent unasked.)
  const placed = new Promise<void>((resolve) => {
    const on = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary || (JSON.parse(String(data)) as ServerMessage).type !== 'drops') return;
      ws.off('message', on);
      resolve();
    };
    ws.on('message', on);
  });
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  expect((await reply).type).toBe('welcome');
  await placed;
  return ws;
}

describe('HTTP', () => {
  it('serves a closer look at part of the map, matching the whole map where they meet', async () => {
    const whole = await app.inject({ method: 'GET', url: '/api/world/map?width=64' });
    const w = new DataView(whole.rawPayload.buffer, whole.rawPayload.byteOffset);
    const cols = w.getUint16(0, true), step = w.getUint32(4, true);
    // The first 8 x 4 cells at the same step: the same samples.
    const part = await app.inject({ method: 'GET', url: `/api/world/map/area?x0=0&z0=0&step=${step}&cols=8&rows=4` });
    expect(part.statusCode).toBe(200);
    const p = new DataView(part.rawPayload.buffer, part.rawPayload.byteOffset);
    expect([p.getUint16(0, true), p.getUint16(2, true), p.getUint32(4, true)]).toEqual([8, 4, step]);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) expect(p.getInt16(12 + (i + 8 * j) * 2, true)).toBe(w.getInt16(12 + (i + cols * j) * 2, true));
    for (const bad of ['step=8&cols=4&rows=4', 'step=16&cols=513&rows=4', 'step=16&cols=4&rows=0', 'step=16.5&cols=4&rows=4']) {
      expect((await app.inject({ method: 'GET', url: `/api/world/map/area?x0=0&z0=0&${bad}` })).statusCode).toBe(400);
    }
  });

  it('serves the built client, when given one, beside the API', async () => {
    await app.close();
    const dir = mkdtempSync(join(tmpdir(), 'super-vox-client-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>menu</title>');
      writeFileSync(join(dir, 'play.html'), '<!doctype html><title>play</title>');
      writeFileSync(join(dir, 'assets', 'main-abc123.js'), 'console.log(1)');
      app = await buildApp({ world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4))), clientDir: dir });
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('menu');
      expect(index.headers['cache-control']).toBe('no-cache');
      const play = await app.inject({ method: 'GET', url: '/play.html?world=x' });
      expect(play.body).toContain('play');
      const js = await app.inject({ method: 'GET', url: '/assets/main-abc123.js' });
      expect(js.statusCode).toBe(200);
      expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ok: true });
      expect((await app.inject({ method: 'GET', url: '/nope.html' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/../package.json' })).statusCode).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION, environment: 'development' });
  });
});

describe('world map', () => {
  it('returns surface samples for the whole world', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/world/map?width=256' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    const buf = new Uint8Array(res.rawPayload);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const cols = v.getUint16(0, true), rows = v.getUint16(2, true), step = v.getUint32(4, true);
    expect([cols, rows, step]).toEqual([256, 256, 1000]);
    expect(v.getInt32(8, true)).toBe(-(2 ** 31)); // flat test world: no sea
    expect(buf.byteLength).toBe(12 + cols * rows * 3);
    // Flat world at resolution 4: ground top at y = 0, grass on top.
    expect(v.getInt16(12, true)).toBe(0);
    expect(buf[12 + cols * rows * 2]).toBe(3);
  });

  it('rejects silly sizes', async () => {
    for (const width of ['10', '5000', 'abc']) {
      expect((await app.inject({ method: 'GET', url: `/api/world/map?width=${width}` })).statusCode).toBe(400);
    }
  });
});

describe('WebSocket handshake', () => {
  it('compresses messages for clients that ask (browsers do), and they arrive intact', async () => {
    const ws = await greeted();
    expect(ws.extensions).toContain('permessage-deflate');
    const before = (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
    const frame = nextFrame(ws);
    ws.send(JSON.stringify({ type: 'requestChunk', cx: 500, cy: -1, cz: 500 }));
    const f = await frame;
    if (!('binary' in f)) throw new Error('expected binary');
    expect(decodeChunk(f.binary.subarray(1))).toMatchObject({ cx: 500, cy: -1, cz: 500 });
    // Far fewer bytes came over the wire than the chunk holds.
    expect((ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead - before).toBeLessThan(f.binary.length / 4);
    ws.close();
  });

  it('answers hello with welcome and the world config', async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    expect(await reply).toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      world: FLAT_WORLD_16KM,
      spawn: { x: 128_000, y: 0, z: 128_000 },
      tolerance: null,
      seaLevel: null,
      clock: expect.objectContaining({ dayMinutes: 24, frozen: false }),
      serverTime: expect.any(Number),
      // No sign-in on this server: anyone may edit.
      player: null,
      canEdit: true,
      // (Worlds are survival unless made creative.)
      mode: 'survival',
      // Its weather, worked out from this and the time (see weather.ts).
      weather: { seed: weatherSeed('default') },
    });
    ws.close();
  });

  it('rejects malformed messages without closing', async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send('garbage');
    expect(await reply).toMatchObject({ type: 'error', code: 'bad_message' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('closes on protocol mismatch', async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(await reply).toMatchObject({ type: 'error', code: 'protocol_mismatch' });
    expect(await closed).toBe(1002);
  });
});

describe('chunk requests', () => {
  it('refuses chunk requests before hello', async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'requestChunk', cx: 0, cy: -1, cz: 0 }));
    expect(await reply).toMatchObject({ type: 'error', code: 'not_ready' });
    ws.close();
  });

  it('sends the generated chunk as a tagged binary frame', async () => {
    const ws = await greeted();
    const reply = nextFrame(ws);
    ws.send(JSON.stringify({ type: 'requestChunk', cx: 10, cy: -1, cz: 20 }));
    const frame = await reply;
    if (!('binary' in frame)) throw new Error(`expected binary, got ${JSON.stringify(frame)}`);
    expect(frame.binary[0]).toBe(BinaryTag.Chunk);
    const expected = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)).generateChunk({ cx: 10, cy: -1, cz: 20 });
    expect(decodeChunk(frame.binary.subarray(1))).toEqual(expected);
    ws.close();
  });

  it('answers out-of-world chunks with chunkUnavailable and keeps the connection', async () => {
    const ws = await greeted();
    for (const c of [{ cx: -1, cy: 0, cz: 0 }, { cx: 0, cy: 9999, cz: 0 }, { cx: 0, cy: 0, cz: 1000 }]) {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'requestChunk', ...c }));
      expect(await reply).toEqual({ type: 'chunkUnavailable', ...c });
    }
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('answers many requests in order', async () => {
    const ws = await greeted();
    const coords = Array.from({ length: 50 }, (_, i) => ({ cx: i, cy: -1 - (i % 3), cz: 7 }));
    const received: Frame[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (data, isBinary) => {
        received.push(isBinary ? { binary: new Uint8Array(data as Buffer) } : { text: JSON.parse(String(data)) });
        if (received.length === coords.length) resolve();
      });
    });
    for (const c of coords) ws.send(JSON.stringify({ type: 'requestChunk', ...c }));
    await done;
    received.forEach((f, i) => {
      if (!('binary' in f)) throw new Error('expected binary frame');
      const chunk = decodeChunk(f.binary.subarray(1));
      expect({ cx: chunk.cx, cy: chunk.cy, cz: chunk.cz }).toEqual(coords[i]);
    });
    ws.close();
  });
});

describe('tiles and columns', () => {
  it('answers tile requests with a tagged tile frame, or tileUnavailable', async () => {
    const ws = await greeted();
    const frame = nextFrame(ws);
    ws.send(JSON.stringify({ type: 'requestTile', level: 2, tx: 100, tz: 100 }));
    const f = await frame;
    if (!('binary' in f)) throw new Error('expected binary');
    expect(f.binary[0]).toBe(BinaryTag.Tile);
    expect(decodeTile(f.binary.subarray(1))).toMatchObject({ level: 2, tx: 100, tz: 100 });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'requestTile', level: 2, tx: -5, tz: 0 }));
    expect(await reply).toEqual({ type: 'tileUnavailable', level: 2, tx: -5, tz: 0 });
    ws.close();
  });

  it("answers column requests with the height range, then the column's chunks", async () => {
    const ws = await greeted();
    const frames: Frame[] = [];
    ws.on('message', (data, isBinary) => frames.push(isBinary ? { binary: new Uint8Array(data as Buffer) } : { text: JSON.parse(String(data)) as ServerMessage }));
    ws.send(JSON.stringify({ type: 'requestColumn', cx: 3, cz: 4 }));
    ws.send(JSON.stringify({ type: 'requestColumn', cx: -3, cz: 4 }));
    ws.send(JSON.stringify({ type: 'requestColumn', cx: 5, cz: 4 }));
    await until(() => frames.length >= 11); // (all of them: the 11 below)
    const seen = frames.map((f) => ('text' in f ? f.text : (({ cx, cy, cz }) => ({ chunk: [cx, cy, cz] }))(decodeChunk(f.binary.subarray(1)))));
    // Flat ground at 0: rendered layers -1..0, and one more either side to mesh against. Each
    // column's chunks come before the next column.
    expect(seen).toEqual([
      { type: 'column', cx: 3, cz: 4, minY: 0, maxY: 0, sent: [{ lo: -2, hi: 1 }] },
      { chunk: [3, -2, 4] }, { chunk: [3, -1, 4] }, { chunk: [3, 0, 4] }, { chunk: [3, 1, 4] },
      { type: 'column', cx: -3, cz: 4, minY: null, maxY: null },
      { type: 'column', cx: 5, cz: 4, minY: 0, maxY: 0, sent: [{ lo: -2, hi: 1 }] },
      { chunk: [5, -2, 4] }, { chunk: [5, -1, 4] }, { chunk: [5, 0, 4] }, { chunk: [5, 1, 4] },
    ]);
    ws.close();
  });

  it('sends only the surface layers of a deep-sea column, and the ground within sight', async () => {
    await app.close();
    // Flat ground, but the columns say: sea floor 200 m (or, at cx 1, 50 m) under the surface at 0.
    const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4));
    Object.assign(gen, { columnRange: (cx: number) => ({ minY: (cx === 1 ? -60 : -215) * 16, maxY: 0, solidTop: (cx === 1 ? -50 : -200) * 16, water: { min: 0, max: 0 } }) });
    app = await buildApp({ world: new World(FLAT_WORLD_16KM, gen) });
    wsUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const ws = await greeted();
    const columns: ServerMessage[] = [], chunks: number[][] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) columns.push(JSON.parse(String(data)) as ServerMessage);
      else {
        const c = decodeChunk(new Uint8Array(data as Buffer).subarray(1));
        chunks.push([c.cx, c.cy]);
      }
    });
    ws.send(JSON.stringify({ type: 'requestColumn', cx: 0, cz: 4 }));
    ws.send(JSON.stringify({ type: 'requestColumn', cx: 1, cz: 4 }));
    // Deep: surface layers -1..0 and one either side. 50-60 m: floor (layer -4) and surface, joined.
    await until(() => chunks.length >= 4 + 7);
    expect(columns).toEqual([
      { type: 'column', cx: 0, cz: 4, minY: -215 * 16, maxY: 0, solidTop: -200 * 16, water: { min: 0, max: 0 }, sent: [{ lo: -2, hi: 1 }] },
      { type: 'column', cx: 1, cz: 4, minY: -60 * 16, maxY: 0, solidTop: -50 * 16, water: { min: 0, max: 0 }, sent: [{ lo: -5, hi: 1 }] },
    ]);
    expect(chunks).toEqual([...[-2, -1, 0, 1].map((cy) => [0, cy]), ...[-5, -4, -3, -2, -1, 0, 1].map((cy) => [1, cy])]);
    ws.close();
  });

  it('drops requests cancelled before they were served', async () => {
    // (Uncompressed: a compressed message is unpacked off the main thread, a moment later, by
    // when this flat world's 400 cheap chunks are all served; here it's the cancelling that's tested.)
    const ws = await greeted({ perMessageDeflate: false });
    const chunks: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const c = decodeChunk(new Uint8Array(data as Buffer).subarray(1));
      chunks.push(`${c.cx},${c.cy},${c.cz}`);
    });
    const coords = Array.from({ length: 400 }, (_, i) => ({ cx: i % 20, cy: 0, cz: Math.floor(i / 20) }));
    for (const c of coords) ws.send(JSON.stringify({ type: 'requestChunk', ...c }));
    const dropped = coords.slice(200);
    ws.send(JSON.stringify({ type: 'cancel', chunks: dropped.map((c) => [c.cx, c.cy, c.cz]), columns: [[1, 1]], tiles: [[2, 0, 0]] }));
    // Chunks are answered in the order asked, so this one comes after everything before it.
    ws.send(JSON.stringify({ type: 'requestChunk', cx: 99, cy: 0, cz: 99 }));
    const marker = '99,0,99';
    for (let i = 0; i < 500 && !chunks.includes(marker); i++) await new Promise((r) => setTimeout(r, 10));
    const before = chunks.slice(0, chunks.indexOf(marker));
    // All the wanted chunks; of the cancelled ones, only any served before the cancel arrived.
    expect(new Set(before.slice(0, 200))).toEqual(new Set(coords.slice(0, 200).map((c) => `${c.cx},${c.cy},${c.cz}`)));
    expect(before.length).toBeLessThan(300);
    ws.close();
  });
});

describe('edits', () => {
  it('applies an edit, answers the sender, and sends the new chunk to every client', async () => {
    const a = await greeted();
    const b = await greeted();
    const toA: Frame[] = [], toB: Frame[] = [];
    const collect = (ws: WebSocket, into: Frame[]) =>
      ws.on('message', (data, isBinary) =>
        into.push(isBinary ? { binary: new Uint8Array(data as Buffer) } : { text: JSON.parse(String(data)) as ServerMessage }),
      );
    collect(a, toA);
    collect(b, toB);
    a.send(JSON.stringify({ type: 'edit', id: 41, edit: { op: 'remove', x: 1000, y: -1, z: 1000 } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(toA.filter((f) => 'text' in f).map((f) => (f as { text: ServerMessage }).text)).toContainEqual({ type: 'editResult', id: 41, ok: true });
    for (const frames of [toA, toB]) {
      const bin = frames.find((f) => 'binary' in f) as { binary: Uint8Array } | undefined;
      expect(bin?.binary[0]).toBe(BinaryTag.Chunk);
      const chunk = decodeChunk(bin!.binary.subarray(1));
      expect(chunk).toMatchObject({ cx: 3, cy: -1, cz: 3 });
      expect(voxelAt(chunk, 1000 - 768, 255, 1000 - 768)).toBeNull();
    }
    // B never sent anything, so it gets no editResult.
    expect(toB.some((f) => 'text' in f && f.text.type === 'editResult')).toBe(false);
    a.close();
    b.close();
  });

  it('reports invalid edits to the sender only, with no broadcast', async () => {
    const a = await greeted();
    const reply = nextFrame(a);
    a.send(JSON.stringify({ type: 'edit', id: 9, edit: { op: 'break', x: 0, y: -1, z: 0, pieceSize: 3 } }));
    expect(await reply).toEqual({ text: { type: 'editResult', id: 9, ok: false, error: 'a 4/16 m voxel cannot be broken into 3/16 m pieces' } });
    a.close();
  });

  it('refuses edits before hello', async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'edit', id: 1, edit: { op: 'remove', x: 0, y: -1, z: 0 } }));
    expect(await reply).toMatchObject({ type: 'error', code: 'not_ready' });
    ws.close();
  });
});

describe('tolerance override', () => {
  const make = (tolerance: number) =>
    new World(
      FLAT_WORLD_16KM,
      new TerrainGenerator(FLAT_WORLD_16KM, { minVoxelSize: 1, tolerance }, new NoiseHeights(FLAT_WORLD_16KM, defaultNoiseTerrain(1))),
      { tolerance },
    );

  async function session(appOpts: Parameters<typeof buildApp>[0], hello: object) {
    const a = await buildApp(appOpts);
    const url = (await a.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(url);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const welcome = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, ...hello }));
    return { a, ws, welcome: await welcome };
  }

  it('serves the requested tolerance when the server allows overrides', async () => {
    const requested: number[] = [];
    const variants = new Map<number, World>();
    const { a, ws, welcome } = await session(
      { world: make(4), worldWithTolerance: (t) => (requested.push(t), variants.get(t) ?? variants.set(t, make(t)).get(t)!) },
      { tolerance: 0 },
    );
    expect(requested).toEqual([0]);
    expect(welcome).toMatchObject({ type: 'welcome', tolerance: 0 });
    // Chunk bytes come from the tolerance-0 world, not the default one.
    const coord = { cx: 492, cy: 0, cz: 510 };
    const frame = nextFrame(ws);
    ws.send(JSON.stringify({ type: 'requestChunk', ...coord }));
    const f = await frame;
    if (!('binary' in f)) throw new Error('expected binary');
    expect(f.binary.subarray(1)).toEqual(variants.get(0)!.getEncodedChunk(coord));
    expect(f.binary.subarray(1)).not.toEqual(make(4).getEncodedChunk(coord));
    ws.close();
    await a.close();
  });

  it('ignores requested tolerances when overrides are not enabled, and says so', async () => {
    const { a, ws, welcome } = await session({ world: make(4) }, { tolerance: 0 });
    expect(welcome).toMatchObject({ type: 'welcome', tolerance: 4 });
    ws.close();
    await a.close();
  });

  it('rejects out-of-range tolerances as malformed', async () => {
    const { a, ws, welcome } = await session({ world: make(4), worldWithTolerance: make }, { tolerance: 99 });
    expect(welcome).toMatchObject({ type: 'error', code: 'bad_message' });
    ws.close();
    await a.close();
  });
});

describe('named worlds', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A data folder with two flat worlds, "home" (resolution 4) and "other" (resolution 8). */
  async function catalogApp(dev = true, auth?: Auth) {
    const root = mkdtempSync(join(tmpdir(), 'super-vox-app-'));
    roots.push(root);
    createWorld(root, 'home', { generator: 'flat', resolution: 4 });
    createWorld(root, 'other', { generator: 'flat', resolution: 8 });
    const a = await buildApp({ catalog: new FileWorldCatalog(root, 'home', { dev }), ...(auth ? { auth } : {}) });
    const url = (await a.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    return { a, url, root };
  }
  async function hello(url: string, extra: object) {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(url);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const reply = nextMessage(ws);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, ...extra }));
    return { ws, reply: await reply, closed };
  }
  /** The top voxel's size in the chunk under the world's centre: tells the two flat worlds apart. */
  async function groundVoxelSize(ws: WebSocket) {
    const frame = nextFrame(ws);
    ws.send(JSON.stringify({ type: 'requestChunk', cx: 500, cy: -1, cz: 500 }));
    const f = await frame;
    if (!('binary' in f)) throw new Error('expected binary');
    return voxelAt(decodeChunk(f.binary.subarray(1)), 0, 255, 0)!.size;
  }

  it("lets go of a connection that stops answering pings (a tab gone without closing it), and its player", async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-vox-app-'));
    roots.push(root);
    createWorld(root, 'home', { generator: 'flat', resolution: 4 });
    const a = await buildApp({ catalog: new FileWorldCatalog(root, 'home', { dev: true }), heartbeatMs: 100 });
    const url = (await a.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    const players = async () => (await a.inject({ method: 'GET', url: '/api/dashboard' })).json().players.length as number;
    // One that answers (as browsers do) and one that doesn't.
    const alive = await hello(url, {});
    const gone = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(url, { autoPong: false });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const welcomed = nextMessage(gone);
    gone.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    expect((await welcomed).type).toBe('welcome');
    expect(await players()).toBe(2);
    const dropped = new Promise<void>((resolve) => gone.once('close', () => resolve()));
    await dropped;
    // (The server's side of the close comes a moment after the client's.)
    for (let i = 0; i < 50 && (await players()) !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await players()).toBe(1);
    // The one answering stays (well past a few pings).
    await new Promise((r) => setTimeout(r, 400));
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    expect(await players()).toBe(1);
    alive.ws.close();
  });

  it('joins the world named in hello, or the default one', async () => {
    const { a, url } = await catalogApp();
    const home = await hello(url, {});
    expect(home.reply.type).toBe('welcome');
    expect(await groundVoxelSize(home.ws)).toBe(4);
    const other = await hello(url, { world: 'other' });
    expect(other.reply.type).toBe('welcome');
    expect(await groundVoxelSize(other.ws)).toBe(8);
    home.ws.close();
    other.ws.close();
    await a.close();
  });

  it('refuses unknown worlds and malformed names', async () => {
    const { a, url } = await catalogApp();
    const unknown = await hello(url, { world: 'nope' });
    expect(unknown.reply).toMatchObject({ type: 'error', code: 'unknown_world' });
    expect(await unknown.closed).toBe(1008);
    const bad = await hello(url, { world: '../home' });
    expect(bad.reply).toMatchObject({ type: 'error', code: 'bad_message' });
    bad.ws.close();
    await a.close();
  });

  it('lists worlds and draws the map of the one asked for', async () => {
    const { a } = await catalogApp();
    const list = (await a.inject({ method: 'GET', url: '/api/worlds' })).json();
    expect(list).toMatchObject({ default: 'home', canCreate: true });
    expect(list.worlds.map((w: { name: string }) => w.name)).toEqual(['home', 'other']);
    expect((await a.inject({ method: 'GET', url: '/api/world/map?width=64&world=other' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/world/map?width=64&world=nope' })).statusCode).toBe(404);
    await a.close();
  });

  it('creates plate worlds from settings, filling in defaults, and refuses bad requests', async () => {
    const { a, url, root } = await catalogApp();
    const post = (body: object) => a.inject({ method: 'POST', url: '/api/worlds', payload: { shape: 'round-16x8', ...body } });
    const created = await post({ name: 'fresh', plates: { seed: 9, landPercent: 45, junk: true } });
    expect(created.statusCode).toBe(201);
    expect(created.json().spec.plates).toEqual({ ...defaultPlateTerrain(9), landPercent: 45 });
    expect(readWorld(root, 'fresh')!.spec).toEqual(created.json().spec);
    expect((await post({ name: 'fresh', plates: {} })).statusCode).toBe(409);
    expect((await post({ name: 'Bad Name', plates: {} })).statusCode).toBe(400);
    const invalid = await post({ name: 'bad', plates: { landPercent: 120 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/landPercent/);
    expect(readWorld(root, 'bad')).toBeNull();
    // The medium round world (32 x 16 km): made, and played on.
    const medium = await post({ name: 'medium', plates: { seed: 4 }, shape: 'round-32x16' });
    expect(medium.statusCode).toBe(201);
    expect(medium.json().spec.shape).toBe('round-32x16');
    const p = await hello(url, { world: 'medium' });
    expect(p.reply).toMatchObject({ type: 'welcome', world: { widthUnits: 32_000 * 16, depthUnits: 16_000 * 16, wrapX: true } });
    p.ws.close();
    const odd = await post({ name: 'odd', plates: {}, shape: 'round-32x32' });
    expect(odd.statusCode).toBe(400);
    expect(odd.json().error).toMatch(/round-32x16/);
    await a.close();
  });

  it('sends the world clock on joining, and changes it for everyone in the world', async () => {
    const { a, url, root } = await catalogApp();
    const home = await hello(url, {});
    const other = await hello(url, { world: 'other' });
    if (home.reply.type !== 'welcome') throw new Error('expected welcome');
    expect(home.reply.clock).toMatchObject({ dayMinutes: 24, frozen: false });
    expect(Math.abs(home.reply.serverTime - Date.now())).toBeLessThan(5000);
    const told = nextMessage(home.ws);
    const res = await a.inject({ method: 'PUT', url: '/api/worlds/home/clock', payload: { hours: 21.5, frozen: true } });
    expect(res.statusCode).toBe(200);
    const msg = await told;
    expect(msg).toMatchObject({ type: 'clock', clock: { hours: 21.5, frozen: true } });
    // Saved with the world, and only its players are told.
    expect(JSON.parse(readFileSync(join(root, 'home', 'world.json'), 'utf8')).clock).toMatchObject({ hours: 21.5, frozen: true });
    // (Only the clock counts: the other player may still be getting what follows its welcome.)
    let otherHeard = false;
    other.ws.on('message', (d, bin) => {
      if (!bin && (JSON.parse(String(d)) as { type: string }).type === 'clock') otherHeard = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(otherHeard).toBe(false);
    // Bad changes and unknown worlds.
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/home/clock', payload: { hours: 30 } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/nope/clock', payload: { hours: 3 } })).statusCode).toBe(404);
    // Regenerating the terrain keeps the clock.
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'isle', plates: { seed: 2 }, shape: 'round-16x8' } })).statusCode).toBe(201);
    await a.inject({ method: 'PUT', url: '/api/worlds/isle/clock', payload: { dayMinutes: 'real' } });
    await a.inject({ method: 'PUT', url: '/api/worlds/isle', payload: { plates: { seed: 3 }, shape: 'round-16x8' } });
    const again = await hello(url, { world: 'isle' });
    expect(again.reply.type === 'welcome' && again.reply.clock.dayMinutes).toBe('real');
    for (const s of [home.ws, other.ws, again.ws]) s.close();
  });

  it('reports players, traffic, worlds and errors on the dashboard (dev servers only)', async () => {
    const { a, url } = await catalogApp();
    const p = await hello(url, {});
    expect(p.reply.type).toBe('welcome');
    const frame = nextFrame(p.ws);
    p.ws.send(JSON.stringify({ type: 'requestChunk', cx: 500, cy: -1, cz: 500 }));
    await frame;
    p.ws.send(JSON.stringify({ type: 'pose', x: 1600, y: 32, z: -48, yaw: 1.5 }));
    const failed = nextMessage(p.ws);
    p.ws.send(JSON.stringify({ type: 'edit', id: 7, edit: { op: 'remove', x: 0, y: 4000, z: 0 } }));
    expect(await failed).toMatchObject({ type: 'editResult', ok: false });
    await new Promise((r) => setTimeout(r, 1100)); // a sample
    const res = await a.inject({ method: 'GET', url: '/api/dashboard' });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.players).toHaveLength(1);
    expect(d.players[0]).toMatchObject({ world: 'home', chunks: 1, pose: { x: 1600, y: 32, z: -48, yaw: 1.5 } });
    expect(d.players[0].bytesOut).toBeGreaterThan(0);
    expect(d.totals).toMatchObject({ chunksOut: 1, editErrors: 1 });
    expect(d.totals.messagesIn).toBeGreaterThanOrEqual(4);
    expect(d.errors.some((e: { kind: string; world?: string }) => e.kind === 'edit' && e.world === 'home')).toBe(true);
    expect(d.history.length).toBeGreaterThanOrEqual(1);
    expect(d.history.at(-1)).toMatchObject({ players: 1 });
    expect(d.history.at(-1).rssMB).toBeGreaterThan(0);
    const home = d.worlds.find((w: { name: string }) => w.name === 'home');
    expect(home).toMatchObject({ default: true, open: true, players: 1, generation: { chunks: 1 } });
    expect(home.clock.dayMinutes).toBe(24);
    expect(d.worlds.find((w: { name: string }) => w.name === 'other')).toMatchObject({ open: false, players: 0 });
    p.ws.close();
  });

  it('refuses the dashboard on production servers', async () => {
    const { a } = await catalogApp(false);
    expect((await a.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(403);
  });

  it('keeps claims: signed-in players claim plots (not over another, within the world), give up only their own', async () => {
    const secret = 'q'.repeat(40);
    const accounts = new MemoryAccountStore();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: secret, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
    const { a, root } = await catalogApp(false, auth);
    const cookieFor = async (email: string) => {
      const acct = await accounts.signIn({ sub: email, email, name: email });
      return { cookie: `${SESSION_COOKIE}=${sessionToken(acct.id, Date.now() + 1e6, secret)}`, id: acct.id };
    };
    const ann = await cookieFor('ann@x.com'), bob = await cookieFor('bob@x.com'), boss = await cookieFor('boss@x.com');
    const claim = (who: { cookie: string } | null, body: object) => a.inject({ method: 'POST', url: '/api/worlds/home/claims', payload: body, ...(who ? { headers: { cookie: who.cookie } } : {}) });
    const list = (who?: { cookie: string }) => a.inject({ method: 'GET', url: '/api/worlds/home/claims', ...(who ? { headers: { cookie: who.cookie } } : {}) });
    expect((await list()).json()).toEqual({ claims: [], you: null, canClaim: false });
    expect((await claim(null, { name: 'x', x0: 0, z0: 0, x1: 100, z1: 100 })).statusCode).toBe(403);
    const made = await claim(ann, { name: '  Ann\'s keep  ', x0: 1000, z0: 1000, x1: 1200, z1: 1100 });
    expect(made.statusCode).toBe(200);
    expect(made.json().claim).toMatchObject({ name: "Ann's keep", owner: ann.id, ownerName: 'ann@x.com', x0: 1000, x1: 1200 });
    // Over Ann's: refused, saying whose; beside it: fine.
    const over = await claim(bob, { name: 'b', x0: 1100, z0: 1050, x1: 1300, z1: 1300 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toContain("Ann's keep");
    expect((await claim(bob, { name: 'b', x0: 1200, z0: 1000, x1: 1300, z1: 1100 })).statusCode).toBe(200);
    // Too big, too small, out of the world, half metres, no name.
    for (const bad of [{ x0: 0, z0: 0, x1: 5000, z1: 100 }, { x0: 0, z0: 0, x1: 10, z1: 100 }, { x0: -10, z0: 0, x1: 100, z1: 100 }, { x0: 0.5, z0: 0, x1: 100, z1: 100 }])
      expect((await claim(ann, { name: 'x', ...bad })).statusCode).toBe(400);
    expect((await claim(ann, { name: '  ', x0: 0, z0: 0, x1: 100, z1: 100 })).statusCode).toBe(400);
    const seen = (await list(ann)).json();
    expect(seen.claims).toHaveLength(2);
    expect(seen).toMatchObject({ you: ann.id, canClaim: true });
    // Kept on disk.
    expect(JSON.parse(readFileSync(join(root, 'home', 'claims.json'), 'utf8'))).toHaveLength(2);
    // Giving up: Bob can't give up Ann's; an admin can; Ann her own.
    const annsId = made.json().claim.id as string;
    const drop = (who: { cookie: string }, id: string) => a.inject({ method: 'DELETE', url: `/api/worlds/home/claims/${id}`, headers: { cookie: who.cookie } });
    expect((await drop(bob, annsId)).statusCode).toBe(403);
    expect((await drop(ann, annsId)).statusCode).toBe(200);
    const bobs = (await list()).json().claims[0].id as string;
    expect((await drop(boss, bobs)).statusCode).toBe(200);
    expect((await list()).json().claims).toEqual([]);
  });

  it("keeps a world's picture: admins give one (a PNG, JPEG or WebP) or take it away; anyone sees it", async () => {
    const secret = 'q'.repeat(40);
    const accounts = new MemoryAccountStore();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: secret, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
    const { a, root } = await catalogApp(false, auth);
    const cookieFor = async (email: string) => {
      const acct = await accounts.signIn({ sub: email, email, name: email });
      return `${SESSION_COOKIE}=${sessionToken(acct.id, Date.now() + 1e6, secret)}`;
    };
    const ann = await cookieFor('ann@x.com'), boss = await cookieFor('boss@x.com');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    const put = (cookie: string | null, body: Buffer, type = 'image/png', world = 'home') =>
      a.inject({ method: 'PUT', url: `/api/worlds/${world}/picture`, payload: body, headers: { 'content-type': type, ...(cookie ? { cookie } : {}) } });
    const get = () => a.inject({ method: 'GET', url: '/api/worlds/home/picture' });
    expect((await get()).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: ann } })).json()).toMatchObject({ canPicture: false });
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: boss } })).json()).toMatchObject({ canPicture: true });
    expect((await put(null, png)).statusCode).toBe(403);
    expect((await put(ann, png)).statusCode).toBe(403);
    // Not an image (by its bytes, whatever it says it is), an unknown world, a type not taken.
    expect((await put(boss, Buffer.from('hello there'))).statusCode).toBe(400);
    expect((await put(boss, png, 'image/png', 'nowhere')).statusCode).toBe(404);
    expect((await put(boss, png, 'image/gif')).statusCode).toBe(415);
    expect((await put(boss, png)).statusCode).toBe(200);
    const seen = await get();
    expect(seen.statusCode).toBe(200);
    expect(seen.headers['content-type']).toBe('image/png');
    expect(Buffer.from(seen.rawPayload)).toEqual(png);
    const home = (await a.inject({ method: 'GET', url: '/api/worlds' })).json().worlds.find((w: { name: string }) => w.name === 'home');
    expect(home.pictureAt).toBeGreaterThan(0);
    // Another kind replaces it (one picture a world, on disk).
    expect((await put(boss, jpg, 'image/jpeg')).statusCode).toBe(200);
    expect((await get()).headers['content-type']).toBe('image/jpeg');
    expect(readdirSync(join(root, 'home')).filter((f) => f.startsWith('picture'))).toEqual(['picture.jpg']);
    // Taken away: the map again.
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/home/picture', headers: { cookie: ann } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/home/picture', headers: { cookie: boss } })).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/worlds' })).json().worlds.find((w: { name: string }) => w.name === 'home')).not.toHaveProperty('pictureAt');
  });

  it("keeps a claim's plan: its owner saves it (checked, inside the plot); others can't", async () => {
    const secret = 'q'.repeat(40);
    const accounts = new MemoryAccountStore();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: secret, adminEmails: [], secureCookies: false }, accounts);
    const { a } = await catalogApp(false, auth);
    const cookieFor = async (email: string) => {
      const acct = await accounts.signIn({ sub: email, email, name: email });
      return `${SESSION_COOKIE}=${sessionToken(acct.id, Date.now() + 1e6, secret)}`;
    };
    const ann = await cookieFor('ann@x.com'), bob = await cookieFor('bob@x.com');
    const id = (await a.inject({ method: 'POST', url: '/api/worlds/home/claims', payload: { name: 'keep', x0: 100, z0: 100, x1: 300, z1: 300 }, headers: { cookie: ann } })).json().claim.id as string;
    const save = (cookie: string, plan: unknown) => a.inject({ method: 'PUT', url: `/api/worlds/home/claims/${id}/plan`, payload: plan as object, headers: { cookie } });
    const plan = { elements: [{ kind: 'wall', id: 'w', x0: 110, z0: 110, x1: 200, z1: 110, thickness: 2, height: 6, extra: 'dropped' }] };
    expect((await save(bob, plan)).statusCode).toBe(403);
    expect((await save(ann, { elements: [{ ...plan.elements[0], x1: 900 }] })).statusCode).toBe(400);
    expect((await save(ann, plan)).statusCode).toBe(200);
    const claim = (await a.inject({ method: 'GET', url: '/api/worlds/home/claims' })).json().claims[0];
    expect(claim.plan).toEqual({ elements: [{ kind: 'wall', id: 'w', x0: 110, z0: 110, x1: 200, z1: 110, thickness: 2, height: 6 }] });
  });

  it('lets anyone claim on a development server without sign-in (claims belonging to no one)', async () => {
    const { a } = await catalogApp(true);
    const r = await a.inject({ method: 'POST', url: '/api/worlds/home/claims', payload: { name: 'test', x0: 0, z0: 0, x1: 64, z1: 64 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().claim).toMatchObject({ owner: null, ownerName: 'anyone' });
    expect((await a.inject({ method: 'GET', url: '/api/worlds/home/claims' })).json().canClaim).toBe(true);
    expect((await a.inject({ method: 'GET', url: '/api/worlds/nope/claims' })).statusCode).toBe(404);
  });

  it('refuses clock changes on production servers', async () => {
    const { a } = await catalogApp(false);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/home/clock', payload: { hours: 3 } })).statusCode).toBe(403);
  });

  it('lets admins, and only admins, see the dashboard, change the clock and manage worlds on production servers', async () => {
    const secret = 'q'.repeat(40);
    const accounts = new MemoryAccountStore();
    const auth = new Auth({ googleClientId: 'c', googleClientSecret: 's', sessionSecret: secret, adminEmails: ['boss@x.com'], secureCookies: false }, accounts);
    const { a } = await catalogApp(false, auth);
    const cookieFor = async (email: string) => {
      const acct = await accounts.signIn({ sub: email, email, name: email });
      return `${SESSION_COOKIE}=${sessionToken(acct.id, Date.now() + 1e6, secret)}`;
    };
    const boss = await cookieFor('boss@x.com'), ann = await cookieFor('ann@x.com');
    const dash = (cookie?: string) => a.inject({ method: 'GET', url: '/api/dashboard', ...(cookie ? { headers: { cookie } } : {}) });
    const clock = (cookie?: string) => a.inject({ method: 'PUT', url: '/api/worlds/home/clock', payload: { hours: 3 }, ...(cookie ? { headers: { cookie } } : {}) });
    expect((await dash(boss)).statusCode).toBe(200);
    expect((await clock(boss)).json().clock).toMatchObject({ dayMinutes: 24 });
    for (const who of [ann, undefined]) {
      expect((await dash(who)).statusCode).toBe(403);
      expect((await dash(who)).json()).toEqual({ error: 'the dashboard is only for admins (sign in on the menu page)' });
      expect((await clock(who)).statusCode).toBe(403);
    }
    // Creating and deleting worlds: admins only.
    const create = (cookie?: string) => a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'made', plates: { seed: 3 }, shape: 'round-16x8' }, ...(cookie ? { headers: { cookie } } : {}) });
    expect((await create(ann)).statusCode).toBe(403);
    expect((await create()).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: ann } })).json().canCreate).toBe(false);
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: boss } })).json().canCreate).toBe(true);
    expect((await create(boss)).statusCode).toBe(201);
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/made', headers: { cookie: ann } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/made', headers: { cookie: boss } })).statusCode).toBe(204);
    // Terraforming: admins only.
    expect((await create(boss)).statusCode).toBe(201);
    const shape = (cookie?: string) => a.inject({ method: 'POST', url: '/api/worlds/made/strokes', payload: { base: 0, strokes: [{ kind: 'raise', x: 3000, z: 3000, radius: 50, amount: 5, softness: 0.5 }] }, ...(cookie ? { headers: { cookie } } : {}) });
    expect((await shape(ann)).statusCode).toBe(403);
    expect((await shape()).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: ann } })).json().canTerraform).toBe(false);
    expect((await a.inject({ method: 'GET', url: '/api/worlds', headers: { cookie: boss } })).json().canTerraform).toBe(true);
    expect((await shape(boss)).json()).toEqual({ strokes: 1 });
  });

  it('serves the climate of worlds whose biomes blend, and nothing for the rest', async () => {
    const { a } = await catalogApp();
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'clim', plates: { seed: 2 }, shape: 'round-16x8' } })).statusCode).toBe(201);
    const res = await a.inject({ method: 'GET', url: '/api/world/climate?world=clim' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    const c = decodeClimate(new Uint8Array(res.rawPayload));
    // (Made round, 16 km around and 8 km north to south.)
    expect(c).toMatchObject({ cols: 500, rows: 250, cell: 512, seaLevel: 0 });
    expect(c.ecotone.degrees).toBeGreaterThan(0);
    // Flat worlds, unknown worlds, and worlds with sharp borders.
    expect((await a.inject({ method: 'GET', url: '/api/world/climate' })).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: '/api/world/climate?world=nope' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/clim', payload: { plates: { seed: 2, biomeBlend: 0 }, shape: 'round-16x8' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/world/climate?world=clim' })).statusCode).toBe(204);
  });

  it('updates a world, discarding its edits, and disconnects its players', async () => {
    const { a, url, root } = await catalogApp();
    const created = await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'isle', plates: { seed: 2 }, shape: 'round-16x8' } });
    expect(created.statusCode).toBe(201);
    const inIsle = await hello(url, { world: 'isle' });
    const inOther = await hello(url, { world: 'other' });
    expect(inIsle.reply.type).toBe('welcome');
    // "isle" has a saved edit.
    mkdirSync(join(root, 'isle', 'chunks'), { recursive: true });
    writeFileSync(join(root, 'isle', 'chunks', '0_0_0.chunk'), 'x');
    expect((await a.inject({ method: 'GET', url: '/api/worlds' })).json().worlds.find((w: { name: string }) => w.name === 'isle').editedChunks).toBe(1);
    const told = nextMessage(inIsle.ws);
    const res = await a.inject({ method: 'PUT', url: '/api/worlds/isle', payload: { plates: { seed: 2, landPercent: 55 }, shape: 'round-16x8' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'isle', editedChunks: 0, spec: { plates: { landPercent: 55 } } });
    expect(res.json().updatedAt).toBeDefined();
    expect(await told).toMatchObject({ type: 'error', code: 'world_changed' });
    expect(await inIsle.closed).toBe(1012);
    // Someone in another world is untouched.
    expect(inOther.ws.readyState).toBe(WebSocket.OPEN);
    // Rejoining gets the new terrain's world.
    const again = await hello(url, { world: 'isle' });
    expect(again.reply.type).toBe('welcome');
    for (const ws of [inOther.ws, again.ws]) ws.close();
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/nope', payload: { plates: {}, shape: 'round-16x8' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/isle', payload: { plates: { hotspots: 99 }, shape: 'round-16x8' } })).statusCode).toBe(400);
    await a.close();
  });

  it('terraforms a world (keeping clear of builds), remaking it, and its players reload', async () => {
    const { a, url, root } = await catalogApp();
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'isle', plates: { seed: 2 }, shape: 'round-16x8' } })).statusCode).toBe(201);
    // Someone has built in the chunk column at 1600..1616 m (cx = cz = 100).
    mkdirSync(join(root, 'isle', 'chunks'), { recursive: true });
    writeFileSync(join(root, 'isle', 'chunks', '100_0_100.chunk'), encodeChunk(emptyChunk({ cx: 100, cy: 0, cz: 100 })));
    const got = (await a.inject({ method: 'GET', url: '/api/worlds/isle/strokes' })).json();
    expect(got).toEqual({ strokes: [], protected: [{ cx: 100, cz: 100 }], chunkMetres: 16 });
    const inIsle = await hello(url, { world: 'isle' });
    const inOther = await hello(url, { world: 'other' });
    expect(inIsle.reply.type).toBe('welcome');
    const map = async () => (await a.inject({ method: 'GET', url: `/api/world/map/area?world=isle&x0=${2900 * 16}&z0=${2900 * 16}&step=${16 * 16}&cols=13&rows=13` })).rawPayload;
    const before = await map();
    const raise = { kind: 'raise', x: 3000, z: 3000, radius: 60, amount: 80, softness: 0.5 };
    const post = (body: object) => a.inject({ method: 'POST', url: '/api/worlds/isle/strokes', payload: body });
    // Strokes reaching the build (within the margin) are refused, naming them; nothing changes.
    const near = { kind: 'level', x: 1640, z: 1608, radius: 15, amount: 10, softness: 0 };
    const refused = await post({ base: 0, strokes: [raise, near] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().strokes).toEqual([1]);
    expect(inIsle.ws.readyState).toBe(WebSocket.OPEN);
    // Built on the wrong strokes, malformed, or none: refused.
    expect((await post({ base: 3, strokes: [raise] })).json()).toMatchObject({ stale: true });
    expect((await post({ base: 0, strokes: [{ ...raise, kind: 'melt' }] })).statusCode).toBe(400);
    expect((await post({ base: 0, strokes: [] })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/worlds/nope/strokes', payload: { base: 0, strokes: [raise] } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/worlds/other/strokes', payload: { base: 0, strokes: [raise] } })).statusCode).toBe(400);
    // Applied: stored, the world remade with it, and its players told to reload.
    const told = nextMessage(inIsle.ws);
    const ok = await post({ base: 0, strokes: [raise] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ strokes: 1 });
    expect(await told).toMatchObject({ type: 'error', code: 'world_terraformed' });
    expect(await inIsle.closed).toBe(1012);
    expect(inOther.ws.readyState).toBe(WebSocket.OPEN);
    expect(JSON.parse(readFileSync(join(root, 'isle', 'strokes.json'), 'utf8'))).toEqual([raise]);
    expect((await a.inject({ method: 'GET', url: '/api/worlds/isle/strokes' })).json().strokes).toEqual([raise]);
    expect((await a.inject({ method: 'GET', url: '/api/worlds' })).json().worlds.find((w: { name: string }) => w.name === 'isle')).toMatchObject({ strokes: 1, editedChunks: 1 });
    expect(Buffer.compare(await map(), before)).not.toBe(0);
    // More on top, then new settings: the strokes go with the old terrain.
    expect((await post({ base: 1, strokes: [{ ...raise, x: 3100 }] })).json()).toEqual({ strokes: 2 });
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/isle', payload: { plates: { seed: 2 }, shape: 'round-16x8' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/worlds/isle/strokes' })).json()).toEqual({ strokes: [], protected: [], chunkMetres: 16 });
    expect(Buffer.compare(await map(), before)).toBe(0);
    inOther.ws.close();
    await a.close();
  });

  it('creates worlds in either mode, and switches a world\'s mode (its players reload)', async () => {
    const { a, url } = await catalogApp();
    const post = (body: object) => a.inject({ method: 'POST', url: '/api/worlds', payload: { plates: { seed: 2 }, shape: 'round-16x8', ...body } });
    expect((await post({ name: 'make' })).json().mode).toBe('survival');
    expect((await post({ name: 'build', mode: 'creative' })).json().mode).toBe('creative');
    expect((await post({ name: 'odd', mode: 'peaceful' })).statusCode).toBe(400);
    const list = (await a.inject({ method: 'GET', url: '/api/worlds' })).json().worlds;
    expect(list.find((w: { name: string }) => w.name === 'build').mode).toBe('creative');
    const inMake = await hello(url, { world: 'make' });
    expect(inMake.reply).toMatchObject({ type: 'welcome', mode: 'survival' });
    const told = nextMessage(inMake.ws);
    const res = await a.inject({ method: 'PUT', url: '/api/worlds/make/mode', payload: { mode: 'creative' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'make', mode: 'creative' });
    expect(await told).toMatchObject({ type: 'error', code: 'world_mode_changed' });
    expect(await inMake.closed).toBe(1012);
    // Rejoining plays it in the new mode.
    const again = await hello(url, { world: 'make' });
    expect(again.reply).toMatchObject({ type: 'welcome', mode: 'creative' });
    expect((await a.inject({ method: 'GET', url: '/api/dashboard' })).json().worlds.find((w: { name: string }) => w.name === 'make').mode).toBe('creative');
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/make/mode', payload: { mode: 'hard' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/nope/mode', payload: { mode: 'creative' } })).statusCode).toBe(404);
    again.ws.close();
    await a.close();
  });

  it('serves terrain made on generation workers, as made here, and remade when terraformed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-vox-app-'));
    roots.push(root);
    createWorld(root, 'home', { generator: 'flat', resolution: 4 });
    const catalog = new FileWorldCatalog(root, 'home', { dev: true, generationWorkers: 2 });
    const a = await buildApp({ catalog });
    const url = (await a.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'isle', plates: { seed: 9 }, shape: 'round-16x8' } })).statusCode).toBe(201);
    const file = readWorld(root, 'isle')!;
    /** A column's message and its chunks' bytes, as the server sends them. */
    const fetchColumn = async (cx: number, cz: number) => {
      const { ws } = await hello(url, { world: 'isle' });
      const texts: ServerMessage[] = [], chunks = new Map<number, Uint8Array>();
      ws.on('message', (data, isBinary) => {
        if (!isBinary) texts.push(JSON.parse(String(data)) as ServerMessage);
        else {
          const bytes = new Uint8Array(data as Buffer).subarray(1);
          chunks.set(decodeChunk(bytes).cy, bytes);
        }
      });
      ws.send(JSON.stringify({ type: 'requestColumn', cx, cz }));
      await until(() => {
        const col = texts.find((m) => m.type === 'column');
        return !!col && col.type === 'column' && chunks.size === (col.sent ?? []).reduce((n, sp) => n + sp.hi - sp.lo + 1, 0);
      });
      ws.close();
      return { column: texts.find((m) => m.type === 'column')!, chunks };
    };
    const check = async (strokes: TerrainStroke[]) => {
      const here = generatorFor(file.spec, worldConfigOf(file.spec), strokes).generator;
      const got = await fetchColumn(438, 187);
      expect(got.column).toMatchObject(here.columnRange(438, 187));
      for (const [cy, bytes] of got.chunks) expect(bytes).toEqual(encodeChunk(here.generateChunk({ cx: 438, cy, cz: 187 })));
      return got;
    };
    const before = await check([]);
    const raise: TerrainStroke = { kind: 'raise', x: 7015, z: 3000, radius: 40, amount: 25, softness: 0.5 };
    expect((await a.inject({ method: 'POST', url: '/api/worlds/isle/strokes', payload: { base: 0, strokes: [raise] } })).statusCode).toBe(200);
    const after = await check([raise]);
    expect(after.column).not.toEqual(before.column);
    await a.close();
  });

  it('deletes worlds (not the default one) and disconnects their players', async () => {
    const { a, url, root } = await catalogApp();
    const inOther = await hello(url, { world: 'other' });
    const told = nextMessage(inOther.ws);
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/other' })).statusCode).toBe(204);
    expect(await told).toMatchObject({ type: 'error', code: 'world_deleted' });
    expect(await inOther.closed).toBe(1012);
    expect(readWorld(root, 'other')).toBeNull();
    expect((await hello(url, { world: 'other' })).reply).toMatchObject({ type: 'error', code: 'unknown_world' });
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/other' })).statusCode).toBe(404);
    const home = await a.inject({ method: 'DELETE', url: '/api/worlds/home' });
    expect(home.statusCode).toBe(409);
    expect(readWorld(root, 'home')).not.toBeNull();
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/..%2Fhome' })).statusCode).toBe(404);
    await a.close();
  });

  it('does not create worlds outside development', async () => {
    const { a, root } = await catalogApp(false);
    expect((await a.inject({ method: 'GET', url: '/api/worlds' })).json().canCreate).toBe(false);
    expect((await a.inject({ method: 'POST', url: '/api/worlds', payload: { name: 'x', plates: {}, shape: 'round-16x8' } })).statusCode).toBe(403);
    expect(readWorld(root, 'x')).toBeNull();
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/other', payload: { plates: {}, shape: 'round-16x8' } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'DELETE', url: '/api/worlds/other' })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/worlds/other/strokes', payload: { base: 0, strokes: [{ kind: 'raise', x: 1, z: 1, radius: 5, amount: 1, softness: 0 }] } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'PUT', url: '/api/worlds/other/mode', payload: { mode: 'creative' } })).statusCode).toBe(403);
    expect(readWorld(root, 'other')!.mode).not.toBe('creative');
    expect(readWorld(root, 'other')!.spec).toEqual({ generator: 'flat', resolution: 8 });
    await a.close();
  });
});
