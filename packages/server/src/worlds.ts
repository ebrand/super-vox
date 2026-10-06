import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHUNK_SIZE,
  DEFAULT_DAY_MINUTES,
  encodeChunk,
  surfaceMap,
  type ChunkGenerator,
  DEFAULT_GAME_MODE,
  DEFAULT_WORLD_SHAPE,
  TerrainGenerator,
  applyClockChange,
  defaultClock,
  defaultVoxelize,
  isValidWorldName,
  strokesOverColumns,
  STROKE_LIMITS,
  type ClockChange,
  type ProtectedColumn,
  type TerrainStroke,
  type DayClock,
  type GameMode,
  type HeightSource,
  type PlateTerrainConfig,
  type WorldConfig,
  type WorldShape,
  PlateStageCache,
  type PlateStages,
  type Claim,
} from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { createHash } from 'node:crypto';
import { rm, readdir } from 'node:fs/promises';
import { DiskCache } from './diskCache.js';
import { GenPool, startWorker } from './genPool.js';
import { buildFile, loadBuild, saveBuild } from './plateBuilds.js';
import type { BuildJob } from './buildWorker.js';
import { World, tileBytes } from './world.js';
import { NoSuchWorldError, countEdits, createWorld, deleteWorld, generatorFor, inventoryKeyOf, listWorlds, modeOf, pictureAt, readClaims, readPicture, readStrokes, readWorld, saveClock, saveMode, updateWorld, worldConfigOf, writeClaims, writePicture, writeStrokes, type WorldFile, type WorldSpec } from './worldFile.js';

/** What the HTTP API shows about a world. */
export type WorldSummary = Pick<WorldFile, 'name' | 'createdAt' | 'updatedAt' | 'spec'> & {
  /** Saved edited chunks (discarded if the world's settings are replaced). */
  editedChunks: number;
  /** Terraforming strokes applied to it (see WorldCatalog.terraform). */
  strokes: number;
  /** Survival or creative. */
  mode: GameMode;
  /** When its picture was set (ms; see WorldCatalog.picture), if it has one. */
  pictureAt?: number;
};

/** A world's picture's time for its summary (see WorldSummary.pictureAt): none if it has none. */
function pictured(dataRoot: string, name: string): { pictureAt?: number } {
  const at = pictureAt(dataRoot, name);
  return at === null ? {} : { pictureAt: Math.round(at) };
}

export class DefaultWorldError extends Error {}
/** Terraforming built on strokes the world no longer has (someone applied others since). */
export class StaleStrokesError extends Error {}
/** Terraforming that would reach where players have built: the strokes' indexes. */
export class StrokesOverBuildsError extends Error {
  constructor(readonly strokes: number[]) {
    super(`${strokes.length} stroke${strokes.length === 1 ? '' : 's'} would reach where players have built`);
  }
}

/** The worlds a server can serve. */
export interface WorldCatalog {
  readonly defaultName: string;
  /** A development server: anyone may use the operator's tools (else admins only; see app.ts). */
  readonly dev: boolean;
  /**
   * World `name` (the default when undefined), voxelized with `tolerance` if
   * given and allowed; null if there is no such world.
   */
  get(name: string | undefined, tolerance?: number): World | null;
  list(): WorldSummary[];
  /** Creates a plate world; absent where changing worlds isn't allowed (as are update and delete). */
  create?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape, mode?: GameMode) => WorldSummary;
  /** Sets a world's game mode (players rejoin to play it). Throws NoSuchWorldError. Absent where not allowed. */
  setMode?: (name: string, mode: GameMode) => WorldSummary;
  /** Replaces a world's settings with plate settings, discarding its edits. */
  update?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape) => WorldSummary;
  /** Deletes a world (never the default one: DefaultWorldError). */
  delete?: (name: string) => void;
  /** World `name`'s clock (the default world when undefined), or null if there is no such world. */
  clock(name: string | undefined): DayClock | null;
  /** Changes a world's clock (now) and returns it; throws NoSuchWorldError. Absent where not allowed. */
  setClock?: (name: string, change: ClockChange) => DayClock;
  /** World `name`'s game mode and the key its players' inventories are filed under; null if no such world. */
  play(name: string | undefined): { mode: GameMode; inventoryKey: string } | null;
  /** Worlds open now (being played or recently asked for), by name. */
  openWorlds(): { name: string; world: World }[];
  /**
   * Closes the worlds not asked for (see get) in the last `idleMs` and not `busy` (someone's in
   * one, or something's still happening there), freeing what they hold (their terrain caches here
   * and on the worker threads); each opens again as it was when next asked for. Returns those
   * closed: their names, how long they'd been idle, and the World objects let go of (with any of
   * their tolerance variants). Absent where worlds stay open.
   */
  closeIdle?: (busy: (world: World) => boolean, idleMs: number, now?: number) => { name: string; idleMs: number; worlds: World[] }[];
  /** Bytes of saved edits of world `name` on disk (0 if none or not kept on disk). */
  diskBytes(name: string): number;
  /** World `name`'s terraforming strokes, in order; null if there's no such world. */
  strokes(name: string): TerrainStroke[] | null;
  /** Where players have built in world `name` (see World.protectedColumns); null if there's no such world. */
  protectedColumns(name: string): ProtectedColumn[] | null;
  /**
   * Adds `added` to world `name`'s terraforming (which must have `base` strokes, else
   * StaleStrokesError) and remakes the world with it; none may reach where players have built
   * (StrokesOverBuildsError). Plate worlds only (RangeError). Returns how many it has now.
   * Throws NoSuchWorldError. Absent where not allowed.
   */
  terraform?: (name: string, base: number, added: readonly TerrainStroke[]) => number;
  /** World `name`'s claims (see Claim), and saving them; null if there's no such world. Absent where not kept. */
  claims?: (name: string) => Claim[] | null;
  saveClaims?: (name: string, claims: readonly Claim[]) => void;
  /** World `name`'s picture (see readPicture); null if it has none or there's no such world. Absent where not kept. */
  picture?: (name: string) => { type: string; data: Buffer; at: number } | null;
  /** Gives world `name` a picture, or takes it away (null): see writePicture, which throws as it does. */
  savePicture?: (name: string, data: Uint8Array | null) => void;
}

/** Bumped when what the disk cache holds changes form. */
const CACHE_FORMAT = 4;

/**
 * Which version of a world's terrain a disk cache holds: its settings and terraforming, and (so
 * a change to the generator's code starts a new cache) a sample of what the generator makes now:
 * the whole world from far above, a distant-terrain tile, and the chunks of two columns.
 */
export function terrainVersion(spec: WorldSpec, strokes: readonly TerrainStroke[], generator: ChunkGenerator, config: WorldConfig): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ format: CACHE_FORMAT, spec, strokes }));
  const map = surfaceMap(generator, 0, 0, config.widthUnits / 64, 64, 32);
  h.update(map.heights);
  h.update(map.materials);
  h.update(tileBytes(generator, config, { level: 4, tx: Math.floor(config.widthUnits / (CHUNK_SIZE * 16) / 3), tz: Math.floor(config.depthUnits / (CHUNK_SIZE * 16) / 2) }));
  for (const [fx, fz] of [[0.5, 0.5], [0.27, 0.61]] as const) {
    const cx = Math.floor((config.widthUnits / CHUNK_SIZE) * fx), cz = Math.floor((config.depthUnits / CHUNK_SIZE) * fz);
    const range = generator.columnRange(cx, cz);
    h.update(JSON.stringify(range));
    for (let cy = Math.floor(range.minY / CHUNK_SIZE) - 1; cy <= Math.floor(range.maxY / CHUNK_SIZE); cy++) h.update(encodeChunk(generator.generateChunk({ cx, cy, cz })));
  }
  return h.digest('hex').slice(0, 16);
}

/** A chunk column's width (metres). */
const CHUNK_METRES = CHUNK_SIZE / 16;

/** The time zone real-time clocks keep (see DayClock): Chicago's, daylight saving and all, wherever the server is. */
export const REAL_TIME_ZONE = 'America/Chicago';

/** `timeZone`'s offset from UTC at `now`, in minutes (east positive): Chicago's -360 in winter (CST), -300 in summer (CDT). */
export function zoneUtcOffsetMinutes(now = new Date(), timeZone = REAL_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value);
  // (The wall clock there, read as if it were UTC, less the moment itself.)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
}

/** A catalog of exactly one world (tests, and servers without a data directory). */
export function singleWorld(
  world: World,
  withTolerance?: (tolerance: number) => World,
  name = 'default',
  dayMinutes: number | 'real' = DEFAULT_DAY_MINUTES,
  mode: GameMode = DEFAULT_GAME_MODE,
): WorldCatalog {
  let clock = defaultClock(Date.now(), dayMinutes, zoneUtcOffsetMinutes());
  return {
    dev: false,
    play: (n) => (n === undefined || n === name ? { mode, inventoryKey: `${name}@single` } : null),
    clock: (n) => (n === undefined || n === name ? clock : null),
    openWorlds: () => [{ name, world }],
    diskBytes: () => 0,
    strokes: (n) => (n === name ? [] : null),
    protectedColumns: (n) => (n === name ? world.protectedColumns() : null),
    setClock: (n, change) => {
      if (n !== name) throw new NoSuchWorldError(`no world named "${n}"`);
      return (clock = applyClockChange(clock, change, Date.now()));
    },
    defaultName: name,
    get: (n, tolerance) => {
      if (n !== undefined && n !== name) return null;
      return tolerance !== undefined && withTolerance ? withTolerance(tolerance) : world;
    },
    list: () => [],
  };
}

interface Opened {
  world: World;
  file: WorldFile;
  strokes: TerrainStroke[];
  /** Its generation on the pool, to let go of when it's closed (null: generated here). */
  remote: { forget(): void } | null;
  heights: HeightSource | null;
  /** Development: the world voxelized at other tolerances (edits stay in memory). */
  variants: Map<number, World>;
  /** A plate world: whether its build was loaded from disk (see plateBuilds.ts) or made here. */
  built: 'disk' | 'here' | null;
}

/**
 * Worlds stored under `dataRoot/<name>/`, opened on first use and kept open.
 * With `dev`, clients may ask for other tolerances and new worlds can be
 * created.
 */
export class FileWorldCatalog implements WorldCatalog {
  private readonly open = new Map<string, Opened>();
  /** When each open world was last asked for (ms). */
  private readonly used = new Map<string, number>();
  readonly create?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape, mode?: GameMode) => WorldSummary;
  readonly setMode?: (name: string, mode: GameMode) => WorldSummary;
  readonly update?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape) => WorldSummary;
  readonly delete?: (name: string) => void;
  readonly setClock?: (name: string, change: ClockChange) => DayClock;
  readonly terraform?: (name: string, base: number, added: readonly TerrainStroke[]) => number;
  readonly dev: boolean;
  private readonly clocks = new Map<string, DayClock>();

  constructor(
    private readonly dataRoot: string,
    readonly defaultName: string,
    /**
     * dayMinutes: the day length of worlds that don't have a clock yet; generationWorkers, how
     * many worker threads generate terrain (0 or absent: the main thread does); diskCache, whether
     * generated terrain is kept on disk (see DiskCache), and plate worlds' builds (see
     * plateBuilds.ts: made in the background for worlds made or changed, and at start for any
     * without a build for this code).
     */
    private readonly opts: { dev: boolean; config?: WorldConfig; dayMinutes?: number | 'real'; generationWorkers?: number; diskCache?: boolean },
  ) {
    this.dev = opts.dev;
    if (opts.diskCache) for (const f of listWorlds(dataRoot)) this.prebuild(f.name);
    // Anyone the server lets (see app.ts: development, or admins) may change a world's clock.
    this.setClock = (name, change) => {
      const now = this.clock(name);
      if (!now) throw new NoSuchWorldError(`no world named "${name}"`);
      const next = applyClockChange(now, change, Date.now());
      saveClock(this.dataRoot, name, next);
      this.clocks.set(name, next);
      return next;
    };
    // Creating, changing and deleting worlds: for whoever the server lets (see app.ts: development, or admins).
    {
      this.create = (name, plates, shape = DEFAULT_WORLD_SHAPE, mode = DEFAULT_GAME_MODE) => {
        const file = createWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize: defaultVoxelize(), shape }, mode);
        this.prebuild(name); // (ready before it's first played)
        return this.summary(file);
      };
      this.setMode = (name, mode) => {
        const file = saveMode(this.dataRoot, name, mode);
        const o = this.open.get(name);
        if (o) o.file = file;
        return this.summary(file);
      };
      this.update = (name, plates, shape) => {
        const old = readWorld(this.dataRoot, name);
        // Keep its voxelization (and its shape, unless a new one is given); the terrain settings change.
        const voxelize = old && old.spec.generator !== 'flat' ? old.spec.voxelize : defaultVoxelize();
        const keep = old && old.spec.generator === 'plates' ? old.spec.shape : undefined;
        const s = shape ?? keep;
        const file = updateWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize, ...(s ? { shape: s } : {}) });
        this.close(name); // rebuilt from the new settings on next use
        this.prebuild(name);
        return this.summary(file);
      };
      this.terraform = (name, base, added) => {
        const world = this.get(name);
        const o = this.open.get(name);
        if (!world || !o) throw new NoSuchWorldError(`no world named "${name}"`);
        if (o.file.spec.generator !== 'plates') throw new RangeError('only plate worlds can be terraformed');
        if (o.strokes.length !== base) throw new StaleStrokesError(`the world has ${o.strokes.length} strokes now, not ${base}: reload to see them`);
        const all = [...o.strokes, ...added];
        if (all.length > STROKE_LIMITS.count) throw new RangeError(`at most ${STROKE_LIMITS.count} strokes a world; this would make ${all.length}`);
        const M = 16, config = world.config;
        const over = strokesOverColumns(added, world.protectedColumns(), CHUNK_METRES, config.wrapX ? config.widthUnits / M : null);
        if (over.length) throw new StrokesOverBuildsError(over);
        writeStrokes(this.dataRoot, name, all);
        this.close(name); // remade with them on next use
        this.prebuild(name);
        return all.length;
      };
      this.delete = (name) => {
        if (name === this.defaultName) throw new DefaultWorldError(`"${name}" is the server's default world and can't be deleted`);
        deleteWorld(this.dataRoot, name);
        this.close(name);
        this.clocks.delete(name);
      };
    }
  }

  get(name: string | undefined, tolerance?: number): World | null {
    const n = name ?? this.defaultName;
    if (!isValidWorldName(n)) return null;
    let o = this.open.get(n);
    if (!o) {
      const file = readWorld(this.dataRoot, n);
      if (!file) return null;
      o = this.build(file);
      this.open.set(n, o);
    }
    this.used.set(n, Date.now());
    const spec = o.file.spec;
    if (tolerance === undefined || !this.opts.dev || !o.heights || spec.generator === 'flat' || tolerance === spec.voxelize.tolerance) return o.world;
    let w = o.variants.get(tolerance);
    if (!w) {
      const config = this.opts.config ?? worldConfigOf(spec);
      const gen = new TerrainGenerator(config, { ...spec.voxelize, tolerance }, o.heights);
      o.variants.set(tolerance, (w = new World(config, gen, { tolerance, cacheSize: 1024 })));
    }
    return w;
  }

  clock(name: string | undefined): DayClock | null {
    const n = name ?? this.defaultName;
    if (!isValidWorldName(n)) return null;
    let c = this.clocks.get(n);
    if (!c) {
      const file = readWorld(this.dataRoot, n);
      if (!file) return null;
      c = file.clock;
      if (!c) {
        // A world's first clock is saved, so its time carries on across restarts.
        c = defaultClock(Date.now(), this.opts.dayMinutes ?? DEFAULT_DAY_MINUTES, zoneUtcOffsetMinutes());
        saveClock(this.dataRoot, n, c);
      }
      this.clocks.set(n, c);
    }
    // A real-time clock follows Chicago's time (daylight saving and all).
    return c.dayMinutes === 'real' ? { ...c, utcOffsetMinutes: zoneUtcOffsetMinutes() } : c;
  }

  play(name: string | undefined): { mode: GameMode; inventoryKey: string } | null {
    const n = name ?? this.defaultName;
    if (!isValidWorldName(n)) return null;
    const file = this.open.get(n)?.file ?? readWorld(this.dataRoot, n);
    return file ? { mode: modeOf(file), inventoryKey: inventoryKeyOf(file) } : null;
  }

  openWorlds(): { name: string; world: World }[] {
    return [...this.open].map(([name, o]) => ({ name, world: o.world }));
  }

  private readonly disk = new Map<string, { at: number; bytes: number }>();

  diskBytes(name: string): number {
    if (!isValidWorldName(name)) return 0;
    // Summed at most every 10 s: worlds can have many chunk files.
    const hit = this.disk.get(name);
    if (hit && Date.now() - hit.at < 10_000) return hit.bytes;
    let bytes = 0;
    const dir = join(this.dataRoot, name, 'chunks');
    if (existsSync(dir)) for (const f of readdirSync(dir)) bytes += statSync(join(dir, f)).size;
    this.disk.set(name, { at: Date.now(), bytes });
    return bytes;
  }

  list(): WorldSummary[] {
    return listWorlds(this.dataRoot).map((f) => this.summary(f));
  }

  private summary(f: WorldFile): WorldSummary {
    return { name: f.name, createdAt: f.createdAt, ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}), spec: f.spec, editedChunks: countEdits(this.dataRoot, f.name), strokes: this.strokes(f.name)?.length ?? 0, mode: modeOf(f), ...pictured(this.dataRoot, f.name) };
  }

  picture(name: string): { type: string; data: Buffer; at: number } | null {
    if (!isValidWorldName(name) || !readWorld(this.dataRoot, name)) return null;
    return readPicture(this.dataRoot, name);
  }

  savePicture(name: string, data: Uint8Array | null): void {
    if (!isValidWorldName(name)) throw new NoSuchWorldError(`no world named "${name}"`);
    writePicture(this.dataRoot, name, data);
  }

  claims(name: string): Claim[] | null {
    if (!isValidWorldName(name) || !readWorld(this.dataRoot, name)) return null;
    return readClaims(this.dataRoot, name);
  }

  saveClaims(name: string, claims: readonly Claim[]): void {
    writeClaims(this.dataRoot, name, claims);
  }

  strokes(name: string): TerrainStroke[] | null {
    if (!isValidWorldName(name)) return null;
    const o = this.open.get(name);
    if (o) return o.strokes;
    return readWorld(this.dataRoot, name) ? readStrokes(this.dataRoot, name) : null;
  }

  protectedColumns(name: string): ProtectedColumn[] | null {
    return this.get(name)?.protectedColumns() ?? null;
  }

  private pool: GenPool | null = null;

  /** World `file`'s disk cache for its terrain as `generator` makes it now; other versions' are deleted. */
  private diskCache(file: WorldFile, generator: ChunkGenerator, config: WorldConfig, strokes: readonly TerrainStroke[]): DiskCache {
    const version = terrainVersion(file.spec, strokes, generator, config);
    const root = join(this.dataRoot, file.name, 'cache');
    void readdir(root).then(
      (dirs) => Promise.all(dirs.filter((d) => d !== version).map((d) => rm(join(root, d), { recursive: true, force: true }))),
      () => undefined,
    );
    return new DiskCache(join(root, version));
  }

  /** Where world `name`'s build came from, if it's open and a plate world (tests, the dashboard). */
  builtFrom(name: string): 'disk' | 'here' | null {
    return this.open.get(name)?.built ?? null;
  }

  /** Worlds waiting to be built in the background (see prebuild), and whether one is being built now. */
  private readonly toBuild: string[] = [];
  private building = false;
  /** Resolves when no background build is waiting or running (tests). */
  private idle: (() => void)[] = [];

  /**
   * Builds plate world `name` and saves it (see plateBuilds.ts) in a worker, so it's on disk before
   * it's played: unless it's on disk already. One at a time, in the order asked.
   */
  private prebuild(name: string): void {
    if (!this.opts.diskCache || this.toBuild.includes(name)) return;
    this.toBuild.push(name);
    this.nextBuild();
  }

  private nextBuild(): void {
    if (this.building) return;
    const name = this.toBuild.shift();
    if (name === undefined) {
      for (const f of this.idle.splice(0)) f();
      return;
    }
    const file = readWorld(this.dataRoot, name);
    if (!file || file.spec.generator !== 'plates') return this.nextBuild();
    const config = this.opts.config ?? worldConfigOf(file.spec);
    const strokes = readStrokes(this.dataRoot, name);
    const path = buildFile(this.dataRoot, name, file.spec, config, strokes);
    if (existsSync(path)) return this.nextBuild();
    this.building = true;
    const w = startWorker('buildWorker', { spec: file.spec, config, strokes, file: path } satisfies BuildJob);
    w.unref();
    let done = false;
    const finish = (msg?: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      if (msg && !msg.ok) console.error(`building ${name} in the background failed: ${msg.error}`);
      this.building = false;
      void w.terminate();
      this.nextBuild();
    };
    w.once('message', finish);
    w.once('error', (err: Error) => finish({ ok: false, error: err.message }));
    w.once('exit', () => finish());
  }

  /** Resolves once background builds are done (tests). */
  buildsDone(): Promise<void> {
    return this.building || this.toBuild.length ? new Promise((r) => this.idle.push(r)) : Promise.resolve();
  }

  /** Closes world `name` (reopened, rebuilt, on next use), letting go of its generation on the pool. */
  private close(name: string): void {
    this.open.get(name)?.remote?.forget();
    this.open.delete(name);
    this.used.delete(name);
  }

  closeIdle(busy: (world: World) => boolean, idleMs: number, now = Date.now()): { name: string; idleMs: number; worlds: World[] }[] {
    const closed: { name: string; idleMs: number; worlds: World[] }[] = [];
    for (const [name, o] of [...this.open]) {
      const worlds = [o.world, ...o.variants.values()], idle = now - (this.used.get(name) ?? 0);
      if (idle < idleMs || worlds.some(busy)) continue;
      this.close(name);
      closed.push({ name, idleMs: idle, worlds });
    }
    return closed;
  }

  private build(file: WorldFile): Opened {
    const config = this.opts.config ?? worldConfigOf(file.spec);
    const strokes = readStrokes(this.dataRoot, file.name);
    // Terrain from settings is made on the worker threads (flat worlds cost next to nothing).
    const workers = this.opts.generationWorkers ?? 0;
    const pooled = workers > 0 && file.spec.generator !== 'flat';
    if (pooled) this.pool ??= new GenPool(workers);
    // A plate world is built once, here; its stages, in shared memory, are the workers' too (and
    // this thread's: built again from them, at next to no cost, it keeps no copy of its own).
    // Kept on disk (see plateBuilds.ts): loaded if there's one for these settings, terraforming and
    // code; else made here, and saved for next time.
    let stages: PlateStages | null = null;
    let built: ReturnType<typeof generatorFor>;
    let from: Opened['built'] = null;
    if (file.spec.generator === 'plates') {
      const path = this.opts.diskCache ? buildFile(this.dataRoot, file.name, file.spec, config, strokes) : null;
      const saved = path ? loadBuild(path) : null;
      const cache = saved ? PlateStageCache.from(saved, config) : new PlateStageCache();
      generatorFor(file.spec, config, strokes, cache);
      // (Every stage reused: it's the build saved. Any that didn't match was made again, so save again.)
      from = saved && cache.hits === saved.length ? 'disk' : 'here';
      stages = cache.share();
      built = generatorFor(file.spec, config, strokes, cache);
      if (path && from === 'here') {
        const s = stages;
        void saveBuild(path, s).catch((err: unknown) => console.error(`saving ${file.name}'s build failed:`, err));
      }
    } else built = generatorFor(file.spec, config, strokes);
    if (!pooled) stages = null;
    const { generator, heights } = built;
    const tolerance = file.spec.generator === 'flat' ? null : file.spec.voxelize.tolerance;
    const remote = this.pool && pooled ? this.pool.remote(file.name, file.spec, config, strokes, stages) : null;
    // Generated terrain kept on disk, for this version of it (older versions' go).
    const disk = this.opts.diskCache && file.spec.generator !== 'flat' ? this.diskCache(file, generator, config, strokes) : null;
    const world = new World(config, generator, { tolerance, store: new FileChunkStore(join(this.dataRoot, file.name, 'chunks')), ...(remote ? { remote } : {}), ...(disk ? { disk } : {}) });
    return { world, file, strokes, remote, heights, variants: new Map(), built: from };
  }
}
