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
  defaultFlatGen,
  type ServerMessage,
} from '@super-vox/shared';
import { buildApp } from './app.js';
import { World } from './world.js';

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

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

type Frame = { text: ServerMessage } | { binary: Uint8Array };

function nextFrame(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => {
      const buf = data as Buffer;
      resolve(isBinary ? { binary: new Uint8Array(buf) } : { text: JSON.parse(buf.toString()) as ServerMessage });
    });
    ws.once('error', reject);
  });
}

async function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  const f = await nextFrame(ws);
  if (!('text' in f)) throw new Error('expected a text frame');
  return f.text;
}

async function greeted(): Promise<WebSocket> {
  const ws = await connect();
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  expect((await reply).type).toBe('welcome');
  return ws;
}

describe('HTTP', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });
});

describe('WebSocket handshake', () => {
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
