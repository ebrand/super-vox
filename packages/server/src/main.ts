import {
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  TerrainGenerator,
  defaultFlatGen,
  defaultNoiseTerrain,
  defaultVoxelize,
} from '@super-vox/shared';
import { buildApp } from './app.js';
import { World } from './world.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

interface WorldSetup {
  world: World;
  worldWithTolerance?: (tolerance: number) => World;
  settings: Record<string, unknown>;
}

// WORLD_GENERATOR: "terrain" (default) or "flat".
function makeWorld(): WorldSetup {
  const kind = process.env.WORLD_GENERATOR ?? 'terrain';
  if (kind === 'flat') {
    // Generated voxel edge in 1/16 m units: 1, 2, 4, 8 or 16.
    const gen = defaultFlatGen(numberEnv('WORLD_RESOLUTION', 16));
    return { world: new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, gen)), settings: { kind, resolution: gen.resolution } };
  }
  if (kind === 'terrain') {
    const voxelize = {
      minVoxelSize: numberEnv('WORLD_MIN_VOXEL', defaultVoxelize().minVoxelSize),
      tolerance: numberEnv('WORLD_TOLERANCE', defaultVoxelize().tolerance),
    };
    const noise = defaultNoiseTerrain(numberEnv('WORLD_SEED', 1));
    const heights = new NoiseHeights(FLAT_WORLD_16KM, noise);
    const build = (tolerance: number, cacheSize?: number) =>
      new World(FLAT_WORLD_16KM, new TerrainGenerator(FLAT_WORLD_16KM, { ...voxelize, tolerance }, heights), {
        tolerance,
        ...(cacheSize !== undefined ? { cacheSize } : {}),
      });
    const world = build(voxelize.tolerance);
    const setup: WorldSetup = { world, settings: { kind, seed: noise.seed, ...voxelize } };
    if (process.env.NODE_ENV !== 'production') {
      // Development: per-connection tolerance overrides (?tolerance=N in the client URL).
      const variants = new Map<number, World>([[voxelize.tolerance, world]]);
      setup.worldWithTolerance = (tolerance) => {
        let w = variants.get(tolerance);
        if (!w) variants.set(tolerance, (w = build(tolerance, 1024)));
        return w;
      };
      setup.settings.toleranceOverride = 'enabled';
    }
    return setup;
  }
  throw new Error(`WORLD_GENERATOR must be "terrain" or "flat", got "${kind}"`);
}

const { world, worldWithTolerance, settings } = makeWorld();
const app = await buildApp({ world, ...(worldWithTolerance ? { worldWithTolerance } : {}), logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info(settings, 'world ready');
