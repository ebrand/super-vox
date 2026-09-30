import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  BinaryTag,
  FLAT_WORLD_16KM,
  FlatGenerator,
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
  app = await buildApp({ world: new World(FLAT_WORLD_16KM, defaultFlatGen(4)) });
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
