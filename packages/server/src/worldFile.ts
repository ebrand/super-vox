import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  PlateHeights,
  TerrainGenerator,
  defaultFlatGen,
  defaultNoiseTerrain,
  defaultPlateTerrain,
  validatePlateTerrain,
  validateVoxelize,
  type ChunkGenerator,
  type HeightSource,
  type PlateTerrainConfig,
  type VoxelizeConfig,
  type WorldConfig,
} from '@super-vox/shared';

/** How a world's terrain is generated: chosen when it is created, then fixed. */
export type WorldSpec =
  | { generator: 'plates'; plates: PlateTerrainConfig; voxelize: VoxelizeConfig }
  | { generator: 'noise'; seed: number; voxelize: VoxelizeConfig }
  | { generator: 'flat'; resolution: number };

/** Contents of data/<name>/world.json. */
export interface WorldFile {
  version: 1;
  name: string;
  createdAt: string;
  spec: WorldSpec;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateWorldSpec(spec: WorldSpec): void {
  if (spec.generator === 'plates') {
    validatePlateTerrain(spec.plates);
    validateVoxelize(spec.voxelize);
  } else if (spec.generator === 'noise') {
    if (!Number.isInteger(spec.seed)) throw new RangeError('seed must be an integer');
    validateVoxelize(spec.voxelize);
  } else if (spec.generator === 'flat') {
    defaultFlatGen(spec.resolution); // shape only; FlatGenerator validates the resolution
  } else {
    throw new RangeError(`unknown generator ${(spec as { generator: string }).generator}`);
  }
}

/**
 * Opens world `name` under `dataRoot`, creating it from `specForNew` if it
 * doesn't exist yet. An existing world always uses the spec it was created
 * with, so its terrain never changes under its saved edits; `ignored` says
 * whether `specForNew` differed from it.
 */
export function openWorld(dataRoot: string, name: string, specForNew: WorldSpec): { file: WorldFile; dir: string; created: boolean; ignored: boolean } {
  if (!NAME.test(name)) throw new RangeError(`world name must match ${NAME}; got "${name}"`);
  const dir = join(dataRoot, name);
  const path = join(dir, 'world.json');
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, 'utf8')) as WorldFile;
    if (file.version !== 1) throw new Error(`${path}: unsupported world file version ${file.version}`);
    // Settings added after a world was created take their defaults.
    if (file.spec.generator === 'plates') file.spec.plates = { ...defaultPlateTerrain(file.spec.plates.seed), ...file.spec.plates };
    validateWorldSpec(file.spec);
    return { file, dir, created: false, ignored: JSON.stringify(file.spec) !== JSON.stringify(specForNew) };
  }
  validateWorldSpec(specForNew);
  mkdirSync(dir, { recursive: true });
  const file: WorldFile = { version: 1, name, createdAt: new Date().toISOString(), spec: specForNew };
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  return { file, dir, created: true, ignored: false };
}

/** Builds the generator (and its height source, for tolerance variants) for a spec. */
export function generatorFor(spec: WorldSpec, world: WorldConfig = FLAT_WORLD_16KM): { generator: ChunkGenerator; heights: HeightSource | null } {
  if (spec.generator === 'flat') return { generator: new FlatGenerator(world, defaultFlatGen(spec.resolution)), heights: null };
  const heights = spec.generator === 'plates' ? new PlateHeights(world, spec.plates) : new NoiseHeights(world, defaultNoiseTerrain(spec.seed));
  return { generator: new TerrainGenerator(world, spec.voxelize, heights), heights };
}
