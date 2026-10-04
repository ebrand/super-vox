import { UNITS_PER_METER } from './units.js';

/**
 * World layout. X runs east-west, Z runs north-south, Y is up. Horizontal
 * coordinates are in units with the world spanning [0, width) x [0, depth).
 *
 * Flat worlds are bounded on both axes. Round worlds wrap on X (east-west) and
 * are bounded on Z, with the poles at z = 0 and z = depth.
 */
export interface WorldConfig {
  widthUnits: number;
  depthUnits: number;
  minYUnits: number;
  maxYUnits: number;
  wrapX: boolean;
}

/** Chunk edge in units (16 m). */
export const CHUNK_SIZE = 16 * UNITS_PER_METER;

const KM = 1000 * UNITS_PER_METER;
const DEFAULT_MIN_Y = -1024 * UNITS_PER_METER;
const DEFAULT_MAX_Y = 1024 * UNITS_PER_METER;

export const FLAT_WORLD_16KM: WorldConfig = {
  widthUnits: 16 * KM,
  depthUnits: 16 * KM,
  minYUnits: DEFAULT_MIN_Y,
  maxYUnits: DEFAULT_MAX_Y,
  wrapX: false,
};

export const ROUND_WORLD_16x8KM: WorldConfig = {
  widthUnits: 16 * KM,
  depthUnits: 8 * KM,
  minYUnits: DEFAULT_MIN_Y,
  maxYUnits: DEFAULT_MAX_Y,
  wrapX: true,
};

export const ROUND_WORLD_32x16KM: WorldConfig = {
  widthUnits: 32 * KM,
  depthUnits: 16 * KM,
  minYUnits: DEFAULT_MIN_Y,
  maxYUnits: DEFAULT_MAX_Y,
  wrapX: true,
};

export const ROUND_WORLD_64x32KM: WorldConfig = {
  widthUnits: 64 * KM,
  depthUnits: 32 * KM,
  minYUnits: DEFAULT_MIN_Y,
  maxYUnits: DEFAULT_MAX_Y,
  wrapX: true,
};

/**
 * The shapes a world can have: round (wrapping east-west, with polar ice at the north and south
 * edges), 64 km around by 32 km, 32 by 16 km or 16 by 8 km; or flat, 16 x 16 km with edges all round.
 */
export type WorldShape = 'round-64x32' | 'round-32x16' | 'round-16x8' | 'flat-16x16';
export const WORLD_SHAPES: Record<WorldShape, WorldConfig> = {
  'round-64x32': ROUND_WORLD_64x32KM,
  'round-32x16': ROUND_WORLD_32x16KM,
  'round-16x8': ROUND_WORLD_16x8KM,
  'flat-16x16': FLAT_WORLD_16KM,
};
export const DEFAULT_WORLD_SHAPE: WorldShape = 'round-64x32';

export function isWorldShape(v: unknown): v is WorldShape {
  return typeof v === 'string' && Object.hasOwn(WORLD_SHAPES, v);
}

/** Maps x into [0, width) for wrapping worlds; returns x unchanged otherwise. */
export function normalizeX(world: WorldConfig, x: number): number {
  if (!world.wrapX) return x;
  const w = world.widthUnits;
  return ((x % w) + w) % w;
}

/** Whether a unit coordinate lies inside the world after X wrapping. */
export function isInWorld(world: WorldConfig, x: number, y: number, z: number): boolean {
  const nx = normalizeX(world, x);
  return (
    nx >= 0 &&
    nx < world.widthUnits &&
    z >= 0 &&
    z < world.depthUnits &&
    y >= world.minYUnits &&
    y < world.maxYUnits
  );
}

/**
 * Shortest signed X distance from `fromX` to `toX`. On wrapping worlds this
 * may cross the east-west seam.
 */
export function deltaX(world: WorldConfig, fromX: number, toX: number): number {
  const d = toX - fromX;
  if (!world.wrapX) return d;
  const w = world.widthUnits;
  const m = ((d % w) + w) % w;
  return m > w / 2 ? m - w : m;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/** Chunk containing a unit coordinate (X is normalized first on wrapping worlds). */
export function chunkOf(world: WorldConfig, x: number, y: number, z: number): ChunkCoord {
  return {
    cx: Math.floor(normalizeX(world, x) / CHUNK_SIZE),
    cy: Math.floor(y / CHUNK_SIZE),
    cz: Math.floor(z / CHUNK_SIZE),
  };
}

export function chunkKey(c: ChunkCoord): string {
  return `${c.cx},${c.cy},${c.cz}`;
}

/**
 * Validates a chunk coordinate against the world and returns it with X
 * normalized (for wrapping worlds), or null if it lies outside the world.
 */
export function resolveChunk(world: WorldConfig, c: ChunkCoord): ChunkCoord | null {
  const chunksX = world.widthUnits / CHUNK_SIZE;
  const cx = world.wrapX ? ((c.cx % chunksX) + chunksX) % chunksX : c.cx;
  if (cx < 0 || cx >= chunksX) return null;
  if (c.cz < 0 || c.cz * CHUNK_SIZE >= world.depthUnits) return null;
  if ((c.cy + 1) * CHUNK_SIZE <= world.minYUnits || c.cy * CHUNK_SIZE >= world.maxYUnits) return null;
  return { cx, cy: c.cy, cz: c.cz };
}
