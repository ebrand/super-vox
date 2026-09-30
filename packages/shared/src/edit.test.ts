import { describe, expect, it } from 'vitest';
import { blockIndex, emptyChunk, voxelAt, type Chunk } from './chunk.js';
import { decodeChunk, encodeChunk } from './chunkcodec.js';
import { EditError, applyEdit, blockVoxels, editChunk, removeBoxChunks, removeBoxFromChunk, type Edit } from './edit.js';
import { FlatGenerator, defaultFlatGen } from './flatgen.js';
import { Material } from './materials.js';
import { FLAT_WORLD_16KM } from './world.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A chunk at (1, -1, 2) whose block (0,0,0) holds `block`. World origin of that block: (256, -256, 512). */
function chunkWith(block: Chunk['blocks'][number]): Chunk {
  const c = emptyChunk({ cx: 1, cy: -1, cz: 2 });
  c.blocks[0] = block;
  return c;
}
const O = { x: 256, y: -256, z: 512 };
const at = (x: number, y: number, z: number) => ({ x: O.x + x, y: O.y + y, z: O.z + z });

describe('applyEdit', () => {
  it('removes a whole 1 m voxel, leaving an empty block', () => {
    const c = applyEdit(chunkWith({ kind: 'uniform', size: 16, material: 1 }), { op: 'remove', ...at(5, 5, 5) });
    expect(c.blocks[0]).toBeNull();
  });

  it('removes just the targeted voxel from a uniform block of small voxels', () => {
    const c = applyEdit(chunkWith({ kind: 'uniform', size: 4, material: 2 }), { op: 'remove', ...at(5, 9, 1) });
    expect(blockVoxels(c.blocks[0]!)).toHaveLength(63);
    expect(voxelAt(c, 4, 8, 0)).toBeNull();
    expect(voxelAt(c, 7, 11, 3)).toBeNull();
    expect(voxelAt(c, 8, 8, 0)).toEqual({ material: 2, size: 4 });
  });

  it('breaks a voxel into equal pieces that fill exactly the same space', () => {
    const c = applyEdit(chunkWith({ kind: 'uniform', size: 16, material: 3 }), { op: 'break', ...at(0, 0, 0), pieceSize: 4 });
    const vs = blockVoxels(c.blocks[0]!);
    expect(vs).toHaveLength(64);
    expect(vs.every((v) => v.size === 4 && v.material === 3)).toBe(true);
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) expect(voxelAt(c, x, y, z)?.size).toBe(4);
  });

  it('refuses breaks into sizes that do not divide the voxel, and breaking air', () => {
    const c = chunkWith({ kind: 'uniform', size: 16, material: 3 });
    expect(() => applyEdit(c, { op: 'break', ...at(0, 0, 0), pieceSize: 3 })).toThrow(/cannot be broken/);
    expect(() => applyEdit(c, { op: 'break', ...at(0, 0, 0), pieceSize: 16 })).toThrow(EditError);
    expect(() => applyEdit(chunkWith(null), { op: 'break', ...at(0, 0, 0), pieceSize: 8 })).toThrow(/nothing/);
    expect(() => applyEdit(chunkWith(null), { op: 'remove', ...at(0, 0, 0) })).toThrow(/nothing/);
  });

  it('places voxels of any size inside one block, and nowhere they overlap or cross a gridline', () => {
    let c = applyEdit(chunkWith(null), { op: 'place', ...at(2, 3, 4), size: 3, material: Material.Stone });
    expect(voxelAt(c, 2, 3, 4)).toEqual({ material: 1, size: 3 });
    expect(voxelAt(c, 4, 5, 6)).toEqual({ material: 1, size: 3 });
    expect(voxelAt(c, 5, 3, 4)).toBeNull();
    c = applyEdit(c, { op: 'place', ...at(5, 3, 4), size: 11, material: Material.Dirt });
    expect(() => applyEdit(c, { op: 'place', ...at(4, 5, 6), size: 1, material: 1 })).toThrow(/occupied/);
    expect(() => applyEdit(chunkWith(null), { op: 'place', ...at(8, 0, 0), size: 12, material: 1 })).toThrow(/gridline/);
    expect(() => applyEdit(chunkWith(null), { op: 'place', ...at(0, 0, 0), size: 17, material: 1 })).toThrow(/size/);
    expect(() => applyEdit(chunkWith(null), { op: 'place', ...at(0, 0, 0), size: 4, material: 0 })).toThrow(/material/);
    // A single full-size voxel collapses back to a uniform block.
    expect(applyEdit(chunkWith(null), { op: 'place', ...at(0, 0, 0), size: 16, material: 2 }).blocks[0]).toEqual({ kind: 'uniform', size: 16, material: 2 });
  });

  it('rejects targets outside the chunk', () => {
    expect(() => applyEdit(chunkWith(null), { op: 'remove', x: 0, y: 0, z: 0 })).toThrow(/not in chunk/);
  });

  it('never mutates the input chunk or blocks shared with other chunks', () => {
    const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4));
    const a = gen.generateChunk({ cx: 0, cy: -1, cz: 0 });
    const b = gen.generateChunk({ cx: 1, cy: -1, cz: 0 });
    const shared = a.blocks[blockIndex(0, 15, 0)]!;
    expect(b.blocks[blockIndex(0, 15, 0)]).toBe(shared);
    const before = encodeChunk(a);
    const edited = applyEdit(a, { op: 'remove', x: 0, y: -4, z: 0 });
    expect(encodeChunk(a)).toEqual(before);
    expect(b.blocks[blockIndex(0, 15, 0)]).toBe(shared);
    expect(edited.blocks[blockIndex(0, 15, 0)]).not.toBe(shared);
    expect(edited.blocks[blockIndex(1, 15, 0)]).toBe(shared); // untouched blocks are reused
  });

  it('matches a unit-cell reference model over random edit sequences', () => {
    const rand = rng(7);
    for (let trial = 0; trial < 6; trial++) {
      let c = chunkWith(trial % 2 ? { kind: 'uniform', size: [1, 2, 4, 8, 16][trial % 5]!, material: 1 } : null);
      // Reference: material and voxel size per unit cell of block (0,0,0).
      const mat = new Int32Array(4096), size = new Int32Array(4096);
      const idx = (x: number, y: number, z: number) => x + 16 * (z + 16 * y);
      const sync = () => {
        for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          const v = voxelAt(c, x, y, z);
          mat[idx(x, y, z)] = v?.material ?? 0;
          size[idx(x, y, z)] = v?.size ?? 0;
        }
      };
      sync();
      for (let step = 0; step < 60; step++) {
        const [x, y, z] = [0, 0, 0].map(() => Math.floor(rand() * 16)) as [number, number, number];
        const roll = rand();
        const edit: Edit =
          roll < 0.35 ? { op: 'remove', ...at(x, y, z) }
          : roll < 0.6 ? { op: 'break', ...at(x, y, z), pieceSize: 1 + Math.floor(rand() * 8) }
          : { op: 'place', ...at(x, y, z), size: 1 + Math.floor(rand() * 6), material: 1 + Math.floor(rand() * 3) };
        const prevMat = mat.slice(), prevSize = size.slice();
        let next: Chunk | null = null;
        try {
          next = applyEdit(c, edit);
        } catch (e) {
          expect(e).toBeInstanceOf(EditError);
        }
        if (!next) {
          // A rejected edit changes nothing.
          continue;
        }
        c = next;
        sync();
        // Check the change against the edit's intent.
        let changed = 0;
        for (let yy = 0; yy < 16; yy++) for (let zz = 0; zz < 16; zz++) for (let xx = 0; xx < 16; xx++) {
          const i = idx(xx, yy, zz);
          if (edit.op === 'place') {
            const inside = xx >= x && xx < x + edit.size && yy >= y && yy < y + edit.size && zz >= z && zz < z + edit.size;
            expect(mat[i]).toBe(inside ? edit.material : prevMat[i]);
            if (inside) expect(prevMat[i]).toBe(0);
          } else if (edit.op === 'remove') {
            // Removed cells were solid and are now air; nothing else changed.
            if (mat[i] !== prevMat[i]) {
              expect(mat[i]).toBe(0);
              changed++;
            }
          } else {
            // Break keeps materials; sizes change only inside the target voxel.
            expect(mat[i]).toBe(prevMat[i]);
            if (size[i] !== prevSize[i]) {
              expect(size[i]).toBe(edit.pieceSize);
              changed++;
            }
          }
        }
        // Exactly the whole target voxel changed.
        if (edit.op !== 'place') expect(changed).toBe(prevSize[idx(x, y, z)]! ** 3);
        if (edit.op === 'remove') expect(mat[idx(x, y, z)]).toBe(0);
        // Every edited chunk still survives the codec.
        expect(decodeChunk(encodeChunk(c))).toEqual(c);
      }
    }
  });
});

describe('editChunk', () => {
  it('finds the chunk for negative coordinates too', () => {
    expect(editChunk({ op: 'remove', x: -1, y: -256, z: 255 })).toEqual({ cx: -1, cy: -1, cz: 0 });
  });
});

describe('removeBox', () => {
  it('lists every chunk the box overlaps', () => {
    expect(removeBoxChunks({ op: 'removeBox', x: 0, y: 0, z: 0, size: 16 })).toEqual([{ cx: 0, cy: 0, cz: 0 }]);
    expect(removeBoxChunks({ op: 'removeBox', x: 250, y: -3, z: 255, size: 8 })).toHaveLength(8);
  });

  it('removes exactly the voxels with any part inside the box, whole', () => {
    const rand = rng(11);
    for (let trial = 0; trial < 40; trial++) {
      // A chunk whose block (0,0,0) holds random non-overlapping voxels of any size.
      let c = chunkWith(null);
      for (let k = 0; k < 40; k++) {
        const size = 1 + Math.floor(rand() * 8);
        const [x, y, z] = [0, 0, 0].map(() => Math.floor(rand() * (17 - size)));
        try {
          c = applyEdit(c, { op: 'place', ...at(x!, y!, z!), size, material: 1 + (k % 3) });
        } catch {
          // occupied: skip
        }
      }
      const before = blockVoxels(c.blocks[0]!);
      const size = 1 + Math.floor(rand() * 16);
      const [bx, by, bz] = [0, 0, 0].map(() => Math.floor(rand() * 20) - 6) as [number, number, number];
      const box = { op: 'removeBox' as const, ...at(bx, by, bz), size };
      const hits = (v: { x: number; y: number; z: number; size: number }) =>
        v.x < bx + size && bx < v.x + v.size && v.y < by + size && by < v.y + v.size && v.z < bz + size && bz < v.z + v.size;
      const expected = before.filter((v) => !hits(v));
      const next = removeBoxFromChunk(c, box);
      if (expected.length === before.length) {
        expect(next).toBeNull();
        continue;
      }
      const after = next?.blocks[0] ? blockVoxels(next.blocks[0]) : [];
      const key = (v: { x: number; y: number; z: number; size: number; material: number }) => `${v.x},${v.y},${v.z},${v.size},${v.material}`;
      expect(after.map(key).sort()).toEqual(expected.map(key).sort());
    }
  });

  it('works on uniform and grid blocks and leaves shared blocks alone', () => {
    const gen = new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4));
    const a = gen.generateChunk({ cx: 0, cy: -1, cz: 0 });
    const shared = a.blocks[blockIndex(0, 15, 0)]!;
    const before = encodeChunk(a);
    // A 1/2 m cube at the surface, offset by 2: covers size-4 voxels from 0..12 on x and z, and y -8..0.
    const next = removeBoxFromChunk(a, { op: 'removeBox', x: 2, y: -8, z: 2, size: 8 })!;
    expect(encodeChunk(a)).toEqual(before);
    expect(a.blocks[blockIndex(0, 15, 0)]).toBe(shared);
    for (const [x, z] of [[0, 0], [11, 11], [4, 8]] as const) {
      expect(voxelAt(next, x, 255, z)).toBeNull();
      expect(voxelAt(next, x, 248, z)).toBeNull();
    }
    expect(voxelAt(next, 12, 255, 0)).not.toBeNull(); // x 12..15 untouched
    expect(voxelAt(next, 0, 247, 0)).not.toBeNull(); // below the box untouched
  });

  it('refuses invalid sizes and reports nothing to remove through applyEdit', () => {
    expect(() => removeBoxFromChunk(chunkWith(null), { op: 'removeBox', ...at(0, 0, 0), size: 17 })).toThrow(/size/);
    expect(() => applyEdit(chunkWith(null), { op: 'removeBox', ...at(0, 0, 0), size: 4 })).toThrow(/nothing/);
  });
});
