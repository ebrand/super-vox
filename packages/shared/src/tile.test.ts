import { describe, expect, it } from 'vitest';
import {
  MAX_TILE_LEVEL,
  NO_GROUND,
  TILE_SAMPLES,
  TileDecodeError,
  decodeTile,
  encodeTile,
  readTileHeader,
  tileInWorld,
  tileSizeUnits,
  tileStep,
  type Tile,
} from './tile.js';
import { FLAT_WORLD_16KM, ROUND_WORLD_16x8KM } from './world.js';

const N = TILE_SAMPLES * TILE_SAMPLES;

function sampleTile(): Tile {
  const heights = new Int16Array(N);
  const materials = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    heights[i] = (i * 37) % 2000 - 1000;
    materials[i] = i % 5;
  }
  heights[7] = NO_GROUND;
  return { level: 3, tx: -12, tz: 99, heights, materials };
}

describe('tiles', () => {
  it('have sizes that double per level and a whole-unit step', () => {
    expect(tileSizeUnits(1)).toBe(512);
    expect(tileSizeUnits(MAX_TILE_LEVEL)).toBe(16384);
    for (let l = 1; l <= MAX_TILE_LEVEL; l++) expect(Number.isInteger(tileStep(l))).toBe(true);
  });

  it('round-trip through the codec', () => {
    const t = sampleTile();
    const bytes = encodeTile(t);
    expect(decodeTile(bytes)).toEqual(t);
    expect(readTileHeader(bytes)).toEqual({ level: 3, tx: -12, tz: 99 });
  });

  it('reject malformed data', () => {
    const bytes = encodeTile(sampleTile());
    expect(() => decodeTile(bytes.subarray(0, bytes.length - 1))).toThrow(TileDecodeError);
    const badLevel = bytes.slice();
    badLevel[1] = 0;
    expect(() => decodeTile(badLevel)).toThrow(/level/);
    const badVersion = bytes.slice();
    badVersion[0] = 9;
    expect(() => decodeTile(badVersion)).toThrow(/format/);
    expect(() => encodeTile({ ...sampleTile(), heights: new Int16Array(3) })).toThrow(RangeError);
  });

  it('know whether they touch the world', () => {
    const last = Math.floor(FLAT_WORLD_16KM.widthUnits / tileSizeUnits(4));
    expect(tileInWorld(FLAT_WORLD_16KM, { level: 4, tx: last, tz: 0 })).toBe(true); // overhangs the edge
    expect(tileInWorld(FLAT_WORLD_16KM, { level: 4, tx: last + 1, tz: 0 })).toBe(false);
    expect(tileInWorld(FLAT_WORLD_16KM, { level: 1, tx: -1, tz: 0 })).toBe(false);
    expect(tileInWorld(ROUND_WORLD_16x8KM, { level: 1, tx: -1, tz: 0 })).toBe(true); // X wraps
    expect(tileInWorld(ROUND_WORLD_16x8KM, { level: 1, tx: 0, tz: -1 })).toBe(false);
  });

  it('round-trips a forest canopy, and leaves tiles without one at the old size', () => {
    const N = TILE_SAMPLES * TILE_SAMPLES;
    const base = { level: 2, tx: 3, tz: -4, heights: new Int16Array(N).fill(100), materials: new Uint16Array(N).fill(3) };
    expect(encodeTile(base).byteLength).toBe(10 + N * 4);
    const canopyTop = new Int16Array(N).fill(NO_GROUND), canopyBottom = new Int16Array(N).fill(NO_GROUND), canopyMaterials = new Uint16Array(N);
    canopyTop[5] = 400; canopyBottom[5] = 200; canopyMaterials[5] = 13;
    const bytes = encodeTile({ ...base, canopyTop, canopyBottom, canopyMaterials });
    expect(bytes.byteLength).toBe(10 + N * 10);
    const back = decodeTile(bytes);
    expect(back.canopyTop).toEqual(canopyTop);
    expect(back.canopyBottom).toEqual(canopyBottom);
    expect(back.canopyMaterials).toEqual(canopyMaterials);
    expect(back.heights).toEqual(base.heights);
    expect(decodeTile(encodeTile(base)).canopyTop).toBeUndefined();
  });
});
