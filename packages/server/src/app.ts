import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  BinaryTag,
  EditError,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  type ServerMessage,
} from '@super-vox/shared';
import type { WebSocket } from 'ws';
import type { EditResult, World } from './world.js';

export interface AppOptions {
  world: World;
  /**
   * Development only: the world voxelized with a client-requested tolerance.
   * When absent, requested tolerances are ignored.
   */
  worldWithTolerance?: (tolerance: number) => World;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  /** Connected, greeted clients and the world each is viewing. */
  const clients = new Map<WebSocket, World>();
  const frame = (tag: number, bytes: Uint8Array) => {
    const f = new Uint8Array(1 + bytes.byteLength);
    f[0] = tag;
    f.set(bytes, 1);
    return f;
  };

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMessage) => socket.send(encodeMessage(msg));
    const sendBinary = (tag: number, bytes: Uint8Array) => socket.send(frame(tag, bytes));
    let greeted = false;
    let world = opts.world;
    socket.on('close', () => clients.delete(socket));

    socket.on('message', (data, isBinary) => {
      const msg = isBinary ? null : decodeClientMessage(data.toString());
      if (!msg) {
        send({ type: 'error', code: 'bad_message', message: 'malformed message' });
        return;
      }
      switch (msg.type) {
        case 'hello':
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            send({
              type: 'error',
              code: 'protocol_mismatch',
              message: `server speaks protocol ${PROTOCOL_VERSION}`,
            });
            socket.close(1002, 'protocol mismatch');
            return;
          }
          greeted = true;
          if (msg.tolerance !== undefined && opts.worldWithTolerance) {
            world = opts.worldWithTolerance(msg.tolerance);
          }
          clients.set(socket, world);
          send({
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            world: world.config,
            spawn: world.spawn,
            tolerance: world.tolerance,
          });
          break;

        case 'requestChunk': {
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          const bytes = world.getEncodedChunk(msg);
          if (!bytes) {
            send({ type: 'chunkUnavailable', cx: msg.cx, cy: msg.cy, cz: msg.cz });
            return;
          }
          sendBinary(BinaryTag.Chunk, bytes);
          break;
        }

        case 'requestTile': {
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          const bytes = world.getEncodedTile(msg);
          if (!bytes) send({ type: 'tileUnavailable', level: msg.level, tx: msg.tx, tz: msg.tz });
          else sendBinary(BinaryTag.Tile, bytes);
          break;
        }

        case 'edit': {
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          let result: EditResult;
          try {
            result = world.applyEdit(msg.edit);
          } catch (err) {
            if (!(err instanceof EditError)) throw err;
            send({ type: 'editResult', id: msg.id, ok: false, error: err.message });
            return;
          }
          send({ type: 'editResult', id: msg.id, ok: true });
          // Everyone viewing this world gets the new chunks (column ranges first, so
          // clients load any newly needed layers before the chunk data arrives).
          const frames = result.changes.map((c) => frame(BinaryTag.Chunk, c.bytes));
          const columns = result.columns.map((c) => encodeMessage({ type: 'column', ...c }));
          for (const [client, w] of clients) {
            if (w !== world || client.readyState !== client.OPEN) continue;
            for (const m of columns) client.send(m);
            for (const f of frames) client.send(f);
          }
          break;
        }

        case 'requestColumn': {
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          const range = world.columnRange(msg.cx, msg.cz);
          send({ type: 'column', cx: msg.cx, cz: msg.cz, minY: range?.minY ?? null, maxY: range?.maxY ?? null });
          break;
        }
      }
    });
  });

  return app;
}
