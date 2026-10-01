import { fileURLToPath } from 'node:url';
import { FLAT_WORLD_16KM, defaultPlateTerrain, defaultVoxelize } from '@super-vox/shared';
import { buildApp } from './app.js';
import { openWorld, type WorldSpec } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';

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
        terrainSeed: numberEnv('WORLD_TERRAIN_SEED', seed),
        majorPlates: numberEnv('WORLD_MAJOR_PLATES', d.majorPlates),
        minorPlates: numberEnv('WORLD_MINOR_PLATES', d.minorPlates),
        plateSizeRatio: numberEnv('WORLD_PLATE_SIZE_RATIO', d.plateSizeRatio),
        minHeight: numberEnv('WORLD_MIN_HEIGHT', d.minHeight),
        maxHeight: numberEnv('WORLD_MAX_HEIGHT', d.maxHeight),
        seaLevel: numberEnv('WORLD_SEA_LEVEL', d.seaLevel),
        landPercent: numberEnv('WORLD_LAND', d.landPercent),
        shoreFractal: numberEnv('WORLD_SHORE_FRACTAL', d.shoreFractal),
        beaches: numberEnv('WORLD_BEACHES', d.beaches),
        rockAltitude: numberEnv('WORLD_ROCK_ALTITUDE', d.rockAltitude),
        snowAltitude: numberEnv('WORLD_SNOW_ALTITUDE', d.snowAltitude),
        snowFractal: numberEnv('WORLD_SNOW_FRACTAL', d.snowFractal),
        rockSlope: numberEnv('WORLD_ROCK_SLOPE', d.rockSlope),
        noiseScale: numberEnv('WORLD_NOISE_SCALE', d.noiseScale),
        noiseRoughness: numberEnv('WORLD_NOISE_ROUGHNESS', d.noiseRoughness),
        mountains: numberEnv('WORLD_MOUNTAINS', d.mountains),
        mountainHeight: numberEnv('WORLD_MOUNTAIN_HEIGHT', d.mountainHeight),
        mountainWidth: numberEnv('WORLD_MOUNTAIN_WIDTH', d.mountainWidth),
        mountainRuggedness: numberEnv('WORLD_MOUNTAIN_RUGGEDNESS', d.mountainRuggedness),
        mountainDetail: numberEnv('WORLD_MOUNTAIN_DETAIL', d.mountainDetail),
        plains: numberEnv('WORLD_PLAINS', d.plains),
        lowlandFlatness: numberEnv('WORLD_LOWLAND_FLATNESS', d.lowlandFlatness),
        surfaceRoughness: numberEnv('WORLD_SURFACE_ROUGHNESS', d.surfaceRoughness),
        biomes: numberEnv('WORLD_BIOMES', d.biomes),
        northTemperature: numberEnv('WORLD_NORTH_TEMPERATURE', d.northTemperature),
        southTemperature: numberEnv('WORLD_SOUTH_TEMPERATURE', d.southTemperature),
        altitudeCooling: numberEnv('WORLD_ALTITUDE_COOLING', d.altitudeCooling),
        rainfall: numberEnv('WORLD_RAINFALL', d.rainfall),
        windFrom: numberEnv('WORLD_WIND_FROM', d.windFrom),
        snowTemperature: numberEnv('WORLD_SNOW_TEMPERATURE', d.snowTemperature),
        islandArcs: numberEnv('WORLD_ISLAND_ARCS', d.islandArcs),
        hotspots: numberEnv('WORLD_HOTSPOTS', d.hotspots),
        islandMinSize: numberEnv('WORLD_ISLAND_MIN_SIZE', d.islandMinSize),
        islandMaxSize: numberEnv('WORLD_ISLAND_MAX_SIZE', d.islandMaxSize),
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
// Other worlds under dataRoot are served too (?world=name). In development, clients may ask for
// other tolerances (?tolerance=N; those edits stay in memory) and new worlds can be created.
const catalog = new FileWorldCatalog(dataRoot, name, { dev: process.env.NODE_ENV !== 'production', config: FLAT_WORLD_16KM });
const world = catalog.get(name)!;
const app = await buildApp({ catalog, logger: true });

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
