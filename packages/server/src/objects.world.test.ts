import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditError, FLAT_WORLD_16KM, FlatGenerator, Item, Material, blockIndex, blockVoxels, decodeChunk, defaultFlatGen, objectItem, type Block } from '@super-vox/shared';
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

  it('stand torches on the ground or put them on walls, and want something to hold them', () => {
    const w = flat();
    w.placeObject('torch', 300, 0, 300, 'n');
    const standing = blockVoxels(block(w, 300, 0, 300));
    expect(standing.some((v) => v.material === Material.TorchFlame)).toBe(true);
    expect(standing.some((v) => v.material === Material.TorchWood)).toBe(true);
    // In the air: nothing under it.
    expect(() => w.placeObject('torch', 302, 3, 300, 'n')).toThrow(/nothing under it/);
    // On a wall: a stone block at (310, 0, 309), the torch south of it, against its side (north).
    w.applyEdit({ op: 'place', x: 310 * 16, y: 0, z: 309 * 16, size: 16, material: Material.Stone });
    w.placeObject('torch', 310, 0, 310, 'n', true);
    expect(w.objectAt(310, 0, 310)).toMatchObject({ kind: 'torch', facing: 'n', wall: true });
    // Against the wall: its stick touches the north side of its block.
    expect(Math.min(...blockVoxels(block(w, 310, 0, 310)).map((v) => v.z))).toBe(0);
    // No wall to the east of it.
    expect(() => w.placeObject('torch', 312, 0, 310, 'e', true)).toThrow(/nothing to hold it/);
    // Taking it down gives back a torch.
    expect(objectItem(w.objectAt(310, 0, 310)!)).toBe(Item.Torch);
  });

  it('stand torches on the ground inside a partly filled block, reaching up into the next if they must', () => {
    const w = flat();
    const fill = (bx: number, by: number, bz: number, top: number) => {
      for (let y = 0; y < top; y += 2) for (let z = 0; z < 16; z += 2) for (let x = 0; x < 16; x += 2) w.applyEdit({ op: 'place', x: bx * 16 + x, y: by * 16 + y, z: bz * 16 + z, size: 2, material: Material.Dirt });
    };
    const dirt = (b: Block) => blockVoxels(b).filter((v) => v.material === Material.Dirt).length;
    // Ground 1/8 m deep in the block: the torch stands on it, all in that block.
    fill(400, 0, 400, 2);
    w.placeObject('torch', 400, 0, 400, 'n');
    const low = blockVoxels(block(w, 400, 0, 400));
    expect(Math.min(...low.filter((v) => v.material !== Material.Dirt).map((v) => v.y))).toBe(2);
    expect(block(w, 400, 1, 400)).toBeNull();
    // Ground 3/8 m deep: it reaches into the block above, and takes both.
    fill(402, 0, 400, 6);
    w.placeObject('torch', 402, 0, 400, 'n');
    expect(blockVoxels(block(w, 402, 1, 400)).some((v) => v.material === Material.TorchFlame)).toBe(true);
    expect(w.objectAt(402, 1, 400)).toBe(w.objectAt(402, 0, 400));
    // Taken down: the ground stays as it was, the block above empty again.
    const before = dirt(block(w, 402, 0, 400));
    w.removeObject(w.objectAt(402, 0, 400)!);
    expect(dirt(block(w, 402, 0, 400))).toBe(before);
    expect(blockVoxels(block(w, 402, 0, 400)).some((v) => v.material === Material.TorchWood)).toBe(false);
    expect(block(w, 402, 1, 400)).toBeNull();
    // Aimed at a block whose ground fills it under the torch, with more ground in the block above:
    // it stands on that, a block up.
    fill(406, 0, 400, 16);
    fill(406, 1, 400, 4);
    w.placeObject('torch', 406, 0, 400, 'n');
    expect(w.objectAt(406, 0, 400)).toBeUndefined();
    expect(w.objectAt(406, 1, 400)).toMatchObject({ kind: 'torch', y: 1 });
    expect(Math.min(...blockVoxels(block(w, 406, 1, 400)).filter((v) => v.material === Material.TorchWood).map((v) => v.y))).toBe(4);
    // A wall torch where the ground is in its way: doesn't fit.
    w.applyEdit({ op: 'place', x: 404 * 16, y: 0, z: 399 * 16, size: 16, material: Material.Stone });
    fill(404, 0, 400, 16);
    expect(() => w.placeObject('torch', 404, 0, 400, 'n', true)).toThrow(/doesn't fit/);
  });

  it("know the light anywhere: the sky over open ground, a torch's light by how far off it is, none under a roof", () => {
    const w = flat();
    expect(w.lightAt(500, 0, 500)).toEqual({ sky: 15, block: 0 });
    w.placeObject('torch', 500, 0, 500, 'n');
    expect(w.lightAt(500, 0, 500).block).toBe(14);
    expect(w.lightAt(503, 0, 500).block).toBe(11);
    expect(w.lightAt(500, 0, 520).block).toBe(0);
    // A stone block over (510, 0, 510): no longer open to the sky; light from beside it, one less.
    w.applyEdit({ op: 'place', x: 510 * 16, y: 2 * 16, z: 510 * 16, size: 16, material: Material.Stone });
    expect(w.skyOpenAt(510, 0, 510)).toBe(false);
    expect(w.skyOpenAt(511, 0, 510)).toBe(true);
    expect(w.lightAt(510, 0, 510).sky).toBe(14);
    // In the rock: none.
    expect(w.lightAt(510, -3, 510)).toEqual({ sky: 0, block: 0 });
  });

  it('know where the sky is open after edits, both ways (what was looked up before is kept, so must follow them)', () => {
    const w = flat();
    // Looked at first: open.
    expect(w.skyOpenAt(600, 0, 600)).toBe(true);
    // A roof high over it: shut.
    w.applyEdit({ op: 'place', x: 600 * 16, y: 20 * 16, z: 600 * 16, size: 16, material: Material.Stone });
    expect(w.skyOpenAt(600, 0, 600)).toBe(false);
    expect(w.skyOpenAt(600, 21, 600)).toBe(true);
    expect(w.lightAt(600, 0, 600).sky).toBeLessThan(15);
    // Taken away: open again.
    w.applyEdit({ op: 'remove', x: 600 * 16, y: 20 * 16, z: 600 * 16 });
    expect(w.skyOpenAt(600, 0, 600)).toBe(true);
    expect(w.lightAt(600, 0, 600).sky).toBe(15);
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
