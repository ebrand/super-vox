import { join } from 'node:path';
import { FLAT_WORLD_16KM, TerrainGenerator, defaultVoxelize, isValidWorldName, type HeightSource, type PlateTerrainConfig, type WorldConfig } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';
import { countEdits, createWorld, deleteWorld, generatorFor, listWorlds, readWorld, updateWorld, type WorldFile } from './worldFile.js';

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
  create?: (name: string, plates: PlateTerrainConfig) => WorldSummary;
  /** Replaces a world's settings with plate settings, discarding its edits. */
  update?: (name: string, plates: PlateTerrainConfig) => WorldSummary;
  /** Deletes a world (never the default one: DefaultWorldError). */
  delete?: (name: string) => void;
}

/** A catalog of exactly one world (tests, and servers without a data directory). */
export function singleWorld(world: World, withTolerance?: (tolerance: number) => World, name = 'default'): WorldCatalog {
  return {
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
  readonly create?: (name: string, plates: PlateTerrainConfig) => WorldSummary;
  readonly update?: (name: string, plates: PlateTerrainConfig) => WorldSummary;
  readonly delete?: (name: string) => void;

  constructor(
    private readonly dataRoot: string,
    readonly defaultName: string,
    private readonly opts: { dev: boolean; config?: WorldConfig },
  ) {
    if (opts.dev) {
      this.create = (name, plates) => this.summary(createWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize: defaultVoxelize() }));
      this.update = (name, plates) => {
        const old = readWorld(this.dataRoot, name);
        // Keep its voxelization; only the terrain settings change.
        const voxelize = old && old.spec.generator !== 'flat' ? old.spec.voxelize : defaultVoxelize();
        const file = updateWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize });
        this.open.delete(name); // rebuilt from the new settings on next use
        return this.summary(file);
      };
      this.delete = (name) => {
        if (name === this.defaultName) throw new DefaultWorldError(`"${name}" is the server's default world and can't be deleted`);
        deleteWorld(this.dataRoot, name);
        this.open.delete(name);
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
      const config = this.opts.config ?? FLAT_WORLD_16KM;
      const gen = new TerrainGenerator(config, { ...spec.voxelize, tolerance }, o.heights);
      o.variants.set(tolerance, (w = new World(config, gen, { tolerance, cacheSize: 1024 })));
    }
    return w;
  }

  list(): WorldSummary[] {
    return listWorlds(this.dataRoot).map((f) => this.summary(f));
  }

  private summary(f: WorldFile): WorldSummary {
    return { name: f.name, createdAt: f.createdAt, ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}), spec: f.spec, editedChunks: countEdits(this.dataRoot, f.name) };
  }

  private build(file: WorldFile): Opened {
    const config = this.opts.config ?? FLAT_WORLD_16KM;
    const { generator, heights } = generatorFor(file.spec, config);
    const tolerance = file.spec.generator === 'flat' ? null : file.spec.voxelize.tolerance;
    const world = new World(config, generator, { tolerance, store: new FileChunkStore(join(this.dataRoot, file.name, 'chunks')) });
    return { world, file, heights, variants: new Map() };
  }
}
