import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DAY_MINUTES,
  DEFAULT_GAME_MODE,
  DEFAULT_WORLD_SHAPE,
  TerrainGenerator,
  applyClockChange,
  defaultClock,
  defaultVoxelize,
  isValidWorldName,
  type ClockChange,
  type DayClock,
  type GameMode,
  type HeightSource,
  type PlateTerrainConfig,
  type WorldConfig,
  type WorldShape,
} from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';
import { NoSuchWorldError, countEdits, createWorld, deleteWorld, generatorFor, inventoryKeyOf, listWorlds, modeOf, readWorld, saveClock, updateWorld, worldConfigOf, type WorldFile } from './worldFile.js';

/** What the HTTP API shows about a world. */
export type WorldSummary = Pick<WorldFile, 'name' | 'createdAt' | 'updatedAt' | 'spec'> & {
  /** Saved edited chunks (discarded if the world's settings are replaced). */
  editedChunks: number;
};

export class DefaultWorldError extends Error {}

/** The worlds a server can serve. */
export interface WorldCatalog {
  readonly defaultName: string;
  /**
   * World `name` (the default when undefined), voxelized with `tolerance` if
   * given and allowed; null if there is no such world.
   */
  get(name: string | undefined, tolerance?: number): World | null;
  list(): WorldSummary[];
  /** Creates a plate world; absent where changing worlds isn't allowed (as are update and delete). */
  create?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape) => WorldSummary;
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
  /** Bytes of saved edits of world `name` on disk (0 if none or not kept on disk). */
  diskBytes(name: string): number;
}

/** The server's offset from UTC in minutes (east positive), for real-time clocks. */
export function localUtcOffsetMinutes(now = new Date()): number {
  return -now.getTimezoneOffset();
}

/** A catalog of exactly one world (tests, and servers without a data directory). */
export function singleWorld(
  world: World,
  withTolerance?: (tolerance: number) => World,
  name = 'default',
  dayMinutes: number | 'real' = DEFAULT_DAY_MINUTES,
  mode: GameMode = DEFAULT_GAME_MODE,
): WorldCatalog {
  let clock = defaultClock(Date.now(), dayMinutes, localUtcOffsetMinutes());
  return {
    play: (n) => (n === undefined || n === name ? { mode, inventoryKey: `${name}@single` } : null),
    clock: (n) => (n === undefined || n === name ? clock : null),
    openWorlds: () => [{ name, world }],
    diskBytes: () => 0,
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
  heights: HeightSource | null;
  /** Development: the world voxelized at other tolerances (edits stay in memory). */
  variants: Map<number, World>;
}

/**
 * Worlds stored under `dataRoot/<name>/`, opened on first use and kept open.
 * With `dev`, clients may ask for other tolerances and new worlds can be
 * created.
 */
export class FileWorldCatalog implements WorldCatalog {
  private readonly open = new Map<string, Opened>();
  readonly create?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape) => WorldSummary;
  readonly update?: (name: string, plates: PlateTerrainConfig, shape?: WorldShape) => WorldSummary;
  readonly delete?: (name: string) => void;
  readonly setClock?: (name: string, change: ClockChange) => DayClock;
  private readonly clocks = new Map<string, DayClock>();

  constructor(
    private readonly dataRoot: string,
    readonly defaultName: string,
    /** dayMinutes: the day length of worlds that don't have a clock yet. */
    private readonly opts: { dev: boolean; config?: WorldConfig; dayMinutes?: number | 'real' },
  ) {
    if (opts.dev) {
      this.setClock = (name, change) => {
        const now = this.clock(name);
        if (!now) throw new NoSuchWorldError(`no world named "${name}"`);
        const next = applyClockChange(now, change, Date.now());
        saveClock(this.dataRoot, name, next);
        this.clocks.set(name, next);
        return next;
      };
      this.create = (name, plates, shape = DEFAULT_WORLD_SHAPE) =>
        this.summary(createWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize: defaultVoxelize(), shape }));
      this.update = (name, plates, shape) => {
        const old = readWorld(this.dataRoot, name);
        // Keep its voxelization (and its shape, unless a new one is given); the terrain settings change.
        const voxelize = old && old.spec.generator !== 'flat' ? old.spec.voxelize : defaultVoxelize();
        const keep = old && old.spec.generator === 'plates' ? old.spec.shape : undefined;
        const s = shape ?? keep;
        const file = updateWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize, ...(s ? { shape: s } : {}) });
        this.open.delete(name); // rebuilt from the new settings on next use
        return this.summary(file);
      };
      this.delete = (name) => {
        if (name === this.defaultName) throw new DefaultWorldError(`"${name}" is the server's default world and can't be deleted`);
        deleteWorld(this.dataRoot, name);
        this.open.delete(name);
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
        c = defaultClock(Date.now(), this.opts.dayMinutes ?? DEFAULT_DAY_MINUTES, localUtcOffsetMinutes());
        saveClock(this.dataRoot, n, c);
      }
      this.clocks.set(n, c);
    }
    // A real-time clock follows the server's current time zone (daylight saving).
    return c.dayMinutes === 'real' ? { ...c, utcOffsetMinutes: localUtcOffsetMinutes() } : c;
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
    return { name: f.name, createdAt: f.createdAt, ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}), spec: f.spec, editedChunks: countEdits(this.dataRoot, f.name) };
  }

  private build(file: WorldFile): Opened {
    const config = this.opts.config ?? worldConfigOf(file.spec);
    const { generator, heights } = generatorFor(file.spec, config);
    const tolerance = file.spec.generator === 'flat' ? null : file.spec.voxelize.tolerance;
    const world = new World(config, generator, { tolerance, store: new FileChunkStore(join(this.dataRoot, file.name, 'chunks')) });
    return { world, file, heights, variants: new Map() };
  }
}
