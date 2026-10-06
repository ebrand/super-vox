import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import type { Auth, SignedIn } from './auth.js';
import { starterInventory, type InventoryStore } from './inventories.js';
import { PlayerInventory } from './playerInventory.js';
import { MobManager } from './mobManager.js';
import {
  BinaryTag,
  CHUNK_SIZE,
  resolveChunk,
  EditError,
  columnSpans,
  ATTACK_REACH,
  PLAYER_HEALTH,
  EXHAUSTION,
  Vitals,
  fallDamage,
  isFood,
  isWater,
  WALK_SPEED,
  type DeathCause,
  UNITS_PER_METER,
  attackDamage,
  deltaX,
  BLOCK_VOLUME,
  Item,
  objectItem,
  objectName,
  designOfItem,
  itemName,
  objectKindOf,
  usable,
  isBed,
  isTool,
  advance,
  put,
  take,
  refusePut,
  stationAmong,
  objectStation,
  type PlacedObject,
  type StationKind,
  isSword,
  SWORDS,
  type ItemId,
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
  WORLD_SHAPES,
  normalizeX,
  parseClockChange,
  parsePlateTerrain,
  minedLongEnough,
  blastDamage,
  isBigEdit,
  validateStrokes,
  isGameMode,
  type GameMode,
  type SavedVitals,
  type ServerMessage,
  type WorldShape,
  MAX_CLAIMS_EACH,
  MAX_CLAIM_NAME,
  claimsOverlap,
  refuseClaimRect,
  cleanPlan,
  refusePlan,
  type Plan,
  type Claim,
} from '@super-vox/shared';
import type { WebSocket } from 'ws';
import { encodeWorldMap, type EditResult, type World } from './world.js';
import { Explosives } from './explosives.js';
import { RequestQueue } from './requestQueue.js';
import { DesignLibrary } from './designs.js';
import { HISTORY, Metrics, percentile } from './metrics.js';
import { MAX_PICTURE_BYTES, NoSuchWorldError, PICTURE_TYPES, WorldExistsError } from './worldFile.js';
import { DefaultWorldError, StaleStrokesError, StrokesOverBuildsError, singleWorld, type WorldCatalog } from './worlds.js';

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
  /** Makes a world's mob manager (tests: to place mobs themselves). */
  mobs?: (world: World) => MobManager;
  /** How often connections are pinged (ms; see HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** How long a world nobody's in or asked for stays open (ms; see IDLE_WORLD_MS). */
  idleWorldMs?: number;
  /** Survival mining times are multiplied by this (tests: to mine quickly); default 1. */
  miningTimeScale?: number;
  /** The library of designed objects (see DesignLibrary); default: an empty one in memory. */
  designs?: DesignLibrary;
  /** Which deployment this is (APP_ENV: production, staging, development), told by /api/health; default development. */
  environment?: string;
};

/** `f` of a value, at once if it's to hand, else when its promise settles (a promise of that). */
function then<T>(v: T | Promise<T>, f: (v: T) => void): void | Promise<void> {
  return v instanceof Promise ? v.then(f) : f(v);
}

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
  /** Survival: health, food and breath (see Vitals), and whether anything can hurt them (signed in, survival); what they were last told of them. */
  vitals: Vitals;
  vulnerable: boolean;
  vitalsSent: string;
  /** When they last attacked (ms). */
  lastAttack: number;
  /** Their bed (its block, 1 m block coordinates), if they've made one theirs: where they come back to after dying. */
  bed: { x: number; y: number; z: number } | null;
  /** Poses reported before this (ms) aren't kept as where they are (they've just been sent somewhere: see PLACE_SETTLE_MS). */
  settleUntil: number;
  /** Signed in: keeps their vitals and bed (see PlayerState), once they've been loaded. */
  saveState: (() => void) | null;
}

/** Time between water flow steps. */
export const WATER_STEP_MS = 200;
/**
 * How often every connection is pinged (browsers answer by themselves); one that hasn't answered,
 * or sent anything, since the last is let go of: a tab closed without its connection closing (or a
 * computer asleep) would otherwise stay a player, keeping its world open, for good.
 */
export const HEARTBEAT_MS = 30_000;
/** A full garbage collection now, where node was started with --expose-gc (as the server image is); else nothing. */
export function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}
/** How long a world nobody's in or asked for stays open (see WorldCatalog.closeIdle). */
export const IDLE_WORLD_MS = 10 * 60_000;
/** How often a signed-in player's place is saved while they play (and always when they leave). */
export const PLACE_SAVE_MS = 30_000;
/** After sending a player back where they were (or back after dying), poses from before this long are ignored (their client may still report where it was). */
export const PLACE_SETTLE_MS = 1500;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyCookie);
  // Messages compressed on the way (browsers ask for it): chunks shrink about 40x. Fast deflate
  // (in zlib's background threads), each connection keeping its window; small messages as they are.
  await app.register(websocket, {
    options: { perMessageDeflate: { zlibDeflateOptions: { level: 1 }, threshold: 1024, concurrencyLimit: 16 } },
  });
  opts.auth?.register(app);
  const catalog = 'catalog' in opts ? opts.catalog : singleWorld(opts.world, opts.worldWithTolerance);

  app.get('/api/health', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, environment: opts.environment ?? 'development' }));

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

  // TEMPORARY (cave map): where a world's caves are, roughly (see caveOverview): caving regions per
  // `cell` blocks (bits, row-major, base64) and entrances (block x, z). {caves: null} without caves.
  app.get<{ Querystring: { world?: string } }>('/api/world/caves', async (req, reply) => {
    const world = catalog.get(req.query.world);
    if (!world) return reply.code(404).send({ error: 'no such world' });
    const o = world.caveOverview();
    if (!o) return { caves: null };
    const bits = new Uint8Array(Math.ceil(o.regions.length / 8));
    o.regions.forEach((v, i) => {
      if (v) bits[i >> 3]! |= 1 << (i & 7);
    });
    return { caves: { cell: o.cell, cols: o.cols, rows: o.rows, regions: Buffer.from(bits).toString('base64'), entrances: o.entrances } };
  });

  // A closer look at part of a world's map (the zoomed-in map): cols x rows cells of `step` units
  // from (x0, z0) (units), encoded as /api/world/map. At most 512 x 512 cells, at least 1 m each.
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/world/map/area', async (req, reply) => {
    const q = req.query;
    const [x0, z0, step, cols, rows] = ['x0', 'z0', 'step', 'cols', 'rows'].map((k) => Number(q[k]));
    if (![x0, z0, step, cols, rows].every(Number.isInteger) || step! < 16 || step! > 65_536 || cols! < 1 || cols! > 512 || rows! < 1 || rows! > 512) {
      return reply.code(400).send({ error: 'x0, z0, step (16..65536), cols and rows (1..512) must be integers' });
    }
    if (Math.abs(x0!) > 2 ** 30 || Math.abs(z0!) > 2 ** 30) return reply.code(400).send({ error: 'out of range' });
    const world = catalog.get(q.world);
    if (!world) return reply.code(404).send({ error: 'no such world' });
    const bytes = encodeWorldMap(world.mapArea(x0!, z0!, step!, cols!, rows!));
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

  /**
   * Whether a request may use the operator's tools (the dashboard, changing the clock): on
   * development servers, anyone; elsewhere, signed-in admins (ADMIN_EMAILS).
   */
  const operator = async (req: FastifyRequest): Promise<boolean> => {
    if (catalog.dev) return true;
    return !!(opts.auth && (await opts.auth.signedIn(req.cookies))?.admin);
  };
  const notOperator = (what: string) => ({ error: `${what} is only for ${opts.auth ? 'admins (sign in on the menu page)' : 'development servers'}` });

  // What the server and its worlds are doing, for the dashboard page (operators only). The
  // history holds a sample per second for the last few minutes.
  app.get('/api/dashboard', async (req, reply) => {
    if (!(await operator(req))) return reply.code(403).send(notOperator('the dashboard'));
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
        mode: catalog.play(name)?.mode ?? null,
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
        disk: w.disk ? { ...w.disk.stats } : null,
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

  // The library of designed objects (see DesignLibrary), for everyone; `canEdit`: whether this
  // request may change it (operators: admins, or anyone on a development server).
  const designs = opts.designs ?? new DesignLibrary(null);
  /** Everyone connected, told the library changed. */
  const designsChanged = () => {
    const bytes = encodeMessage({ type: 'designs', designs: designs.list() });
    for (const [client] of clients) if (client.readyState === client.OPEN) out(client, bytes);
  };
  app.get('/api/designs', async (req) => ({ designs: designs.list(), canEdit: await operator(req) }));

  // Operators only: adds or replaces a design (body: the design, its id as in the URL; its item
  // number is kept or given). 400 with why, if it isn't a good one.
  app.put<{ Params: { id: string }; Body: unknown }>('/api/designs/:id', { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    if (!(await operator(req))) return reply.code(403).send(notOperator('designing objects'));
    const body = req.body as { id?: unknown } | null;
    if (typeof body !== 'object' || body === null || body.id !== req.params.id) return reply.code(400).send({ error: "the design's id must match the URL" });
    const design = designs.put(body);
    if (typeof design === 'string') return reply.code(400).send({ error: design });
    designsChanged();
    return { design };
  });

  // Operators only: takes a design out of the library (placed ones stay).
  app.delete<{ Params: { id: string } }>('/api/designs/:id', async (req, reply) => {
    if (!(await operator(req))) return reply.code(403).send(notOperator('designing objects'));
    if (!designs.delete(req.params.id)) return reply.code(404).send({ error: 'no such design' });
    designsChanged();
    return { ok: true };
  });

  // The worlds on this server and how each was generated.
  app.get('/api/worlds', async (req) => {
    const op = await operator(req);
    return { default: catalog.defaultName, canCreate: catalog.create !== undefined && op, canTerraform: catalog.terraform !== undefined && op, canPicture: catalog.savePicture !== undefined && op, worlds: catalog.list() };
  });

  // A world's picture (shown for it on the menu page in place of its map): anyone may see it;
  // operators give one (the image itself as the body: PNG, JPEG or WebP) or take it away.
  app.addContentTypeParser(Object.values(PICTURE_TYPES), { parseAs: 'buffer', bodyLimit: MAX_PICTURE_BYTES }, (_req, body, done) => done(null, body));
  app.get<{ Params: { name: string } }>('/api/worlds/:name/picture', async (req, reply) => {
    const pic = catalog.picture?.(req.params.name) ?? null;
    if (!pic) return reply.code(404).send({ error: 'no picture' });
    return reply.header('content-type', pic.type).header('cache-control', 'no-cache').send(pic.data);
  });
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/picture', { bodyLimit: MAX_PICTURE_BYTES }, async (req, reply) => {
    if (!(await operator(req)) || !catalog.savePicture) return reply.code(403).send(notOperator("changing a world's picture"));
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'send the picture itself: a PNG, JPEG or WebP image' });
    try {
      catalog.savePicture(req.params.name, req.body);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return { ok: true };
  });
  app.delete<{ Params: { name: string } }>('/api/worlds/:name/picture', async (req, reply) => {
    if (!(await operator(req)) || !catalog.savePicture) return reply.code(403).send(notOperator("changing a world's picture"));
    try {
      catalog.savePicture(req.params.name, null);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      throw err;
    }
    return { ok: true };
  });

  // A world's terraforming: its strokes, in order, and the chunk columns (16 m squares, by
  // chunk index) where players have built, which terraforming keeps clear of.
  app.get<{ Params: { name: string } }>('/api/worlds/:name/strokes', async (req, reply) => {
    const { name } = req.params;
    const strokes = isValidWorldName(name) ? catalog.strokes(name) : null;
    if (!strokes) return reply.code(404).send({ error: 'no such world' });
    return { strokes, protected: catalog.protectedColumns(name) ?? [], chunkMetres: CHUNK_SIZE / UNITS_PER_METER };
  });

  // Operators only: add strokes to a world's terraforming, and remake it with them. Body:
  // { base, strokes }: `base`, how many it had when they were drawn (409 if it has others now);
  // none may reach where players have built (409, with `strokes`: their indexes). Everyone in
  // the world reloads it.
  app.post<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/strokes', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    if (!catalog.terraform) return reply.code(403).send({ error: 'terraforming is not enabled on this server' });
    if (!(await operator(req))) return reply.code(403).send(notOperator('terraforming'));
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { base?: unknown; strokes?: unknown };
    if (typeof body.base !== 'number' || !Number.isInteger(body.base) || body.base < 0) return reply.code(400).send({ error: 'base must be a whole number' });
    try {
      validateStrokes(body.strokes);
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (body.strokes.length === 0) return reply.code(400).send({ error: 'no strokes to add' });
    let total;
    try {
      total = catalog.terraform(name, body.base, body.strokes);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      if (err instanceof StaleStrokesError) return reply.code(409).send({ error: err.message, stale: true });
      if (err instanceof StrokesOverBuildsError) return reply.code(409).send({ error: err.message, strokes: err.strokes });
      if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    evict(name, 'world_terraformed', `the land of "${name}" was reshaped`);
    return reply.send({ strokes: total });
  });

  // A world's claims (see Claim), for everyone: `you`, the asker's account id (null signed out,
  // or on a server without sign-in, where claims belong to no one), and whether they may claim.
  const claimer = async (req: FastifyRequest): Promise<{ id: string | null; name: string } | null> => {
    if (!opts.auth) return catalog.dev ? { id: null, name: 'anyone' } : null;
    const s = await opts.auth.signedIn(req.cookies);
    return s ? { id: s.account.id, name: s.account.name } : null;
  };
  app.get<{ Params: { name: string } }>('/api/worlds/:name/claims', async (req, reply) => {
    const claims = catalog.claims?.(req.params.name) ?? null;
    if (!claims) return reply.code(catalog.claims ? 404 : 403).send({ error: catalog.claims ? 'no such world' : 'claims are not kept on this server' });
    const who = await claimer(req);
    return { claims, you: who?.id ?? null, canClaim: who !== null };
  });

  // Claims a plot: body { name, x0, z0, x1, z1 } (metres). Signed-in players (anyone on a
  // development server without sign-in); not over another claim, at most MAX_CLAIMS_EACH each.
  app.post<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/claims', async (req, reply) => {
    const { name } = req.params;
    const claims = catalog.claims?.(name) ?? null;
    if (!claims || !catalog.saveClaims) return reply.code(404).send({ error: 'no such world' });
    const who = await claimer(req);
    if (!who) return reply.code(403).send({ error: 'sign in (on the menu page) to claim land' });
    const world = catalog.get(name);
    if (!world) return reply.code(404).send({ error: 'no such world' });
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const plotName = typeof b.name === 'string' ? b.name.trim().slice(0, MAX_CLAIM_NAME) : '';
    if (!plotName) return reply.code(400).send({ error: 'give it a name' });
    const rect = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 } as { x0: number; z0: number; x1: number; z1: number };
    const why = refuseClaimRect(rect, world.config.widthUnits / UNITS_PER_METER, world.config.depthUnits / UNITS_PER_METER);
    if (why) return reply.code(400).send({ error: why });
    const over = claims.find((c) => claimsOverlap(c, rect));
    if (over) return reply.code(409).send({ error: `that land overlaps "${over.name}" (${over.ownerName}'s)` });
    if (who.id !== null && claims.filter((c) => c.owner === who.id).length >= MAX_CLAIMS_EACH) return reply.code(409).send({ error: `you have ${MAX_CLAIMS_EACH} claims here already: give one up first` });
    const claim: Claim = { id: randomUUID(), name: plotName, owner: who.id, ownerName: who.name, ...rect, at: Date.now() };
    catalog.saveClaims(name, [...claims, claim]);
    return { claim };
  });

  // Saves a claim's plan (see Plan): its owner only (anyone's on a development server without
  // sign-in, where claims belong to no one). Body: the plan; 400 with why if it isn't a good one.
  app.put<{ Params: { name: string; id: string }; Body: unknown }>('/api/worlds/:name/claims/:id/plan', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { name, id } = req.params;
    const claims = catalog.claims?.(name) ?? null;
    if (!claims || !catalog.saveClaims) return reply.code(404).send({ error: 'no such world' });
    const claim = claims.find((c) => c.id === id);
    if (!claim) return reply.code(404).send({ error: 'no such claim' });
    const who = await claimer(req);
    if (!who || who.id !== claim.owner) return reply.code(403).send({ error: 'only its owner plans what goes on it' });
    const why = refusePlan(req.body, claim);
    if (why) return reply.code(400).send({ error: why });
    const plan = cleanPlan(req.body as Plan);
    catalog.saveClaims(name, claims.map((c) => (c.id === id ? { ...c, plan } : c)));
    return { ok: true };
  });

  // Gives up a claim: its owner (or an operator).
  app.delete<{ Params: { name: string; id: string } }>('/api/worlds/:name/claims/:id', async (req, reply) => {
    const { name, id } = req.params;
    const claims = catalog.claims?.(name) ?? null;
    if (!claims || !catalog.saveClaims) return reply.code(404).send({ error: 'no such world' });
    const claim = claims.find((c) => c.id === id);
    if (!claim) return reply.code(404).send({ error: 'no such claim' });
    const who = await claimer(req);
    if (!(await operator(req)) && (!who || who.id === null || who.id !== claim.owner)) return reply.code(403).send({ error: "it isn't yours to give up" });
    catalog.saveClaims(name, claims.filter((c) => c.id !== id));
    return { ok: true };
  });

  // Operators only: create a plate world. Body: { name, plates, shape?, mode? }.
  app.post<{ Body: unknown }>('/api/worlds', async (req, reply) => {
    if (!catalog.create) return reply.code(403).send({ error: 'creating worlds is not enabled on this server' });
    if (!(await operator(req))) return reply.code(403).send(notOperator('creating worlds'));
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { name?: unknown; plates?: unknown; shape?: unknown; mode?: unknown };
    if (body.shape !== undefined && !isWorldShape(body.shape)) return reply.code(400).send({ error: `shape must be one of ${Object.keys(WORLD_SHAPES).map((s) => `"${s}"`).join(', ')}` });
    if (body.mode !== undefined && !isGameMode(body.mode)) return reply.code(400).send({ error: 'mode must be "survival" or "creative"' });
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
      return reply.code(201).send(catalog.create(body.name, plates, body.shape as WorldShape | undefined, body.mode as GameMode | undefined));
    } catch (err) {
      if (err instanceof WorldExistsError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Development only: replace a world's settings with plate settings (discarding its edits).
  // Body: { plates }.
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name', async (req, reply) => {
    if (!catalog.update) return reply.code(403).send({ error: 'changing worlds is not enabled on this server' });
    if (!(await operator(req))) return reply.code(403).send(notOperator('changing worlds'));
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { plates?: unknown; shape?: unknown };
    if (body.shape !== undefined && !isWorldShape(body.shape)) return reply.code(400).send({ error: `shape must be one of ${Object.keys(WORLD_SHAPES).map((s) => `"${s}"`).join(', ')}` });
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

  // Operators only: set a world's game mode. Body: { mode }. Everyone in it reloads to play it.
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/mode', async (req, reply) => {
    if (!catalog.setMode) return reply.code(403).send({ error: 'changing worlds is not enabled on this server' });
    if (!(await operator(req))) return reply.code(403).send(notOperator('changing worlds'));
    const { name } = req.params;
    if (!isValidWorldName(name)) return reply.code(404).send({ error: 'no such world' });
    const mode = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { mode?: unknown };
    if (!isGameMode(mode.mode)) return reply.code(400).send({ error: 'mode must be "survival" or "creative"' });
    let summary;
    try {
      summary = catalog.setMode(name, mode.mode);
    } catch (err) {
      if (err instanceof NoSuchWorldError) return reply.code(404).send({ error: err.message });
      throw err;
    }
    evict(name, 'world_mode_changed', `"${name}" is now a ${mode.mode} world`);
    return reply.send(summary);
  });

  // Operators only: change a world's clock. Body: { dayMinutes?: minutes | "real", hours?: 0..24,
  // frozen?: boolean }. Everyone in the world gets the new clock.
  app.put<{ Params: { name: string }; Body: unknown }>('/api/worlds/:name/clock', async (req, reply) => {
    if (!catalog.setClock) return reply.code(403).send({ error: 'changing the time is not enabled on this server' });
    if (!(await operator(req))) return reply.code(403).send(notOperator('changing the time'));
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
    if (!(await operator(req))) return reply.code(403).send(notOperator('deleting worlds'));
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
  const evict = (name: string, code: 'world_changed' | 'world_deleted' | 'world_terraformed' | 'world_mode_changed', message: string) => {
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
  // Mobs: ten steps a second in worlds someone is in; each player sees what's within VIEW.
  const mobManagers = new Map<World, MobManager>();
  const VIEW = 96 * UNITS_PER_METER;
  const EYE = 1.62 * UNITS_PER_METER;
  const sendTo = (client: WebSocket, msg: ServerMessage) => {
    if (client.readyState === client.OPEN) out(client, encodeMessage(msg));
  };
  /** Tells a player their health, food and breath, if any changed since they were last told. */
  const sendVitals = (client: WebSocket, p: Player, force = false) => {
    const v = p.vitals, msg = { type: 'health' as const, health: v.health, max: PLAYER_HEALTH, food: v.food, air: v.bubbles };
    const key = `${msg.health},${msg.food},${msg.air}`;
    if (!force && key === p.vitalsSent) return;
    p.vitalsSent = key;
    sendTo(client, msg);
  };
  /**
   * A player died: back at their bed (if it's still there, with room above it; a bed taken down is
   * forgotten) or the spawn point, whole again, everything kept.
   */
  const respawn = (client: WebSocket, p: Player, world: World, cause: DeathCause | null) => {
    const spot = p.bed ? world.bedSpot(p.bed.x, p.bed.y, p.bed.z) : null;
    if (spot === 'gone') p.bed = null;
    const at = spot && typeof spot === 'object' ? spot : world.spawn;
    sendTo(client, { type: 'respawn', x: at.x, y: at.y, z: at.z, ...(cause ? { cause } : {}), ...(spot ? { bed: typeof spot === 'object' ? 'here' : spot } : {}) });
    p.settleUntil = Date.now() + PLACE_SETTLE_MS;
    p.saveState?.();
  };
  /** Hurts a player (if anything can): killed, they come back (see respawn). */
  const harm = (client: WebSocket, p: Player, world: World, damage: number, cause: DeathCause, now: number) => {
    if (!p.vulnerable || damage <= 0) return;
    if (p.vitals.hurt(damage, now)) respawn(client, p, world, cause);
    sendVitals(client, p);
  };
  // Furnaces and stoves (see stations.ts): who has each open, by world and origin block, to tell
  // when it changes; and, while anyone has one open, it's brought up to date once a second.
  const stationViewers = new Map<World, Map<string, Set<WebSocket>>>();
  const stationKey = (o: PlacedObject) => `${o.x},${o.y},${o.z}`;
  /** Tells everyone with station `o` open what's in it now (null: it's gone). */
  const showStation = (world: World, o: PlacedObject, now: number, gone = false) => {
    const viewers = stationViewers.get(world)?.get(stationKey(o));
    if (!viewers?.size) return;
    const st = gone ? null : world.station(o, now);
    const kind = (objectStation(o) as StationKind | null) ?? 'furnace';
    const msg: ServerMessage = { type: 'station', x: o.x, y: o.y, z: o.z, kind, name: objectName(o), state: st ? st.state : null, serverTime: now };
    for (const s of viewers) sendTo(s, msg);
    if (gone) stationViewers.get(world)?.delete(stationKey(o));
  };
  const stationTicking = setInterval(() => {
    const now = Date.now();
    for (const [world, byKey] of stationViewers) {
      for (const [key, viewers] of byKey) {
        if (!viewers.size) continue;
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        const o = world.objectAt(x, y, z);
        const st = o && world.station(o, now);
        if (!o || !st) {
          for (const s of viewers) sendTo(s, { type: 'station', x, y, z, kind: 'furnace', name: '', state: null, serverTime: now });
          byKey.delete(key);
          continue;
        }
        if (advance(st.kind, st.state, now)) showStation(world, o, now);
      }
    }
  }, 1000);
  const mobbing = setInterval(() => {
    const now = Date.now();
    const byWorld = new Map<World, WebSocket[]>();
    for (const [client, w] of clients) byWorld.set(w, [...(byWorld.get(w) ?? []), client]);
    for (const [world, sockets] of byWorld) {
      let mobs = mobManagers.get(world);
      if (!mobs) mobManagers.set(world, (mobs = opts.mobs ? opts.mobs(world) : new MobManager(world)));
      const here = sockets.map((s) => ({ s, p: players.get(s)! })).filter(({ p }) => p?.pose);
      const hours = clockHours(catalog.clock(here[0]?.p.world) ?? catalog.clock(undefined)!, now);
      const night = hours < 6 || hours >= 19.5;
      const targets = here.map(({ p }) => ({ id: p.id, x: p.pose!.x, y: p.pose!.y - EYE, z: p.pose!.z, vulnerable: p.vulnerable }));
      for (const hit of mobs.step(0.1, now, targets, night)) {
        const e = here.find(({ p }) => p.id === hit.player);
        if (e) harm(e.s, e.p, world, hit.damage, 'mob', now);
      }
      for (const { s, p } of here) {
        // Breath, food, healing (see Vitals): the eye under water or not.
        if (p.vulnerable) {
          const eye = world.materialAtUnit(Math.floor(p.pose!.x), Math.floor(p.pose!.y), Math.floor(p.pose!.z));
          const r = p.vitals.step(0.1, now, eye !== undefined && isWater(eye));
          if (r.died) respawn(s, p, world, r.cause);
          sendVitals(s, p);
        }
        // What this player sees: mobs, and other players.
        const entities = mobs.near(p.pose!.x, p.pose!.z, VIEW, now);
        for (const o of here) {
          if (o.p === p || Math.hypot(deltaX(world.config, p.pose!.x, o.p.pose!.x), o.p.pose!.z - p.pose!.z) > VIEW) continue;
          entities.push({ id: o.p.id, kind: 'player', x: Math.round(o.p.pose!.x), y: Math.round(o.p.pose!.y - EYE), z: Math.round(o.p.pose!.z), yaw: o.p.pose!.yaw, name: o.p.name ?? 'guest' });
        }
        sendTo(s, { type: 'entities', entities });
      }
    }
  }, 100);
  // Monitoring: a sample every second (see /api/dashboard).
  const sampling = setInterval(() => metrics.tick(players.size), 1000);
  // Lit TNT: what's due blows (see Explosives), twenty times a second.
  const explosivesOf = new Map<World, Explosives>();
  const toWorld = (world: World, msg: ServerMessage) => {
    const bytes = encodeMessage(msg);
    for (const [client, w] of clients) if (w === world && client.readyState === client.OPEN) out(client, bytes);
  };
  // (Each tick 50 ms after the last one's done, not on a fixed beat: after a long one, a pause before
  // the next, for what it sent to go out. An announced blast's news would otherwise wait for its carving.)
  let blasting: ReturnType<typeof setTimeout>;
  const blastTick = () => {
    try {
      blastStep();
    } finally {
      blasting = setTimeout(blastTick, 50); // (whatever happened: the next one's still due)
    }
  };
  const blastStep = () => {
    const now = Date.now();
    for (const [world, explosives] of explosivesOf) {
      if (explosives.count === 0) continue;
      const { announced, blasts, debris, landed } = explosives.tick(now);
      for (const r of landed) broadcast(world, r);
      // Craters of blasts announced before: their chunks, and the TNT they lit.
      for (const b of blasts) {
        if (b.result) broadcast(world, b.result);
        for (const { tnt, ms } of b.lit) toWorld(world, { type: 'fuse', ...tnt, ms });
      }
      // Blasts going off now: told at once (flash, sound, dust: clients make it of what's there,
      // before the crater comes on the next tick), and who's in reach hurt.
      for (const b of announced) {
        toWorld(world, { type: 'explosion', x: b.x, y: b.y, z: b.z, radius: b.radius, seed: b.seed, open: b.open.map((v) => Math.round(v * 1000) / 1000) as [number, number, number] });
        for (const [client, w] of clients) {
          const p = players.get(client);
          if (w !== world || !p?.pose || !p.vulnerable) continue;
          const d = Math.hypot(deltaX(world.config, b.x, p.pose.x), p.pose.y - EYE + 0.9 * UNITS_PER_METER - b.y, p.pose.z - b.z);
          harm(client, p, world, blastDamage(d, b.radius), 'blast', now);
        }
        mobManagers.get(world)?.blast(b.x, b.y, b.z, b.radius, now);
      }
      if (debris.length) toWorld(world, { type: 'debris', pieces: debris });
    }
  };
  blasting = setTimeout(blastTick, 50);
  // Worlds nobody's in, or has asked for (a map, a claim, joining) in a while, are closed: their
  // terrain caches go (here and on the worker threads, about a gigabyte a busy world). One with
  // water still to flow or TNT still to go off stays open. Each opens again when next asked for,
  // as it was (its edits are saved as they're made).
  const closingIdle = catalog.closeIdle
    ? setInterval(() => {
        const busy = new Set<World>(clients.values());
        for (const [world, explosives] of explosivesOf) if (explosives.count > 0) busy.add(world);
        const closing = catalog.closeIdle!((w) => busy.has(w) || w.waterPending > 0, opts.idleWorldMs ?? IDLE_WORLD_MS);
        for (const closed of closing) {
          app.log.info({ world: closed.name, idleMinutes: Math.round(closed.idleMs / 6_000) / 10 }, 'closed an idle world');
          for (const world of closed.worlds) {
            mobManagers.delete(world);
            stationViewers.delete(world);
            explosivesOf.delete(world);
          }
        }
        // What they held goes soon (once what was still finishing with them has), not whenever an
        // idle server next allocates enough to collect garbage: meanwhile it's memory in use, and
        // charged for. Only with node --expose-gc.
        if (closing.length) setTimeout(collectGarbage, 3000).unref();
      }, Math.min(60_000, Math.max(1000, (opts.idleWorldMs ?? IDLE_WORLD_MS) / 4)))
    : null;
  // Connections still there (see HEARTBEAT_MS): whether each has answered since it was last pinged.
  const answered = new Map<WebSocket, boolean>();
  const beating = setInterval(() => {
    for (const [socket, ok] of answered) {
      if (!ok) {
        socket.terminate(); // (its 'close' lets go of its player)
        answered.delete(socket);
        continue;
      }
      answered.set(socket, false);
      try {
        socket.ping();
      } catch {
        // (closing already)
      }
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  app.addHook('onClose', async () => {
    clearInterval(beating);
    if (closingIdle) clearInterval(closingIdle);
    clearTimeout(blasting);
    clearInterval(flowing);
    clearInterval(mobbing);
    clearInterval(stationTicking);
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
    answered.set(socket, true);
    socket.on('pong', () => answered.set(socket, true));
    // Who's connecting (their session cookie came with the upgrade request).
    const whoReady: Promise<SignedIn | null> = opts.auth ? opts.auth.signedIn(req.cookies).catch(() => null) : Promise.resolve(null);
    let who: SignedIn | null = null;
    const canEdit = () => !opts.auth || who !== null;
    /** Survival: where this player started mining, and when (see the `mine` message). */
    let mining: { x: number; y: number; z: number; at: number; tool: ItemId | null } | null = null;
    /** The signed-in player's inventory here; null until loaded (or without accounts). */
    let inventory: PlayerInventory | null = null;
    let inventoryLoading = false;
    /**
     * Where a signed-in player is, kept to come back to (see Place): by account and world, once
     * where they were has been loaded; and only poses from after they've been sent back there
     * (Player.settleUntil), so a quick visit doesn't save the spawn point over it.
     */
    let placeKey: { accountId: string; world: string } | null = null;
    let placeSaved = 0;
    /** The rest of them (see PlayerState), kept likewise once loaded; their vitals as loaded (kept as they were outside survival). */
    let stateKey: { accountId: string; world: string } | null = null;
    let stateSaved = 0;
    let loadedVitals: SavedVitals | null = null;
    const saveState = () => {
      const p = players.get(socket), store = opts.inventories;
      if (!stateKey || !store || !p) return;
      stateSaved = Date.now();
      store.saveState(stateKey.accountId, stateKey.world, { vitals: p.vulnerable ? p.vitals.saved() : loadedVitals, bed: p.bed }).catch((err: unknown) => {
        metrics.error('player_state', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
      });
    };
    const savePlace = (now: boolean) => {
      const p = players.get(socket), pose = p?.pose, store = opts.inventories;
      if (stateKey && (now || Date.now() - stateSaved >= PLACE_SAVE_MS)) saveState();
      if (!placeKey || !store || !pose || pose.at < p.settleUntil) return;
      if (!now && Date.now() - placeSaved < PLACE_SAVE_MS) return;
      placeSaved = Date.now();
      store.savePlace(placeKey.accountId, placeKey.world, { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw }).catch((err: unknown) => {
        metrics.error('place', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
      });
    };
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
        () =>
          then(world.encodedChunk(c), (bytes) => {
            if (socket.readyState !== socket.OPEN) return;
            if (!bytes) {
              send({ type: 'chunkUnavailable', ...c });
              return;
            }
            sendBinary(BinaryTag.Chunk, bytes);
            metrics.totals.chunksOut++;
            players.get(socket)!.chunks++;
          }),
        lane,
      );
    /** The furnace or stove this player has open, if any (see stationViewers). */
    let viewing: { world: World; key: string } | null = null;
    const stopViewing = () => {
      if (viewing) stationViewers.get(viewing.world)?.get(viewing.key)?.delete(socket);
      viewing = null;
    };
    socket.on('close', () => {
      answered.delete(socket);
      stopViewing();
      queue.close();
      void inventory?.flush();
      savePlace(true);
      clients.delete(socket);
      clientWorld.delete(socket);
      players.delete(socket);
    });

    socket.on('message', (data, isBinary) => {
      if (answered.has(socket)) answered.set(socket, true);
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
              vitals: new Vitals(), vulnerable: false, vitalsSent: '', lastAttack: 0, bed: null, settleUntil: Infinity, saveState: null,
            });
            // Designs (named: some may be in their inventory) before the inventory, and where they're placed.
            const sendWelcome = (welcome: ServerMessage) => {
              send(welcome);
              send({ type: 'designs', designs: designs.list() });
              send({ type: 'objects', objects: world.designObjects() });
              world.onObjectsChanged ??= () => toWorld(world, { type: 'objects', objects: world.designObjects() });
            };
            sendWelcome({
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
              mode: catalog.play(msg.world)?.mode ?? 'creative',
            });
            const play = catalog.play(msg.world);
            const store = opts.inventories;
            if (!who || !store || !play) return;
            const accountId = who.account.id;
            inventoryLoading = true;
            void Promise.all([
              store.load(accountId, play.inventoryKey),
              store.loadPlace(accountId, play.inventoryKey).catch(() => null),
              // (Not loaded: not kept either, so what was kept isn't lost.)
              store.loadState(accountId, play.inventoryKey).catch((err: unknown) => {
                metrics.error('player_state', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
                return undefined;
              }),
            ])
              .then(([saved, place, state]) => {
                if (socket.readyState !== socket.OPEN) return;
                const p = players.get(socket);
                if (p && state !== undefined) {
                  loadedVitals = state?.vitals ?? null;
                  if (loadedVitals && play.mode === 'survival') p.vitals.restore(loadedVitals);
                  p.bed = state?.bed ?? null;
                  stateKey = { accountId, world: play.inventoryKey };
                  p.saveState = saveState;
                }
                // Back where they were last time (if it's still in the world); kept from now on.
                const there = place && [place.x, place.y, place.z, place.yaw].every(Number.isFinite) && resolveChunk(world.config, { cx: Math.floor(place.x / CHUNK_SIZE), cy: 0, cz: Math.floor(place.z / CHUNK_SIZE) });
                if (place && there) send({ type: 'returnTo', x: place.x, y: place.y, z: place.z, yaw: place.yaw });
                placeKey = { accountId, world: play.inventoryKey };
                if (p) p.settleUntil = Date.now() + (place && there ? PLACE_SETTLE_MS : 0);
                inventory = new PlayerInventory(play.mode, saved ?? (play.mode === 'survival' ? starterInventory() : { items: new Map(), hotbar: creativeHotbar() }), (inv) =>
                  store.save(accountId, play.inventoryKey, inv).catch((err: unknown) => {
                    metrics.error('inventory', err instanceof Error ? err.message : String(err), clientWorld.get(socket));
                    app.log.error(err, 'saving an inventory failed');
                  }),
                );
                send(inventory.message());
                if (p && play.mode === 'survival') {
                  p.vulnerable = true;
                  sendVitals(socket, p, true);
                }
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
            queue.add(`t:${t.level},${t.tx},${t.tz}`, () =>
              then(world.encodedTile(t), (bytes) => {
                if (socket.readyState !== socket.OPEN) return;
                if (!bytes) send({ type: 'tileUnavailable', ...t });
                else {
                  sendBinary(BinaryTag.Tile, bytes);
                  metrics.totals.tilesOut++;
                  players.get(socket)!.tiles++;
                }
              }), 'far');
          } else {
            const { cx, cz } = msg;
            queue.add(`k:${cx},${cz}`, () =>
              then(world.columnRangeOf(cx, cz), (range) => {
                if (socket.readyState !== socket.OPEN) return;
                // The chunks the client renders (from above the water), and those just above and
                // below (it meshes against them).
                const sent = range && mergeSpans(columnSpans(range).map((s) => ({ lo: s.lo - 1, hi: s.hi + 1 })));
                send(range ? { type: 'column', cx, cz, ...range, sent: sent! } : { type: 'column', cx, cz, minY: null, maxY: null });
                metrics.totals.columnsOut++;
                for (const s of sent ?? []) for (let cy = s.lo; cy <= s.hi; cy++) queueChunk({ cx, cy, cz }, 'front');
              }));
          }
          break;

        case 'mine': {
          // (The tool in hand, if they have it: see tools.ts.)
          const tool = msg.tool !== undefined && isTool(msg.tool) && (inventory?.count(msg.tool) ?? 1) >= 1 ? msg.tool : null;
          mining = { x: msg.x, y: msg.y, z: msg.z, at: Date.now(), tool };
          const p = players.get(socket);
          if (p?.vulnerable) p.vitals.exert(EXHAUSTION.mine);
          break;
        }

        case 'fell': {
          const p = players.get(socket);
          if (greeted && p) harm(socket, p, world, fallDamage(msg.speed), 'fell', Date.now());
          break;
        }

        case 'eat': {
          const p = players.get(socket);
          if (!greeted || !p?.vulnerable || !inventory) return;
          if (!isFood(msg.item)) return send({ type: 'error', code: 'eat', message: `a ${itemName(msg.item)} isn't food` });
          const why = inventory.refuseItem(msg.item);
          if (why) return send({ type: 'error', code: 'eat', message: why });
          if (!p.vitals.eat(msg.item)) return send({ type: 'error', code: 'eat', message: "you're not hungry" });
          inventory.addItem(msg.item, -1);
          send(inventory.message());
          sendVitals(socket, p);
          break;
        }

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
          // Boxes over 1 m (digging or filling): creative worlds only.
          if (isBigEdit(msg.edit) && catalog.play(clientWorld.get(socket))?.mode !== 'creative') {
            send({ type: 'editResult', id: msg.id, ok: false, error: 'boxes over 1 m are for creative worlds' });
            return;
          }
          // Survival: digging takes time (see mining.ts), counted from the `mine` message for this
          // spot, with the tool in hand then (which also decides what it gives: see dropOf).
          let tool: ItemId | null = null;
          if (inventory?.mode === 'survival' && (msg.edit.op === 'remove' || msg.edit.op === 'removeBox')) {
            const e = msg.edit;
            const here = mining && mining.x === e.x && mining.y === e.y && mining.z === e.z ? mining : null;
            const started = here?.at ?? null;
            tool = here?.tool ?? null;
            if (!minedLongEnough(started, Date.now(), world.miningTime(e, tool) * (opts.miningTimeScale ?? 1))) {
              send({ type: 'editResult', id: msg.id, ok: false, error: 'keep mining: it takes longer' });
              return;
            }
            mining = null;
          }
          // Left-clicking any part of an object takes the whole thing down (and gives it back).
          if (msg.edit.op === 'remove') {
            const o = world.objectAt(Math.floor(msg.edit.x / 16), Math.floor(msg.edit.y / 16), Math.floor(msg.edit.z / 16));
            if (o) {
              // A furnace or stove: what's in it comes back too (brought up to date first).
              const now = Date.now(), st = world.station(o, now);
              const contents = st ? (advance(st.kind, st.state, now), [st.state.fuel, st.state.input, st.state.output]) : [];
              const result = world.removeObject(o);
              if (st) showStation(world, o, now, true);
              metrics.totals.edits++;
              send({ type: 'editResult', id: msg.id, ok: true });
              const item = objectItem(o);
              if (inventory && (item !== null || contents.some(Boolean))) {
                if (item !== null) inventory.addItem(item, 1);
                for (const c of contents) if (c) inventory.addItem(c.item, c.amount);
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
          if (inventory?.apply(result.change, tool)) send(inventory.message());
          broadcast(world, result);
          break;
        }

        case 'ignite': {
          if (!greeted) return;
          const fail = (error: string) => send({ type: 'editResult', id: msg.id, ok: false, error });
          if (!canEdit()) return fail('sign in to build');
          const tnt = world.explosiveAt(msg.x, msg.y, msg.z);
          if (!tnt) return fail('nothing to light there');
          let explosives = explosivesOf.get(world);
          // (In creative, debris stays where it lands.)
          const name = clientWorld.get(socket);
          if (!explosives) explosivesOf.set(world, (explosives = new Explosives(world, { keepDebris: () => catalog.play(name)?.mode === 'creative' })));
          const ms = explosives.light(tnt, Date.now());
          if (ms === null) return fail("it's already lit");
          send({ type: 'editResult', id: msg.id, ok: true });
          toWorld(world, { type: 'fuse', ...tnt, ms });
          break;
        }

        case 'placeObject':
        case 'use':
        case 'bucket':
        case 'cut': {
          if (!greeted) return;
          const fail = (error: string) => send({ type: 'editResult', id: msg.id, ok: false, error });
          if (!canEdit()) return fail('sign in to build');
          if (opts.inventories && who && !inventory) return fail(inventoryLoading ? 'still loading your inventory' : "your inventory couldn't be loaded");
          let result: EditResult;
          try {
            if (msg.type === 'placeObject') {
              const kind = objectKindOf(msg.item), design = designOfItem(msg.item);
              if (!kind && !design) return fail(`a ${itemName(msg.item)} isn't placed like that`);
              const why = inventory?.refuseItem(msg.item);
              if (why) return fail(why);
              result = design ? world.placeDesign(design, msg.x, msg.y, msg.z, msg.facing) : world.placeObject(kind!, msg.x, msg.y, msg.z, msg.facing, msg.wall ?? false);
              inventory?.addItem(msg.item, -1);
            } else if (msg.type === 'bucket') {
              // Water in buckets is kept by volume (a 1 m block of it is BLOCK_VOLUME); 16 units deep fills a block.
              const perUnit = BLOCK_VOLUME / 16;
              if (inventory && inventory.count(Item.Bucket) < 1) return fail('you need a bucket (crafted from planks)');
              if (msg.fill) {
                const want = Math.min(16, Math.floor((inventory?.waterRoom() ?? Infinity) / perUnit));
                if (want <= 0) return fail('your buckets are full');
                const r = world.scoopWater(msg.x, msg.y, msg.z, want);
                if (r.taken <= 0) return fail('no water there');
                inventory?.addItem(Material.Water, r.taken * perUnit);
                send({ type: 'editResult', id: msg.id, ok: true });
                if (inventory?.mode === 'survival') send(inventory.message());
                if (r.result) broadcast(world, r.result);
                break;
              }
              const amount = Math.min(16, Math.floor((inventory?.water() ?? Infinity) / perUnit));
              if (amount <= 0) return fail('your buckets are empty: fill one at the sea, a lake or a river');
              const r = world.pourWater(msg.x, msg.y, msg.z, amount);
              if (!r.result) return fail('no room for water there');
              inventory?.addItem(Material.Water, -r.poured * perUnit);
              result = r.result;
            } else if (msg.type === 'cut') {
              const radius = SWORDS[msg.sword]?.cut ?? -1;
              if (radius < 0) return fail(`a ${itemName(msg.sword)} doesn't cut`);
              if (inventory && inventory.count(msg.sword) < 1) return fail(`you have no ${itemName(msg.sword)}`);
              const r = world.cutLeaves(msg.x, msg.y, msg.z, radius);
              if (!r) return fail('no leaves there');
              result = r;
            } else {
              const o = world.objectAt(Math.floor(msg.x / 16), Math.floor(msg.y / 16), Math.floor(msg.z / 16));
              // A bed: theirs from now on (see respawn); nothing about it changes.
              const p = players.get(socket);
              if (o && isBed(o) && p) {
                const mine = p.bed?.x === o.x && p.bed.y === o.y && p.bed.z === o.z;
                p.bed = { x: o.x, y: o.y, z: o.z };
                p.saveState?.();
                send({ type: 'editResult', id: msg.id, ok: true, note: mine ? 'this is already your bed' : "this is your bed now: you'll come back here after dying" });
                break;
              }
              if (!o || !usable(o)) return fail(o?.kind === 'design' ? `a ${objectName(o)} doesn't change` : 'nothing to open there');
              result = world.toggleObject(o);
            }
          } catch (err) {
            if (!(err instanceof EditError)) throw err;
            return fail(err.message);
          }
          metrics.totals.edits++;
          players.get(socket)!.edits++;
          send({ type: 'editResult', id: msg.id, ok: true });
          if ((msg.type === 'placeObject' || msg.type === 'bucket') && inventory?.mode === 'survival') send(inventory.message());
          broadcast(world, result);
          break;
        }

        case 'attack': {
          const p = players.get(socket);
          if (!greeted || !p?.pose || !canEdit()) return;
          const now = Date.now();
          if (now - p.lastAttack < 400) return; // a swing at a time
          // A sword only if they have one; otherwise a bare hand.
          const weapon = msg.weapon !== null && isSword(msg.weapon) && (inventory?.count(msg.weapon) ?? 1) >= 1 ? msg.weapon : null;
          p.lastAttack = now;
          if (p.vulnerable) p.vitals.exert(EXHAUSTION.attack);
          // (A little reach to spare: the pose is up to a tenth of a second old.)
          const r = mobManagers.get(world)?.attack(msg.target, p.pose.x, p.pose.y, p.pose.z, attackDamage(weapon), ATTACK_REACH + 1, now);
          // A pig killed: pork (1 to 3).
          if (r?.killed && r.kind === 'pig' && inventory && p.vulnerable) {
            inventory.addItem(Item.Pork, 1 + Math.floor(Math.random() * 3));
            send(inventory.message());
          }
          break;
        }

        case 'stationOpen':
        case 'stationPut':
        case 'stationTake': {
          if (!greeted) return;
          const fail = (message: string) => send({ type: 'error', code: 'station', message });
          if (!canEdit()) return fail('sign in to use it');
          if (opts.inventories && who && !inventory) return fail(inventoryLoading ? 'still loading your inventory' : "your inventory couldn't be loaded");
          const o = world.objectAt(msg.x, msg.y, msg.z);
          const now = Date.now();
          const st = o && world.station(o, now);
          if (!o || !st) return fail('no furnace or stove there');
          // Within reach (as a crafting table must be) of where they last said they were.
          const pose = players.get(socket)?.pose;
          if (!pose || !stationAmong([o], st.kind, pose.x, pose.y, pose.z, TABLE_REACH, world.config.wrapX ? world.config.widthUnits / 16 : null)) return fail(`too far from the ${objectName(o)}`);
          advance(st.kind, st.state, now);
          if (msg.type === 'stationOpen') {
            stopViewing();
            const byKey = stationViewers.get(world) ?? new Map<string, Set<WebSocket>>();
            stationViewers.set(world, byKey);
            const key = stationKey(o);
            if (!byKey.has(key)) byKey.set(key, new Set());
            byKey.get(key)!.add(socket);
            viewing = { world, key };
            showStation(world, o, now);
            break;
          }
          if (msg.type === 'stationPut') {
            const why = refusePut(st.kind, st.state, msg.slot, msg.item);
            if (why) return fail(why);
            if (inventory?.mode === 'survival' && inventory.count(msg.item) < msg.amount) return fail(`you haven't that much ${itemName(msg.item)}`);
            put(st.state, msg.slot, msg.item, msg.amount);
            inventory?.addItem(msg.item, -msg.amount);
          } else {
            const got = take(st.state, msg.slot, msg.amount);
            if (!got) return fail('nothing there');
            inventory?.addItem(got.item, got.amount);
          }
          world.saveStations();
          showStation(world, o, now);
          if (inventory?.mode === 'survival') send(inventory.message());
          break;
        }

        case 'stationClose':
          stopViewing();
          break;

        case 'craft': {
          if (!inventory) {
            send({ type: 'error', code: 'craft', message: 'sign in to craft' });
            return;
          }
          // A crafting table placed within reach of where the player last said they were.
          const pose = players.get(socket)?.pose;
          const recipe = recipeById(msg.recipe);
          // (A crafting table: the built-in object, the design that's the crafting table, or one placed as a block before tables were objects.)
          const nearTable = !!recipe?.table && !!pose && (world.stationNear('crafting-table', pose.x, pose.y, pose.z, TABLE_REACH) || world.materialNear(pose.x, pose.y, pose.z, TABLE_REACH, Material.CraftingTable));
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

        case 'discard': {
          if (!inventory) return;
          const why = inventory.discard(msg.item, msg.amount);
          if (why) send({ type: 'error', code: 'craft', message: why });
          else send(inventory.message());
          break;
        }

        case 'pose': {
          const p = players.get(socket);
          // (Where in the world: on a round world the client's x keeps going past the seam.)
          if (!p) break;
          const now = Date.now(), before = p.pose;
          p.pose = { x: greeted ? normalizeX(world.config, msg.x) : msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, at: now };
          savePlace(false);
          // Survival: going places makes you hungry (sprinting more, swimming a little more).
          if (greeted && p.vulnerable && before) {
            const metres = Math.hypot(deltaX(world.config, before.x, p.pose.x), p.pose.z - before.z) / UNITS_PER_METER;
            const seconds = (now - before.at) / 1000;
            if (metres > 0 && metres < 30 && seconds > 0) {
              const feet = world.materialAtUnit(Math.floor(p.pose.x), Math.floor(p.pose.y - EYE + 8), Math.floor(p.pose.z));
              const rate = feet !== undefined && isWater(feet) ? EXHAUSTION.swim : metres / seconds > WALK_SPEED * 1.2 ? EXHAUSTION.sprint : EXHAUSTION.walk;
              p.vitals.exert(rate * metres);
            }
          }
          break;
        }
      }
    });
  });

  return app;
}
