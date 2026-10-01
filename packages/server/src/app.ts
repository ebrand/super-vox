import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  BinaryTag,
  EditError,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  isValidWorldName,
  parseClockChange,
  parsePlateTerrain,
  type ServerMessage,
} from '@super-vox/shared';
import type { WebSocket } from 'ws';
import { encodeWorldMap, type EditResult, type World } from './world.js';
import { NoSuchWorldError, WorldExistsError } from './worldFile.js';
import { DefaultWorldError, singleWorld, type WorldCatalog } from './worlds.js';

export type AppOptions = (
  | { catalog: WorldCatalog }
  | {
      world: World;
      /**
       * Development only: the world voxelized with a client-requested tolerance.
       * When absent, requested tolerances are ignored.
       */
      worldWithTolerance?: (tolerance: number) => World;
    }
) & { logger?: boolean };

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);
  const catalog = 'catalog' in opts ? opts.catalog : singleWorld(opts.world, opts.worldWithTolerance);

  app.get('/api/health', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  // Top-down map of a world's generated terrain (see encodeWorldMap). ?width=64..2048 samples,
  // ?world=name (the default world when omitted).
  app.get<{ Querystring: { width?: string; world?: string } }>('/api/world/map', async (req, reply) => {
    const width = req.query.width === undefined ? 1024 : Number(req.query.width);
    if (!Number.isInteger(width) || width < 64 || width > 2048) {
      return reply.code(400).send({ error: 'width must be an integer 64..2048' });
    }
    const world = catalog.get(req.query.world);
    if (!world) return reply.code(404).send({ error: 'no such world' });
    const bytes = encodeWorldMap(world.getMap(width));
    return reply.type('application/octet-stream').send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });

  // A world's climate for blending biome colours (see encodeClimate); 204 where biomes don't
  // blend. ?world=name (the default world when omitted).
  app.get<{ Querystring: { world?: string } }>('/api/world/climate', async (req, reply) => {
    const world = catalog.get(req.query.world);
    if (!world) return reply.code(404).send({ error: 'no such world' });
    const bytes = world.getEncodedClimate();
    if (!bytes) return reply.code(204).send();
    return reply.type('application/octet-stream').send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });

  // The worlds on this server and how each was generated.
  app.get('/api/worlds', async () => ({ default: catalog.defaultName, canCreate: catalog.create !== undefined, worlds: catalog.list() }));

  // Development only (no accounts yet): create a plate world. Body: { name, plates }.
  app.post<{ Body: unknown }>('/api/worlds', async (req, reply) => {
    if (!catalog.create) return reply.code(403).send({ error: 'creating worlds is not enabled on this server' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { name?: unknown; plates?: unknown };
    if (!isValidWorldName(body.name)) {
      return reply.code(400).send({ error: 'name must be 1-64 lower-case letters, digits, "-" or "_", starting with a letter or digit' });
    }
    let plates;
    try {
      plates = parsePlateTerrain(body.plates);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    try {
      return reply.code(201).send(catalog.create(body.name, plates));
    } catch (err) {
      if (err instanceof WorldExistsError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Development only: replace a world's settings with plate settings (discarding its edits).
  // Body: { plates }.
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name', async (req, reply) => {
    if (!catalog.update) return reply.code(403).send({ error: 'changing worlds is not enabled on this server' });
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { plates?: unknown };
    let plates;
    try {
      plates = parsePlateTerrain(body.plates);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    try {
      const summary = catalog.update(name, plates);
      evict(name, 'world_changed', `the world "${name}" was regenerated with new settings`);
      return reply.send(summary);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // Development only: change a world's clock. Body: { dayMinutes?: minutes | "real", hours?: 0..24,
  // frozen?: boolean }. Everyone in the world gets the new clock.
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/clock', async (req, reply) => {
    if (!catalog.setClock) return reply.code(403).send({ error: 'changing the time is not enabled on this server' });
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    let change;
    try {
      change = parseClockChange(req.body);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    let clock;
    try {
      clock = catalog.setClock(name, change);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      throw err;
    }
    const msg = encodeMessage({ type: 'clock', clock, serverTime: Date.now() });
    for (const [client, n] of clientWorld) if (n === name && client.readyState === client.OPEN) client.send(msg);
    return reply.send({ clock, serverTime: Date.now() });
  });

  // Development only: delete a world and its edits (not the server's default world).
  app.delete<{ Params: { name: string } }>('/api/worlds/:name', async (req, reply) => {
    if (!catalog.delete) return reply.code(403).send({ error: 'changing worlds is not enabled on this server' });
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    try {
      catalog.delete(name);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      if (err instanceof DefaultWorldError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    evict(name, 'world_deleted', `the world "${name}" was deleted`);
    return reply.code(204).send();
  });

  /** Connected, greeted clients, the world each is viewing, and that world's name. */
  const clients = new Map<WebSocket, World>();
  const clientWorld = new Map<WebSocket, string>();
  /** Disconnects everyone in world `name`, telling them why (it was replaced or deleted). */
  const evict = (name: string, code: 'world_changed' | 'world_deleted', message: string) => {
    for (const [client, n] of clientWorld) {
      if (n !== name) continue;
      if (client.readyState === client.OPEN) {
        client.send(encodeMessage({ type: 'error', code, message }));
        client.close(1012, code);
      }
      clients.delete(client);
      clientWorld.delete(client);
    }
  };
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
    let world: World;
    socket.on('close', () => {
      clients.delete(socket);
      clientWorld.delete(socket);
    });

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
          {
            const w = catalog.get(msg.world, msg.tolerance);
            if (!w) {
              send({ type: 'error', code: 'unknown_world', message: `no world named "${msg.world}"` });
              socket.close(1008, 'unknown world');
              return;
            }
            world = w;
          }
          greeted = true;
          clients.set(socket, world);
          clientWorld.set(socket, msg.world ?? catalog.defaultName);
          send({
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            world: world.config,
            spawn: world.spawn,
            tolerance: world.tolerance,
            seaLevel: world.seaLevel,
            clock: catalog.clock(msg.world)!,
            serverTime: Date.now(),
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
