import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  BinaryTag,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  type ServerMessage,
} from '@super-vox/shared';
import type { World } from './world.js';

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

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMessage) => socket.send(encodeMessage(msg));
    let greeted = false;
    let world = opts.world;

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
          const frame = new Uint8Array(1 + bytes.byteLength);
          frame[0] = BinaryTag.Chunk;
          frame.set(bytes, 1);
          socket.send(frame);
          break;
        }
      }
    });
  });

  return app;
}
