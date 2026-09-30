import { CHUNK_SIZE, type WorldConfig } from './world.js';

/**
 * Low-detail terrain tiles for distant rendering. A level-L tile (L >= 1)
 * covers 2^L x 2^L chunk columns and holds TILE_SAMPLES x TILE_SAMPLES
 * ground heights and top materials, one per cell of TILE_SAMPLES^2 equal
 * cells, sampled at each cell's centre column.
 */
export const TILE_SAMPLES = 32;
export const MIN_TILE_LEVEL = 1;
/** Level 6 tiles are 1024 m across. */
export const MAX_TILE_LEVEL = 6;
/** Height of a sample outside the world (no ground there). */
export const NO_GROUND = -32768;

export interface TileCoord {
  level: number;
  tx: number;
  tz: number;
}

export interface Tile extends TileCoord {
  /** TILE_SAMPLES^2 heights in units (row-major, i + TILE_SAMPLES * j), or NO_GROUND. */
  heights: Int16Array;
  materials: Uint16Array;
}

export function tileSizeUnits(level: number): number {
  return CHUNK_SIZE * 2 ** level;
}

/** Width of one tile cell in units. */
export function tileStep(level: number): number {
  return tileSizeUnits(level) / TILE_SAMPLES;
}

export function tileKey(t: TileCoord): string {
  return `${t.level}:${t.tx},${t.tz}`;
}

export function isValidTileLevel(level: unknown): level is number {
  return typeof level === 'number' && Number.isInteger(level) && level >= MIN_TILE_LEVEL && level <= MAX_TILE_LEVEL;
}

/** Whether any part of the tile lies inside the world (tiles may overhang its edge). */
export function tileInWorld(world: WorldConfig, t: TileCoord): boolean {
  const size = tileSizeUnits(t.level);
  const x0 = t.tx * size, z0 = t.tz * size;
  const xOk = world.wrapX || (x0 + size > 0 && x0 < world.widthUnits);
  return xOk && z0 + size > 0 && z0 < world.depthUnits;
}

/**
 * Tile format (little-endian): u8 version (1), u8 level, i32 tx, i32 tz,
 * then TILE_SAMPLES^2 x i16 heights, then TILE_SAMPLES^2 x u16 materials.
 */
export const TILE_FORMAT_VERSION = 1;
const HEADER = 10;
const N = TILE_SAMPLES * TILE_SAMPLES;

export class TileDecodeError extends Error {}

export function encodeTile(tile: Tile): Uint8Array {
  if (tile.heights.length !== N || tile.materials.length !== N) throw new RangeError('tile arrays must hold TILE_SAMPLES^2 entries');
  const buf = new Uint8Array(HEADER + N * 4);
  const v = new DataView(buf.buffer);
  v.setUint8(0, TILE_FORMAT_VERSION);
  v.setUint8(1, tile.level);
  v.setInt32(2, tile.tx, true);
  v.setInt32(6, tile.tz, true);
  for (let i = 0; i < N; i++) {
    v.setInt16(HEADER + i * 2, tile.heights[i]!, true);
    v.setUint16(HEADER + N * 2 + i * 2, tile.materials[i]!, true);
  }
  return buf;
}

export function decodeTile(bytes: Uint8Array): Tile {
  if (bytes.byteLength !== HEADER + N * 4) throw new TileDecodeError(`tile must be ${HEADER + N * 4} bytes, got ${bytes.byteLength}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== TILE_FORMAT_VERSION) throw new TileDecodeError(`unsupported tile format ${v.getUint8(0)}`);
  const level = v.getUint8(1);
  if (!isValidTileLevel(level)) throw new TileDecodeError(`invalid tile level ${level}`);
  const heights = new Int16Array(N);
  const materials = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    heights[i] = v.getInt16(HEADER + i * 2, true);
    materials[i] = v.getUint16(HEADER + N * 2 + i * 2, true);
  }
  return { level, tx: v.getInt32(2, true), tz: v.getInt32(6, true), heights, materials };
}

/** Reads the tile coordinates from an encoded tile. */
export function readTileHeader(bytes: Uint8Array): TileCoord {
  if (bytes.byteLength < HEADER) throw new TileDecodeError('truncated tile');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { level: v.getUint8(1), tx: v.getInt32(2, true), tz: v.getInt32(6, true) };
}
