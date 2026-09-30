import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLAT_WORLD_16KM,
  TerrainGenerator,
  defaultPlateTerrain,
  defaultVoxelize,
} from '@super-vox/shared';
import { buildApp } from './app.js';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';
import { generatorFor, openWorld, type WorldSpec } from './worldFile.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/** Settings for a world that doesn't exist yet (WORLD_GENERATOR: plates (default), noise, or flat). */
function specForNewWorld(): WorldSpec {
  const kind = process.env.WORLD_GENERATOR ?? 'plates';
  const voxelize = {
    minVoxelSize: numberEnv('WORLD_MIN_VOXEL', defaultVoxelize().minVoxelSize),
    tolerance: numberEnv('WORLD_TOLERANCE', defaultVoxelize().tolerance),
  };
  const seed = numberEnv('WORLD_SEED', 1);
  if (kind === 'plates') {
    const d = defaultPlateTerrain(seed);
    return {
      generator: 'plates',
      plates: {
        seed,
        majorPlates: numberEnv('WORLD_MAJOR_PLATES', d.majorPlates),
        minorPlates: numberEnv('WORLD_MINOR_PLATES', d.minorPlates),
        waterPercent: numberEnv('WORLD_WATER', d.waterPercent),
        shoreFractal: numberEnv('WORLD_SHORE_FRACTAL', d.shoreFractal),
        mountainHeight: numberEnv('WORLD_MOUNTAIN_HEIGHT', d.mountainHeight!),
      },
      voxelize,
    };
  }
  if (kind === 'noise') return { generator: 'noise', seed, voxelize };
  if (kind === 'flat') return { generator: 'flat', resolution: numberEnv('WORLD_RESOLUTION', 16) };
  throw new Error(`WORLD_GENERATOR must be "plates", "noise", or "flat", got "${kind}"`);
}

// Each world lives in WORLD_DATA_DIR / WORLD_NAME (default "dev"): world.json records how it
// was created; chunks/ holds its saved edits. WORLD_DATA_DIR defaults to the repository's data/
// folder (resolved from this file, so it's the same however the server is started).
const dataRoot = process.env.WORLD_DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url));
const name = process.env.WORLD_NAME ?? 'dev';
const opened = openWorld(dataRoot, name, specForNewWorld());
const spec = opened.file.spec;
const { generator, heights } = generatorFor(spec, FLAT_WORLD_16KM);
const tolerance = spec.generator === 'flat' ? null : spec.voxelize.tolerance;
const world = new World(FLAT_WORLD_16KM, generator, {
  tolerance,
  store: new FileChunkStore(join(opened.dir, 'chunks')),
});

// Development: per-connection tolerance overrides (?tolerance=N); their edits stay in memory.
let worldWithTolerance: ((t: number) => World) | undefined;
if (process.env.NODE_ENV !== 'production' && heights && spec.generator !== 'flat') {
  const variants = new Map<number, World>([[spec.voxelize.tolerance, world]]);
  worldWithTolerance = (t) => {
    let w = variants.get(t);
    if (!w) {
      const gen = new TerrainGenerator(FLAT_WORLD_16KM, { ...spec.voxelize, tolerance: t }, heights);
      variants.set(t, (w = new World(FLAT_WORLD_16KM, gen, { tolerance: t, cacheSize: 1024 })));
    }
    return w;
  };
}

const app = await buildApp({ world, ...(worldWithTolerance ? { worldWithTolerance } : {}), logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info({ world: name, created: opened.created, spec, spawn: world.spawn }, opened.created ? 'created world' : 'opened world');
if (opened.ignored) {
  app.log.warn({ world: name }, 'world already exists: its saved settings are used and the WORLD_* creation settings are ignored');
}
