import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  FLAT_WORLD_16KM,
  ROUND_WORLD_16x8KM,
  chunkOf,
  deltaX,
  isInWorld,
  normalizeX,
  resolveChunk,
} from './world.js';

const W = ROUND_WORLD_16x8KM.widthUnits;

describe('world presets', () => {
  it('have the expected dimensions in units', () => {
    expect(FLAT_WORLD_16KM.widthUnits).toBe(256_000);
    expect(FLAT_WORLD_16KM.depthUnits).toBe(256_000);
    expect(ROUND_WORLD_16x8KM.widthUnits).toBe(256_000);
    expect(ROUND_WORLD_16x8KM.depthUnits).toBe(128_000);
    // 16 km / 16 m chunks = 1000 chunks per axis, no partial chunk at the seam.
    expect(W % CHUNK_SIZE).toBe(0);
    expect(ROUND_WORLD_16x8KM.depthUnits % CHUNK_SIZE).toBe(0);
  });
});

describe('X wrapping', () => {
  it('normalizes only on wrapping worlds', () => {
    expect(normalizeX(ROUND_WORLD_16x8KM, -1)).toBe(W - 1);
    expect(normalizeX(ROUND_WORLD_16x8KM, W)).toBe(0);
    expect(normalizeX(ROUND_WORLD_16x8KM, 3 * W + 5)).toBe(5);
    expect(normalizeX(FLAT_WORLD_16KM, -1)).toBe(-1);
  });

  it('bounds checks honor wrapping on X but not Z', () => {
    expect(isInWorld(ROUND_WORLD_16x8KM, -1, 0, 0)).toBe(true);
    expect(isInWorld(ROUND_WORLD_16x8KM, 0, 0, -1)).toBe(false);
    expect(isInWorld(ROUND_WORLD_16x8KM, 0, 0, ROUND_WORLD_16x8KM.depthUnits)).toBe(false);
    expect(isInWorld(FLAT_WORLD_16KM, -1, 0, 0)).toBe(false);
    expect(isInWorld(FLAT_WORLD_16KM, 0, FLAT_WORLD_16KM.maxYUnits, 0)).toBe(false);
    expect(isInWorld(FLAT_WORLD_16KM, 0, FLAT_WORLD_16KM.minYUnits, 0)).toBe(true);
  });

  it('computes shortest distance across the seam', () => {
    expect(deltaX(ROUND_WORLD_16x8KM, W - 10, 10)).toBe(20);
    expect(deltaX(ROUND_WORLD_16x8KM, 10, W - 10)).toBe(-20);
    expect(deltaX(FLAT_WORLD_16KM, 256_000 - 10, 10)).toBe(-(256_000 - 20));
  });

  it('assigns seam-adjacent coordinates to the right chunks', () => {
    expect(chunkOf(ROUND_WORLD_16x8KM, -1, 0, 0).cx).toBe(W / CHUNK_SIZE - 1);
    expect(chunkOf(ROUND_WORLD_16x8KM, W, 0, 0).cx).toBe(0);
    expect(chunkOf(FLAT_WORLD_16KM, 0, -1, 0).cy).toBe(-1);
  });
});

describe('resolveChunk', () => {
  const lastX = FLAT_WORLD_16KM.widthUnits / CHUNK_SIZE - 1;
  const floorCy = FLAT_WORLD_16KM.minYUnits / CHUNK_SIZE;
  const ceilCy = FLAT_WORLD_16KM.maxYUnits / CHUNK_SIZE - 1;

  it('accepts in-world chunks unchanged', () => {
    expect(resolveChunk(FLAT_WORLD_16KM, { cx: lastX, cy: floorCy, cz: 0 })).toEqual({ cx: lastX, cy: floorCy, cz: 0 });
    expect(resolveChunk(FLAT_WORLD_16KM, { cx: 0, cy: ceilCy, cz: lastX })).not.toBeNull();
  });

  it('rejects chunks outside a flat world', () => {
    for (const c of [
      { cx: -1, cy: 0, cz: 0 },
      { cx: lastX + 1, cy: 0, cz: 0 },
      { cx: 0, cy: 0, cz: -1 },
      { cx: 0, cy: 0, cz: lastX + 1 },
      { cx: 0, cy: floorCy - 1, cz: 0 },
      { cx: 0, cy: ceilCy + 1, cz: 0 },
    ]) {
      expect(resolveChunk(FLAT_WORLD_16KM, c)).toBeNull();
    }
  });

  it('wraps X on a round world but not Z', () => {
    const n = ROUND_WORLD_16x8KM.widthUnits / CHUNK_SIZE;
    expect(resolveChunk(ROUND_WORLD_16x8KM, { cx: -1, cy: 0, cz: 0 })).toEqual({ cx: n - 1, cy: 0, cz: 0 });
    expect(resolveChunk(ROUND_WORLD_16x8KM, { cx: n, cy: 0, cz: 0 })).toEqual({ cx: 0, cy: 0, cz: 0 });
    expect(resolveChunk(ROUND_WORLD_16x8KM, { cx: 0, cy: 0, cz: ROUND_WORLD_16x8KM.depthUnits / CHUNK_SIZE })).toBeNull();
  });
});
