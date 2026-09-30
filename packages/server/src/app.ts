import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  type ServerMessage,
  type WorldConfig,
} from '@super-vox/shared';

export interface AppOptions {
  world: WorldConfig;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMessage) => socket.send(encodeMessage(msg));

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
          send({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, world: opts.world });
          break;
      }
    });
  });

  return app;
}
