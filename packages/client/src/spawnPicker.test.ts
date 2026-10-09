import { describe, expect, it } from 'vitest';
import { UNITS_PER_METER } from '@super-vox/shared';
import { inSea, onMap, pickOnMap } from './spawnPicker.js';
import type { MapData } from './worldMap.js';

/** A 4 x 2 sample map, 100 m a sample: sea (height -10) in its west half, land (20) east. */
function map(): MapData {
  const cols = 4, rows = 2, heights = new Int16Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) heights[i + cols * j] = i < 2 ? -10 : 20;
  return { cols, rows, step: 100 * UNITS_PER_METER, seaLevel: 0, heights, materials: new Uint8Array(cols * rows) };
}

describe('picking a spawn point on a map', () => {
  it('turns a click (of the way across and down) into metres, and says if it is in the sea', () => {
    expect(pickOnMap(map(), 0.75, 0.5)).toEqual({ x: 300, z: 100, sea: false });
    expect(pickOnMap(map(), 0.1, 0.9)).toEqual({ x: 40, z: 180, sea: true });
    // (Past the edge: at it.)
    expect(pickOnMap(map(), 1.2, -0.1)).toMatchObject({ x: 400, z: 0 });
  });

  it('puts a spot back where it is on the map; a map with no sea has none', () => {
    expect(onMap(map(), 300, 100)).toEqual({ fx: 0.75, fy: 0.5 });
    expect(inSea(map(), 350, 50)).toBe(false);
    expect(inSea({ ...map(), seaLevel: null }, 10, 10)).toBe(false);
  });
});
