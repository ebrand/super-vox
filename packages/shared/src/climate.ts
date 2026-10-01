import type { Ecotone } from './biomes.js';

/**
 * A world's climate on its terrain grid, for blending biome colours: sea-level temperature and
 * moisture per cell, how temperature falls with height, and how widely biomes blend.
 */
export interface ClimateGrid {
  cols: number;
  rows: number;
  /** Cell size (units); cell (c, r) is centred at ((c + 0.5) * cell, (r + 0.5) * cell). */
  cell: number;
  seaLevel: number;
  /** Degrees C colder per unit of height above the sea. */
  cooling: number;
  ecotone: Ecotone;
  /** Per cell, row-major: degrees C at sea level, and moisture 0..1. */
  temperature: Float32Array;
  moisture: Float32Array;
}

const HEADER = 24;
/** Temperatures are sent in half degrees from -64 C (0) to 63.5 C (255). */
const T_MIN = -64;

/** Temperature (degrees C) as a byte, and back. */
export function temperatureByte(t: number): number {
  return Math.max(0, Math.min(255, Math.round((t - T_MIN) * 2)));
}
export function byteTemperature(b: number): number {
  return b / 2 + T_MIN;
}

/**
 * Binary format (little-endian): u16 cols, u16 rows, u32 cell, i32 sea level, f32 cooling,
 * f32 ecotone degrees, f32 ecotone moisture, then per cell (row-major) a u8 temperature (half
 * degrees above -64 C) and a u8 moisture (0..255), interleaved.
 */
export function encodeClimate(c: ClimateGrid): Uint8Array {
  const n = c.cols * c.rows;
  const buf = new Uint8Array(HEADER + n * 2);
  const v = new DataView(buf.buffer);
  v.setUint16(0, c.cols, true);
  v.setUint16(2, c.rows, true);
  v.setUint32(4, c.cell, true);
  v.setInt32(8, c.seaLevel, true);
  v.setFloat32(12, c.cooling, true);
  v.setFloat32(16, c.ecotone.degrees, true);
  v.setFloat32(20, c.ecotone.moisture, true);
  for (let i = 0; i < n; i++) {
    buf[HEADER + 2 * i] = temperatureByte(c.temperature[i]!);
    buf[HEADER + 2 * i + 1] = Math.max(0, Math.min(255, Math.round(c.moisture[i]! * 255)));
  }
  return buf;
}

/** Decodes encodeClimate's bytes; `cells` is the interleaved temperature/moisture bytes as sent. */
export function decodeClimate(bytes: Uint8Array): ClimateGrid & { cells: Uint8Array } {
  if (bytes.byteLength < HEADER) throw new RangeError('climate data too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cols = v.getUint16(0, true), rows = v.getUint16(2, true), n = cols * rows;
  if (bytes.byteLength !== HEADER + n * 2) throw new RangeError(`climate data is ${bytes.byteLength} bytes; expected ${HEADER + n * 2}`);
  const cells = bytes.subarray(HEADER);
  const temperature = new Float32Array(n), moisture = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    temperature[i] = byteTemperature(cells[2 * i]!);
    moisture[i] = cells[2 * i + 1]! / 255;
  }
  return {
    cols,
    rows,
    cell: v.getUint32(4, true),
    seaLevel: v.getInt32(8, true),
    cooling: v.getFloat32(12, true),
    ecotone: { degrees: v.getFloat32(16, true), moisture: v.getFloat32(20, true) },
    temperature,
    moisture,
    cells,
  };
}
