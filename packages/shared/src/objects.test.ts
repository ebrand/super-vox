import { describe, expect, it } from 'vitest';
import { blockFromVoxels, blockVoxels, type BlockVoxel } from './edit.js';
import { FACINGS, doorVoxels, facingOfYaw, fenceJoins, fenceVoxels, gateVoxels, objectBlocks, type PlacedObject } from './objects.js';
import { Material } from './materials.js';

/** Unit cells a shape fills (also checks it makes a valid block: in bounds, no overlaps). */
function cells(voxels: BlockVoxel[]): Set<string> {
  blockFromVoxels(voxels);
  const out = new Set<string>();
  for (const v of voxels) for (let y = v.y; y < v.y + v.size; y++) for (let z = v.z; z < v.z + v.size; z++) for (let x = v.x; x < v.x + v.size; x++) out.add(`${x},${y},${z}`);
  return out;
}
const bounds = (voxels: BlockVoxel[]) => ({
  x: [Math.min(...voxels.map((v) => v.x)), Math.max(...voxels.map((v) => v.x + v.size))],
  z: [Math.min(...voxels.map((v) => v.z)), Math.max(...voxels.map((v) => v.z + v.size))],
});

describe('objects', () => {
  it('are valid blocks in every facing, open or closed, and every fence joining', () => {
    for (const f of FACINGS) {
      for (const open of [false, true]) {
        expect(cells(gateVoxels(f, open)).size).toBeGreaterThan(0);
        expect(cells(doorVoxels(f, open)).size).toBe(16 * 16 * 2); // a 1/8 m panel over the whole block
      }
    }
    for (let mask = 0; mask < 16; mask++) cells(fenceVoxels(FACINGS.filter((_, i) => mask & (1 << i))));
    expect(fenceVoxels([]).every((v) => v.material === Material.FenceWood)).toBe(true);
    expect(gateVoxels('n', false).every((v) => v.material === Material.GateWood)).toBe(true);
    // A round trip through a block keeps the shape.
    expect(cells(blockVoxels(blockFromVoxels(doorVoxels('e', true))))).toEqual(cells(doorVoxels('e', true)));
  });

  it('put a closed door on the edge nearest whoever placed it, and swing it to its side', () => {
    // Placed looking north (standing south of it): the south edge.
    expect(bounds(doorVoxels('n', false))).toEqual({ x: [0, 16], z: [14, 16] });
    expect(bounds(doorVoxels('e', false))).toEqual({ x: [0, 2], z: [0, 16] });
    expect(bounds(doorVoxels('s', false))).toEqual({ x: [0, 16], z: [0, 2] });
    expect(bounds(doorVoxels('n', true))).toEqual({ x: [0, 2], z: [0, 16] });
    // Doors are two blocks tall.
    const door: PlacedObject = { kind: 'door', x: 0, y: 0, z: 0, facing: 'n', open: false };
    expect(objectBlocks(door).map((b) => b.dy)).toEqual([0, 1]);
  });

  it('span a closed gate across the way it was placed, and swing it open', () => {
    expect(bounds(gateVoxels('n', false))).toEqual({ x: [0, 16], z: [7, 9] });
    expect(bounds(gateVoxels('e', false))).toEqual({ x: [7, 9], z: [0, 16] });
    expect(bounds(gateVoxels('n', true))).toEqual({ x: [0, 2], z: [0, 16] });
  });

  it('join fences to fences, and to gates that continue their line', () => {
    const at = new Map<string, PlacedObject>();
    const put = (o: PlacedObject) => at.set(`${o.x},${o.y},${o.z}`, o);
    put({ kind: 'fence', x: 1, y: 0, z: 0, facing: 'n', open: false });
    put({ kind: 'gate', x: 0, y: 0, z: -1, facing: 'n', open: false }); // spans x: not in line north
    put({ kind: 'gate', x: -1, y: 0, z: 0, facing: 's', open: true }); // spans x: in line west
    put({ kind: 'door', x: 0, y: 0, z: 1, facing: 'n', open: false });
    const joins = fenceJoins(0, 0, 0, (x, y, z) => at.get(`${x},${y},${z}`));
    expect(joins.sort()).toEqual(['e', 'w']);
    // Rails toward east reach the east edge.
    expect(bounds(fenceVoxels(['e'])).x).toEqual([6, 16]);
  });

  it('face the way the player looks', () => {
    expect(facingOfYaw(0)).toBe('n');
    expect(facingOfYaw(-Math.PI / 2)).toBe('e');
    expect(facingOfYaw(Math.PI)).toBe('s');
    expect(facingOfYaw(Math.PI / 2 + 0.3)).toBe('w');
  });
});
