import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLAT_WORLD_16KM,
  FlatGenerator,
  NoiseHeights,
  PlateHeights,
  TerrainGenerator,
  WORLD_NAME_PATTERN,
  defaultFlatGen,
  defaultNoiseTerrain,
  migratePlateTerrain,
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
  /** When the spec was last replaced (which discards the world's edits). */
  updatedAt?: string;
  spec: WorldSpec;
}

export class WorldExistsError extends Error {}
export class NoSuchWorldError extends Error {}

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

function checkName(name: string): void {
  if (!WORLD_NAME_PATTERN.test(name)) throw new RangeError(`world name must match ${WORLD_NAME_PATTERN}; got "${name}"`);
}

/** Reads data/<name>/world.json, or null if there's no such world. */
export function readWorld(dataRoot: string, name: string): WorldFile | null {
  checkName(name);
  const path = join(dataRoot, name, 'world.json');
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, 'utf8')) as WorldFile;
  if (file.version !== 1) throw new Error(`${path}: unsupported world file version ${file.version}`);
  // Settings added (or renamed) after a world was created take their defaults.
  if (file.spec.generator === 'plates') file.spec.plates = migratePlateTerrain(file.spec.plates);
  validateWorldSpec(file.spec);
  return file;
}

/** Creates world `name` with `spec`; throws WorldExistsError if it already exists. */
export function createWorld(dataRoot: string, name: string, spec: WorldSpec): WorldFile {
  checkName(name);
  validateWorldSpec(spec);
  const dir = join(dataRoot, name);
  if (existsSync(join(dir, 'world.json'))) throw new WorldExistsError(`world "${name}" already exists`);
  mkdirSync(dir, { recursive: true });
  const file: WorldFile = { version: 1, name, createdAt: new Date().toISOString(), spec };
  writeFileSync(join(dir, 'world.json'), JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
  return file;
}

/** Number of saved edited chunks of world `name`. */
export function countEdits(dataRoot: string, name: string): number {
  checkName(name);
  const dir = join(dataRoot, name, 'chunks');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.chunk')).length : 0;
}

/**
 * Replaces world `name`'s spec. Its saved edits are deleted: they are whole chunks of the old
 * terrain and would sit in the new terrain as blocks of the old. Throws NoSuchWorldError.
 */
export function updateWorld(dataRoot: string, name: string, spec: WorldSpec): WorldFile {
  const old = readWorld(dataRoot, name);
  if (!old) throw new NoSuchWorldError(`no world named "${name}"`);
  validateWorldSpec(spec);
  const dir = join(dataRoot, name);
  // Edits first: if this stops halfway, the world keeps its old terrain without edits, never
  // new terrain with old edits.
  rmSync(join(dir, 'chunks'), { recursive: true, force: true });
  const file: WorldFile = { version: 1, name, createdAt: old.createdAt, updatedAt: new Date().toISOString(), spec };
  const tmp = join(dir, 'world.json.tmp');
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  renameSync(tmp, join(dir, 'world.json'));
  return file;
}

/** Deletes world `name` and its edits. Throws NoSuchWorldError. */
export function deleteWorld(dataRoot: string, name: string): void {
  if (!readWorld(dataRoot, name)) throw new NoSuchWorldError(`no world named "${name}"`);
  rmSync(join(dataRoot, name), { recursive: true, force: true });
}

/** Every readable world under `dataRoot`, by name. Folders without a valid world.json are skipped. */
export function listWorlds(dataRoot: string): WorldFile[] {
  if (!existsSync(dataRoot)) return [];
  const out: WorldFile[] = [];
  for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !WORLD_NAME_PATTERN.test(entry.name)) continue;
    try {
      const file = readWorld(dataRoot, entry.name);
      if (file) out.push(file);
    } catch {
      // Unreadable or invalid world: not listed.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Opens world `name` under `dataRoot`, creating it from `specForNew` if it
 * doesn't exist yet. An existing world always uses the spec it was created
 * with, so its terrain never changes under its saved edits; `ignored` says
 * whether `specForNew` differed from it.
 */
export function openWorld(dataRoot: string, name: string, specForNew: WorldSpec): { file: WorldFile; dir: string; created: boolean; ignored: boolean } {
  const dir = join(dataRoot, name);
  const file = readWorld(dataRoot, name);
  if (file) return { file, dir, created: false, ignored: JSON.stringify(file.spec) !== JSON.stringify(specForNew) };
  return { file: createWorld(dataRoot, name, specForNew), dir, created: true, ignored: false };
}

/** Builds the generator (and its height source, for tolerance variants) for a spec. */
export function generatorFor(spec: WorldSpec, world: WorldConfig = FLAT_WORLD_16KM): { generator: ChunkGenerator; heights: HeightSource | null } {
  if (spec.generator === 'flat') return { generator: new FlatGenerator(world, defaultFlatGen(spec.resolution)), heights: null };
  const heights = spec.generator === 'plates' ? new PlateHeights(world, spec.plates) : new NoiseHeights(world, defaultNoiseTerrain(spec.seed));
  return { generator: new TerrainGenerator(world, spec.voxelize, heights), heights };
}
