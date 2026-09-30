import { join } from 'node:path';
import { FLAT_WORLD_16KM, TerrainGenerator, defaultVoxelize, isValidWorldName, type HeightSource, type PlateTerrainConfig, type WorldConfig } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';
import { createWorld, generatorFor, listWorlds, readWorld, type WorldFile } from './worldFile.js';

/** What the HTTP API shows about a world. */
export type WorldSummary = Pick<WorldFile, 'name' | 'createdAt' | 'spec'>;

/** The worlds a server can serve. */
export interface WorldCatalog {
  readonly defaultName: string;
  /**
   * World `name` (the default when undefined), voxelized with `tolerance` if
   * given and allowed; null if there is no such world.
   */
  get(name: string | undefined, tolerance?: number): World | null;
  list(): WorldSummary[];
  /** Creates a plate world; absent where creating worlds isn't allowed. */
  create?: (name: string, plates: PlateTerrainConfig) => WorldSummary;
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

  constructor(
    private readonly dataRoot: string,
    readonly defaultName: string,
    private readonly opts: { dev: boolean; config?: WorldConfig },
  ) {
    if (opts.dev) {
      this.create = (name, plates) => summary(createWorld(this.dataRoot, name, { generator: 'plates', plates, voxelize: defaultVoxelize() }));
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
    return listWorlds(this.dataRoot).map(summary);
  }

  private build(file: WorldFile): Opened {
    const config = this.opts.config ?? FLAT_WORLD_16KM;
    const { generator, heights } = generatorFor(file.spec, config);
    const tolerance = file.spec.generator === 'flat' ? null : file.spec.voxelize.tolerance;
    const world = new World(config, generator, { tolerance, store: new FileChunkStore(join(this.dataRoot, file.name, 'chunks')) });
    return { world, file, heights, variants: new Map() };
  }
}

const summary = (f: WorldFile): WorldSummary => ({ name: f.name, createdAt: f.createdAt, spec: f.spec });
