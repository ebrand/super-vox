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
  /**
   * Forest canopy floating above the ground, per sample: crown top and bottom (units; NO_GROUND
   * where there's none) and leaf material. Absent for tiles without trees.
   */
  canopyTop?: Int16Array;
  canopyBottom?: Int16Array;
  canopyMaterials?: Uint16Array;
  /** River and lake surfaces over the ground, per sample (units; NO_GROUND where none). */
  water?: Int16Array;
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
 * Tile format (little-endian): u8 version (3), u8 level, i32 tx, i32 tz,
 * then TILE_SAMPLES^2 x i16 heights, then TILE_SAMPLES^2 x u16 materials; then, if the tile
 * has a forest canopy, TILE_SAMPLES^2 each of i16 canopy tops, i16 canopy bottoms and u16
 * canopy materials; then, if it has rivers or lakes, TILE_SAMPLES^2 x i16 water surfaces
 * (NO_GROUND where none). Which parts are there follows from the length.
 */
export const TILE_FORMAT_VERSION = 3;
const HEADER = 10;
const N = TILE_SAMPLES * TILE_SAMPLES;

export class TileDecodeError extends Error {}

export function encodeTile(tile: Tile): Uint8Array {
  if (tile.heights.length !== N || tile.materials.length !== N) throw new RangeError('tile arrays must hold TILE_SAMPLES^2 entries');
  const canopy = tile.canopyTop && tile.canopyBottom && tile.canopyMaterials;
  if (canopy && (tile.canopyTop!.length !== N || tile.canopyBottom!.length !== N || tile.canopyMaterials!.length !== N)) {
    throw new RangeError('tile canopy arrays must hold TILE_SAMPLES^2 entries');
  }
  if (tile.water && tile.water.length !== N) throw new RangeError('tile water must hold TILE_SAMPLES^2 entries');
  const water = HEADER + N * (canopy ? 10 : 4);
  const buf = new Uint8Array(water + (tile.water ? N * 2 : 0));
  const v = new DataView(buf.buffer);
  v.setUint8(0, TILE_FORMAT_VERSION);
  v.setUint8(1, tile.level);
  v.setInt32(2, tile.tx, true);
  v.setInt32(6, tile.tz, true);
  for (let i = 0; i < N; i++) {
    v.setInt16(HEADER + i * 2, tile.heights[i]!, true);
    v.setUint16(HEADER + N * 2 + i * 2, tile.materials[i]!, true);
    if (canopy) {
      v.setInt16(HEADER + N * 4 + i * 2, tile.canopyTop![i]!, true);
      v.setInt16(HEADER + N * 6 + i * 2, tile.canopyBottom![i]!, true);
      v.setUint16(HEADER + N * 8 + i * 2, tile.canopyMaterials![i]!, true);
    }
    if (tile.water) v.setInt16(water + i * 2, tile.water[i]!, true);
  }
  return buf;
}

export function decodeTile(bytes: Uint8Array): Tile {
  const perSample = (bytes.byteLength - HEADER) / N;
  if (![4, 6, 10, 12].includes(perSample)) {
    throw new TileDecodeError(`tile must be ${HEADER} + ${N} x 4, 6, 10 or 12 bytes, got ${bytes.byteLength}`);
  }
  const canopy = perSample >= 10, hasWater = perSample === 6 || perSample === 12;
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
  const tile: Tile = { level, tx: v.getInt32(2, true), tz: v.getInt32(6, true), heights, materials };
  if (canopy) {
    tile.canopyTop = new Int16Array(N);
    tile.canopyBottom = new Int16Array(N);
    tile.canopyMaterials = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      tile.canopyTop[i] = v.getInt16(HEADER + N * 4 + i * 2, true);
      tile.canopyBottom[i] = v.getInt16(HEADER + N * 6 + i * 2, true);
      tile.canopyMaterials[i] = v.getUint16(HEADER + N * 8 + i * 2, true);
    }
  }
  if (hasWater) {
    const at = HEADER + N * (canopy ? 10 : 4);
    tile.water = new Int16Array(N);
    for (let i = 0; i < N; i++) tile.water[i] = v.getInt16(at + i * 2, true);
  }
  return tile;
}

/** Reads the tile coordinates from an encoded tile. */
export function readTileHeader(bytes: Uint8Array): TileCoord {
  if (bytes.byteLength < HEADER) throw new TileDecodeError('truncated tile');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { level: v.getUint8(1), tx: v.getInt32(2, true), tz: v.getInt32(6, true) };
}
