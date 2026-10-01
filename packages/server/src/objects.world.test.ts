import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditError, FLAT_WORLD_16KM, FlatGenerator, Material, blockIndex, blockVoxels, decodeChunk, defaultFlatGen, type Block } from '@super-vox/shared';
import { FileChunkStore } from './chunkStore.js';
import { World } from './world.js';

/** Flat ground at y = 0, so block y = 0 is the first block of air above it. */
function flat(store?: FileChunkStore) {
  return new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), store ? { store } : {});
}

/** The block (1 m block coordinates) as the world now has it. */
function block(w: World, bx: number, by: number, bz: number): Block {
  const n = 16;
  const bytes = w.getEncodedChunk({ cx: Math.floor(bx / n), cy: Math.floor(by / n), cz: Math.floor(bz / n) })!;
  const mod = (v: number) => ((v % n) + n) % n;
  return decodeChunk(bytes).blocks[blockIndex(mod(bx), mod(by), mod(bz))] ?? null;
}
const extent = (b: Block) => {
  const v = blockVoxels(b);
  return { x: [Math.min(...v.map((q) => q.x)), Math.max(...v.map((q) => q.x + q.size))], z: [Math.min(...v.map((q) => q.z)), Math.max(...v.map((q) => q.z + q.size))] };
};

describe('placed objects', () => {
  it('join fences to their neighbours, and let go when one is taken down', () => {
    const w = flat();
    w.placeObject('fence', 100, 0, 100, 'n');
    expect(extent(block(w, 100, 0, 100))).toEqual({ x: [6, 10], z: [6, 10] }); // a post alone
    w.placeObject('fence', 101, 0, 100, 'n');
    expect(extent(block(w, 100, 0, 100)).x).toEqual([6, 16]); // now reaching east
    expect(extent(block(w, 101, 0, 100)).x).toEqual([0, 10]); // and west
    expect(blockVoxels(block(w, 100, 0, 100)).every((v) => v.material === Material.FenceWood)).toBe(true);
    const result = w.removeObject(w.objectAt(101, 0, 100)!);
    expect(block(w, 101, 0, 100)).toBeNull();
    expect(extent(block(w, 100, 0, 100)).x).toEqual([6, 10]);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('open and close gates and doors, and join fences to a gate in their line', () => {
    const w = flat();
    w.placeObject('gate', 200, 0, 200, 'n'); // spans x
    w.placeObject('fence', 199, 0, 200, 'n');
    expect(extent(block(w, 199, 0, 200)).x).toEqual([6, 16]);
    const closed = extent(block(w, 200, 0, 200));
    w.toggleObject(w.objectAt(200, 0, 200)!);
    expect(w.objectAt(200, 0, 200)!.open).toBe(true);
    expect(extent(block(w, 200, 0, 200))).not.toEqual(closed);
    w.toggleObject(w.objectAt(200, 0, 200)!);
    expect(extent(block(w, 200, 0, 200))).toEqual(closed);
    // A door is two blocks; either one is the door.
    w.placeObject('door', 210, 0, 210, 'e');
    expect(w.objectAt(210, 1, 210)).toBe(w.objectAt(210, 0, 210));
    w.toggleObject(w.objectAt(210, 1, 210)!);
    expect(extent(block(w, 210, 0, 210))).toEqual(extent(block(w, 210, 1, 210)));
    expect(() => w.toggleObject(w.objectAt(199, 0, 200)!)).toThrow(EditError);
  });

  it('need empty room, and keep ordinary edits out of them', () => {
    const w = flat();
    expect(() => w.placeObject('fence', 50, -1, 50, 'n')).toThrow(/empty block/); // the ground
    w.applyEdit({ op: 'place', x: 300 * 16, y: 16, z: 300 * 16, size: 16, material: Material.Stone });
    expect(() => w.placeObject('door', 300, 0, 300, 'n')).toThrow(/two empty blocks/); // stone in the top half
    w.placeObject('door', 301, 0, 300, 'n');
    expect(() => w.placeObject('fence', 301, 1, 300, 'n')).toThrow(/already something there/);
    expect(() => w.applyEdit({ op: 'place', x: 301 * 16, y: 20, z: 300 * 16, size: 2, material: Material.Stone })).toThrow(/door: left-click/);
    expect(() => w.applyEdit({ op: 'break', x: 301 * 16, y: 0, z: 300 * 16 + 15, pieceSize: 1 })).toThrow(/door/);
    expect(() => w.applyEdit({ op: 'removeBox', x: 300 * 16, y: 0, z: 300 * 16, size: 32 })).toThrow(/door/);
  });

  it('are kept with the world', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv-objects-'));
    try {
      const w = flat(new FileChunkStore(dir));
      w.placeObject('door', 10, 0, 10, 's');
      w.toggleObject(w.objectAt(10, 0, 10)!);
      w.placeObject('fence', 12, 0, 10, 'n');
      const again = flat(new FileChunkStore(dir));
      expect(again.objectAt(10, 1, 10)).toEqual({ kind: 'door', x: 10, y: 0, z: 10, facing: 's', open: true });
      expect(again.objectAt(12, 0, 10)?.kind).toBe('fence');
      expect(blockVoxels(block(again, 10, 0, 10)).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
