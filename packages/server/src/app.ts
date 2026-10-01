import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import type { Auth, SignedIn } from './auth.js';
import { starterInventory, type InventoryStore } from './inventories.js';
import { PlayerInventory } from './playerInventory.js';
import {
  BinaryTag,
  EditError,
  columnSpans,
  OBJECT_ITEM,
  itemName,
  objectKindOf,
  Material,
  TABLE_REACH,
  recipeById,
  creativeHotbar,
  mergeSpans,
  type ChunkCoord,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  isValidWorldName,
  clockHours,
  isWorldShape,
  normalizeX,
  parseClockChange,
  parsePlateTerrain,
  type ServerMessage,
  type WorldShape,
} from '@super-vox/shared';
import type { WebSocket } from 'ws';
import { encodeWorldMap, type EditResult, type World } from './world.js';
import { RequestQueue } from './requestQueue.js';
import { HISTORY, Metrics, percentile } from './metrics.js';
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
) & {
  logger?: boolean;
  /** Directory of the built client (packages/client/dist) to serve at /, if any. */
  clientDir?: string;
  /** Google sign-in. With it, only signed-in players may edit; without, anyone may (development). */
  auth?: Auth;
  /** Signed-in players' inventories (see PlayerInventory); without, editing is unlimited. */
  inventories?: InventoryStore;
};

/** A connection, as the dashboard shows it. */
interface Player {
  id: number;
  world: string;
  connectedAt: number;
  tolerance: number | null;
  /** Account name, if signed in. */
  name: string | null;
  /** Last reported position (units) and heading, and when. */
  pose: { x: number; y: number; z: number; yaw: number; at: number } | null;
  chunks: number;
  tiles: number;
  edits: number;
  bytesOut: number;
}

/** Time between water flow steps. */
export const WATER_STEP_MS = 200;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyCookie);
  await app.register(websocket);
  opts.auth?.register(app);
  const catalog = 'catalog' in opts ? opts.catalog : singleWorld(opts.world, opts.worldWithTolerance);

  app.get('/api/health', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  // The pages and their bundles, from the same address as /api and /ws (production).
  if (opts.clientDir) {
    await app.register(fastifyStatic, {
      root: opts.clientDir,
      // Bundles have content hashes in their names: cache them for good; pages, briefly.
      setHeaders: (res, path) => {
        res.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

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

  // Development only (no accounts yet): what the server and its worlds are doing, for the
  // dashboard page. The history holds a sample per second for the last few minutes.
  app.get('/api/dashboard', async (_req, reply) => {
    if (!catalog.create) return reply.code(403).send({ error: 'the dashboard is not enabled on this server' });
    const now = Date.now();
    const open = new Map(catalog.openWorlds().map((o) => [o.name, o.world]));
    const names = [...new Set([...catalog.list().map((w) => w.name), ...open.keys()])].sort();
    const worlds = names.map((name) => {
      const w = open.get(name);
      const clock = catalog.clock(name);
      const base = {
        name,
        default: name === catalog.defaultName,
        open: !!w,
        players: [...players.values()].filter((p) => p.world === name).length,
        diskBytes: catalog.diskBytes(name),
        clock: clock && { hours: clockHours(clock, now), dayMinutes: clock.dayMinutes, frozen: clock.frozen },
      };
      if (!w) return base;
      const st = w.stats, cache = w.cacheUse;
      const rate = (hits: number, misses: number) => (hits + misses ? hits / (hits + misses) : null);
      return {
        ...base,
        editedChunks: w.editedChunkCount,
        edits: st.edits,
        cache: { ...cache, chunkHitRate: rate(st.chunkHits, st.chunkMisses), tileHitRate: rate(st.tileHits, st.tileMisses) },
        generation: {
          chunks: st.chunkMisses,
          tiles: st.tileMisses,
          chunkMs: { p50: percentile(st.recentChunkMs, 50), p95: percentile(st.recentChunkMs, 95) },
          tileMs: { p50: percentile(st.recentTileMs, 50), p95: percentile(st.recentTileMs, 95) },
        },
        water: { pending: w.waterPending, steps: st.waterSteps, changes: st.waterChanges },
      };
    });
    return {
      now,
      startedAt: metrics.startedAt,
      protocolVersion: PROTOCOL_VERSION,
      historySeconds: HISTORY,
      totals: metrics.totals,
      history: metrics.history,
      worlds,
      players: [...players.values()].map((p) => ({ ...p })),
      errors: metrics.errors,
    };
  });

  // The worlds on this server and how each was generated.
  app.get('/api/worlds', async () => ({ default: catalog.defaultName, canCreate: catalog.create !== undefined, worlds: catalog.list() }));

  // Development only (no accounts yet): create a plate world. Body: { name, plates }.
  app.post<{ Body: unknown }>('/api/worlds', async (req, reply) => {
    if (!catalog.create) return reply.code(403).send({ error: 'creating worlds is not enabled on this server' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { name?: unknown; plates?: unknown; shape?: unknown };
    if (body.shape !== undefined && !isWorldShape(body.shape)) return reply.code(400).send({ error: 'shape must be "round-64x32", "round-16x8" or "flat-16x16"' });
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
      return reply.code(201).send(catalog.create(body.name, plates, body.shape as WorldShape | undefined));
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
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { plates?: unknown; shape?: unknown };
    if (body.shape !== undefined && !isWorldShape(body.shape)) return reply.code(400).send({ error: 'shape must be "round-64x32", "round-16x8" or "flat-16x16"' });
    let plates;
    try {
      plates = parsePlateTerrain(body.plates);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    try {
      const summary = catalog.update(name, plates, body.shape as WorldShape | undefined);
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

  const metrics = new Metrics();
  /** Greeted connections, for monitoring. */
  const players = new Map<WebSocket, Player>();
  let nextPlayer = 1;
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
  /**
   * Sends changed chunks to everyone viewing `world` (column ranges first, so clients load any
   * newly needed layers before the chunk data arrives).
   */
  const broadcast = (world: World, result: EditResult) => {
    const frames = result.changes.map((c) => frame(BinaryTag.Chunk, c.bytes));
    const columns = result.columns.map((c) => encodeMessage({ type: 'column', ...c }));
    for (const [client, w] of clients) {
      if (w !== world || client.readyState !== client.OPEN) continue;
      for (const m of columns) out(client, m);
      for (const f of frames) out(client, f);
      metrics.totals.chunksOut += frames.length;
    }
  };
  // Water flows a step five times a second in worlds someone is in.
  const flowing = setInterval(() => {
    for (const world of new Set(clients.values())) {
      const before = world.stats.waterChanges;
      const result = world.stepWater();
      metrics.totals.waterChanges += world.stats.waterChanges - before;
      if (result) broadcast(world, result);
    }
  }, WATER_STEP_MS);
  // Monitoring: a sample every second (see /api/dashboard).
  const sampling = setInterval(() => metrics.tick(players.size), 1000);
  app.addHook('onClose', async () => {
    clearInterval(flowing);
    clearInterval(sampling);
    metrics.stop();
  });
  /** Sends to a client, counting the bytes. */
  const out = (client: WebSocket, data: string | Uint8Array) => {
    client.send(data);
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    metrics.totals.bytesOut += n;
    const p = players.get(client);
    if (p) p.bytesOut += n;
  };
  const frame = (tag: number, bytes: Uint8Array) => {
    const f = new Uint8Array(1 + bytes.byteLength);
    f[0] = tag;
    f.set(bytes, 1);
    return f;
  };

  app.get('/ws', { websocket: true }, (socket, req) => {
    // Who's connecting (their session cookie came with the upgrade request).
    const whoReady: Promise<SignedIn | null> = opts.auth ? opts.auth.signedIn(req.cookies).catch(() => null) : Promise.resolve(null);
    let who: SignedIn | null = null;
    const canEdit = () => !opts.auth || who !== null;
    /** The signed-in player's inventory here; null until loaded (or without accounts). */
    let inventory: PlayerInventory | null = null;
    let inventoryLoading = false;
    const send = (msg: ServerMessage) => out(socket, encodeMessage(msg));
    const sendBinary = (tag: number, bytes: Uint8Array) => out(socket, frame(tag, bytes));
    let greeted = false;
    let world: World;
    const queue = new RequestQueue((err) => {
      metrics.error('request', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
      app.log.error(err);
    });
    /** Queues a chunk request; `front` for a column's chunks, sent ahead of other waiting columns. */
    const queueChunk = (c: ChunkCoord, lane: 'front' | 'near' = 'near') =>
      queue.add(
        `c:${c.cx},${c.cy},${c.cz}`,
        () => {
          const bytes = world.getEncodedChunk(c);
          if (!bytes) {
            send({ type: 'chunkUnavailable', ...c });
            return;
          }
          sendBinary(BinaryTag.Chunk, bytes);
          metrics.totals.chunksOut++;
          players.get(socket)!.chunks++;
        },
        lane,
      );
    socket.on('close', () => {
      queue.close();
      void inventory?.flush();
      clients.delete(socket);
      clientWorld.delete(socket);
      players.delete(socket);
    });

    socket.on('message', (data, isBinary) => {
      metrics.totals.messagesIn++;
      metrics.totals.bytesIn += Array.isArray(data) ? data.reduce((a, b) => a + b.byteLength, 0) : (data as Buffer | ArrayBuffer).byteLength;
      const msg = isBinary ? null : decodeClientMessage(data.toString());
      if (!msg) {
        metrics.error('bad_message', 'malformed message', clientWorld.get(socket));
        send({ type: 'error', code: 'bad_message', message: 'malformed message' });
        return;
      }
      switch (msg.type) {
        case 'hello':
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            metrics.error('protocol_mismatch', `client speaks protocol ${msg.protocolVersion}`);
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
              metrics.error('unknown_world', `no world named "${msg.world}"`);
              send({ type: 'error', code: 'unknown_world', message: `no world named "${msg.world}"` });
              socket.close(1008, 'unknown world');
              return;
            }
            world = w;
          }
          void whoReady.then((signedIn) => {
            if (socket.readyState !== socket.OPEN) return;
            who = signedIn;
            greeted = true;
            clients.set(socket, world);
            clientWorld.set(socket, msg.world ?? catalog.defaultName);
            players.set(socket, {
              id: nextPlayer++, world: msg.world ?? catalog.defaultName, connectedAt: Date.now(), tolerance: world.tolerance,
              name: who?.account.name ?? null, pose: null, chunks: 0, tiles: 0, edits: 0, bytesOut: 0,
            });
            send({
              type: 'welcome',
              protocolVersion: PROTOCOL_VERSION,
              world: world.config,
              spawn: world.spawn,
              tolerance: world.tolerance,
              seaLevel: world.seaLevel,
              clock: catalog.clock(msg.world)!,
              serverTime: Date.now(),
              player: who ? { name: who.account.name, admin: who.admin } : null,
              canEdit: canEdit(),
            });
            const play = catalog.play(msg.world);
            const store = opts.inventories;
            if (!who || !store || !play) return;
            const accountId = who.account.id;
            inventoryLoading = true;
            void store
              .load(accountId, play.inventoryKey)
              .then((saved) => {
                if (socket.readyState !== socket.OPEN) return;
                inventory = new PlayerInventory(play.mode, saved ?? (play.mode === 'survival' ? starterInventory() : { items: new Map(), hotbar: creativeHotbar() }), (inv) =>
                  store.save(accountId, play.inventoryKey, inv).catch((err: unknown) => {
                    metrics.error('inventory', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
                    app.log.error(err, 'saving an inventory failed');
                  }),
                );
                send(inventory.message());
              })
              .catch((err: unknown) => {
                metrics.error('inventory', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
                app.log.error(err, 'loading an inventory failed');
              })
              .finally(() => {
                inventoryLoading = false;
              });
          });
          break;

        case 'requestChunk':
        case 'requestTile':
        case 'requestColumn':
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          if (msg.type === 'requestChunk') queueChunk({ cx: msg.cx, cy: msg.cy, cz: msg.cz });
          else if (msg.type === 'requestTile') {
            const t = { level: msg.level, tx: msg.tx, tz: msg.tz };
            queue.add(`t:${t.level},${t.tx},${t.tz}`, () => {
              const bytes = world.getEncodedTile(t);
              if (!bytes) send({ type: 'tileUnavailable', ...t });
              else {
                sendBinary(BinaryTag.Tile, bytes);
                metrics.totals.tilesOut++;
                players.get(socket)!.tiles++;
              }
            }, 'far');
          } else {
            const { cx, cz } = msg;
            queue.add(`k:${cx},${cz}`, () => {
              const range = world.columnRange(cx, cz);
              // The chunks the client renders (from above the water), and those just above and
              // below (it meshes against them).
              const sent = range && mergeSpans(columnSpans(range).map((s) => ({ lo: s.lo - 1, hi: s.hi + 1 })));
              send(range ? { type: 'column', cx, cz, ...range, sent: sent! } : { type: 'column', cx, cz, minY: null, maxY: null });
              metrics.totals.columnsOut++;
              for (const s of sent ?? []) for (let cy = s.lo; cy <= s.hi; cy++) queueChunk({ cx, cy, cz }, 'front');
            });
          }
          break;

        case 'cancel':
          for (const [cx, cy, cz] of msg.chunks ?? []) queue.cancel(`c:${cx},${cy},${cz}`);
          for (const [level, tx, tz] of msg.tiles ?? []) queue.cancel(`t:${level},${tx},${tz}`);
          for (const [cx, cz] of msg.columns ?? []) queue.cancel(`k:${cx},${cz}`);
          break;

        case 'edit': {
          if (!greeted) {
            send({ type: 'error', code: 'not_ready', message: 'send hello first' });
            return;
          }
          if (!canEdit()) {
            send({ type: 'editResult', id: msg.id, ok: false, error: 'sign in to build' });
            return;
          }
          if (opts.inventories && who && !inventory) {
            send({ type: 'editResult', id: msg.id, ok: false, error: inventoryLoading ? 'still loading your inventory' : "your inventory couldn't be loaded" });
            return;
          }
          // Left-clicking any part of an object takes the whole thing down (and gives it back).
          if (msg.edit.op === 'remove') {
            const o = world.objectAt(Math.floor(msg.edit.x / 16), Math.floor(msg.edit.y / 16), Math.floor(msg.edit.z / 16));
            if (o) {
              const result = world.removeObject(o);
              metrics.totals.edits++;
              send({ type: 'editResult', id: msg.id, ok: true });
              if (inventory) {
                inventory.addItem(OBJECT_ITEM[o.kind], 1);
                send(inventory.message());
              }
              broadcast(world, result);
              return;
            }
          }
          const refused = inventory?.refuse(msg.edit);
          if (refused) {
            send({ type: 'editResult', id: msg.id, ok: false, error: refused });
            return;
          }
          let result: EditResult;
          try {
            result = world.applyEdit(msg.edit);
          } catch (err) {
            if (!(err instanceof EditError)) throw err;
            metrics.totals.editErrors++;
            metrics.error('edit', err.message, clientWorld.get(socket));
            send({ type: 'editResult', id: msg.id, ok: false, error: err.message });
            return;
          }
          metrics.totals.edits++;
          players.get(socket)!.edits++;
          send({ type: 'editResult', id: msg.id, ok: true });
          if (inventory?.apply(result.change)) send(inventory.message());
          broadcast(world, result);
          break;
        }

        case 'placeObject':
        case 'use': {
          if (!greeted) return;
          const fail = (error: string) => send({ type: 'editResult', id: msg.id, ok: false, error });
          if (!canEdit()) return fail('sign in to build');
          if (opts.inventories && who && !inventory) return fail(inventoryLoading ? 'still loading your inventory' : "your inventory couldn't be loaded");
          let result: EditResult;
          try {
            if (msg.type === 'placeObject') {
              const kind = objectKindOf(msg.item);
              if (!kind) return fail(`a ${itemName(msg.item)} isn't placed like that`);
              const why = inventory?.refuseItem(msg.item);
              if (why) return fail(why);
              result = world.placeObject(kind, msg.x, msg.y, msg.z, msg.facing);
              inventory?.addItem(msg.item, -1);
            } else {
              const o = world.objectAt(Math.floor(msg.x / 16), Math.floor(msg.y / 16), Math.floor(msg.z / 16));
              if (!o || o.kind === 'fence') return fail('nothing to open there');
              result = world.toggleObject(o);
            }
          } catch (err) {
            if (!(err instanceof EditError)) throw err;
            return fail(err.message);
          }
          metrics.totals.edits++;
          players.get(socket)!.edits++;
          send({ type: 'editResult', id: msg.id, ok: true });
          if (msg.type === 'placeObject' && inventory?.mode === 'survival') send(inventory.message());
          broadcast(world, result);
          break;
        }

        case 'craft': {
          if (!inventory) {
            send({ type: 'error', code: 'craft', message: 'sign in to craft' });
            return;
          }
          // A crafting table within reach of where the player last said they were.
          const pose = players.get(socket)?.pose;
          const recipe = recipeById(msg.recipe);
          const nearTable = !!recipe?.table && !!pose && world.materialNear(pose.x, pose.y, pose.z, TABLE_REACH, Material.CraftingTable);
          const why = inventory.craft(msg.recipe, nearTable);
          if (why) send({ type: 'error', code: 'craft', message: why });
          else send(inventory.message());
          break;
        }

        case 'setHotbar': {
          if (!inventory) return;
          const why = inventory.setHotbar(msg.hotbar);
          if (why) send({ type: 'error', code: 'bad_hotbar', message: why });
          break;
        }

        case 'pose': {
          const p = players.get(socket);
          // (Where in the world: on a round world the client's x keeps going past the seam.)
          if (p) p.pose = { x: greeted ? normalizeX(world.config, msg.x) : msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, at: Date.now() };
          break;
        }
      }
    });
  });

  return app;
}
