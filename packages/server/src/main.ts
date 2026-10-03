import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MINUTES_LIMITS, DEFAULT_GAME_MODE, isGameMode, DEFAULT_DAY_MINUTES, DEFAULT_WORLD_SHAPE, WORLD_SHAPES, defaultPlateTerrain, defaultVoxelize, isWorldShape, type WorldShape } from '@super-vox/shared';
import type pg from 'pg';
import { MemoryAccountStore, PgAccountStore, type AccountStore } from './accounts.js';
import { openDatabase } from './db.js';
import { MemoryInventoryStore, PgInventoryStore, type InventoryStore } from './inventories.js';
import { buildApp } from './app.js';
import { DesignLibrary } from './designs.js';
import { Auth } from './auth.js';
import { authConfigFromEnv, loadDevSecrets } from './authConfig.js';
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
/** WORLD_SHAPE for a new default world: round-64x32 (default), round-16x8 or flat-16x16. */
function worldShapeEnv(): WorldShape {
  const v = process.env.WORLD_SHAPE;
  if (v === undefined || v === '') return DEFAULT_WORLD_SHAPE;
  if (!isWorldShape(v)) throw new RangeError(`WORLD_SHAPE must be "round-64x32", "round-16x8" or "flat-16x16"; got "${v}"`);
  return v;
}

function specForNewWorld(): WorldSpec {
  const kind = process.env.WORLD_GENERATOR ?? 'plates';
  const voxelize = {
    minVoxelSize: numberEnv('WORLD_MIN_VOXEL', defaultVoxelize().minVoxelSize),
    tolerance: numberEnv('WORLD_TOLERANCE', defaultVoxelize().tolerance),
  };
  const seed = numberEnv('WORLD_SEED', 1);
  if (kind === 'plates') {
    const shape = worldShapeEnv();
    const d = defaultPlateTerrain(seed, WORLD_SHAPES[shape]);
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
        equator: numberEnv('WORLD_EQUATOR', d.equator),
        equatorTemperature: numberEnv('WORLD_EQUATOR_TEMPERATURE', d.equatorTemperature),
        southTemperature: numberEnv('WORLD_SOUTH_TEMPERATURE', d.southTemperature),
        altitudeCooling: numberEnv('WORLD_ALTITUDE_COOLING', d.altitudeCooling),
        rainfall: numberEnv('WORLD_RAINFALL', d.rainfall),
        windFrom: numberEnv('WORLD_WIND_FROM', d.windFrom),
        snowTemperature: numberEnv('WORLD_SNOW_TEMPERATURE', d.snowTemperature),
        altitudeSnow: numberEnv('WORLD_ALTITUDE_SNOW', d.altitudeSnow),
        altitudeRock: numberEnv('WORLD_ALTITUDE_ROCK', d.altitudeRock),
        biomeBlend: numberEnv('WORLD_BIOME_BLEND', d.biomeBlend),
        trees: numberEnv('WORLD_TREES', d.trees),
        treeClumping: numberEnv('WORLD_TREE_CLUMPING', d.treeClumping),
        rivers: numberEnv('WORLD_RIVERS', d.rivers),
        lakes: numberEnv('WORLD_LAKES', d.lakes),
        islandArcs: numberEnv('WORLD_ISLAND_ARCS', d.islandArcs),
        hotspots: numberEnv('WORLD_HOTSPOTS', d.hotspots),
        islandMinSize: numberEnv('WORLD_ISLAND_MIN_SIZE', d.islandMinSize),
        islandMaxSize: numberEnv('WORLD_ISLAND_MAX_SIZE', d.islandMaxSize),
      },
      voxelize,
      shape,
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
/** WORLD_MODE for a new default world: survival (default) or creative. */
const modeEnv = process.env.WORLD_MODE || DEFAULT_GAME_MODE;
if (!isGameMode(modeEnv)) throw new RangeError(`WORLD_MODE must be "survival" or "creative"; got "${modeEnv}"`);
const opened = openWorld(dataRoot, name, specForNewWorld(), modeEnv);
const spec = opened.file.spec;
// Other worlds under dataRoot are served too (?world=name). In development, clients may ask for
// other tolerances (?tolerance=N; those edits stay in memory) and new worlds can be created.
// Day length (real minutes per game day, or "real" for the server's clock) of worlds without a clock yet.
const dayEnv = process.env.WORLD_DAY_MINUTES;
const dayMinutes = dayEnv === undefined || dayEnv === '' ? DEFAULT_DAY_MINUTES : dayEnv === 'real' ? 'real' : Number(dayEnv);
if (dayMinutes !== 'real' && !(dayMinutes >= DAY_MINUTES_LIMITS[0] && dayMinutes <= DAY_MINUTES_LIMITS[1])) {
  throw new RangeError(`WORLD_DAY_MINUTES must be ${DAY_MINUTES_LIMITS[0]}..${DAY_MINUTES_LIMITS[1]} or "real"; got "${dayEnv}"`);
}
// Worker threads generating terrain (GEN_WORKERS, default 8; 0: the main thread does it).
const generationWorkers = Number(process.env.GEN_WORKERS ?? 8);
if (!Number.isInteger(generationWorkers) || generationWorkers < 0 || generationWorkers > 64) throw new RangeError(`GEN_WORKERS must be 0..64; got "${process.env.GEN_WORKERS}"`);
// Generated terrain kept on disk, under each world's cache/ (DISK_CACHE=0: not).
const diskCache = process.env.DISK_CACHE !== '0';
const catalog = new FileWorldCatalog(dataRoot, name, { dev: process.env.NODE_ENV !== 'production', dayMinutes, generationWorkers, diskCache });
const world = catalog.get(name)!;
// The built client, served at / (CLIENT_DIR, or in production packages/client/dist if built).
const clientDir = process.env.CLIENT_DIR || (process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('../../client/dist', import.meta.url)) : '');
if (clientDir && !existsSync(join(clientDir, 'index.html'))) throw new Error(`no built client in ${clientDir} (npm run build)`);
// Google sign-in (see authConfig.ts). In development the credentials come from auth/ when the
// environment lacks them; accounts are kept in Postgres when DATABASE_URL is set, else in memory.
const production = process.env.NODE_ENV === 'production';
const fromAuthDir = production ? [] : loadDevSecrets(process.env, fileURLToPath(new URL('../../../auth', import.meta.url)));
const authConfig = authConfigFromEnv(process.env, production);
let accounts: AccountStore | null = null;
let inventories: InventoryStore | null = null;
let pool: pg.Pool | null = null;
if (authConfig) {
  if (process.env.DATABASE_URL) {
    pool = await openDatabase(process.env.DATABASE_URL);
    accounts = new PgAccountStore(pool);
    inventories = new PgInventoryStore(pool);
  } else if (production) throw new Error('sign-in needs DATABASE_URL in production');
  else {
    accounts = new MemoryAccountStore();
    inventories = new MemoryInventoryStore();
  }
}
const auth = authConfig && accounts ? new Auth(authConfig, accounts) : undefined;
// Designed objects (see DesignLibrary): one library for every world, beside them.
const designs = new DesignLibrary(join(dataRoot, 'designs.json'));
const app = await buildApp({ catalog, designs, logger: true, ...(clientDir ? { clientDir } : {}), ...(auth ? { auth } : {}), ...(inventories ? { inventories } : {}) });
app.addHook('onClose', async () => pool?.end());
app.log.info(
  { signIn: !!auth, accounts: accounts ? (pool ? 'postgres' : 'memory') : null, fromAuthDir },
  auth ? 'sign-in on: only signed-in players may edit' : 'sign-in off: anyone may edit',
);

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
